#!/usr/bin/env python3
"""Capture the phoneme/stress/flag arrays at every front-half stage boundary.

CMD_WRITE's synthesis path is a run of calls at hunk+0x7fe..0x86c, each
handing the next a workspace. This records the three parallel arrays after
each of them, so a stage can be ported and checked on its own instead of only
at the far end -- which is the whole reason the renderer went quickly and
would not have if the only oracle were the audio.

`tools/trace-stages.py` is the same idea for exploring; this is the machine
-readable version the test suite consumes.

    capture-stages.py -f fixtures/corpus/frames.txt -o fixtures/golden/stages.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))
sys.path.insert(0, str(ROOT / 'tools'))

import narrator as N                                          # noqa: E402
from m68k import A5, PC                                       # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

from importlib import import_module                           # noqa: E402
capture_frames = import_module('capture-frames')
capture_parse = import_module('capture-parse')

# Return address -> the routine that just ran. Names match research/02.
STAGES = [
    (0x0804, 'parse'),          # 0xf68
    (0x0816, 'after-parse'),    # 0x112c
    (0x0822, 'rewrite-1'),      # 0x12d8, rules at 0x968
    (0x082C, 'stress-decode'),  # 0x11bc
    (0x0832, 'pitch-setup'),    # 0x1e1c
    (0x0838, 'loop-test'),      # 0x1ee0
    (0x0844, 'loop-body'),      # 0x2160
    (0x084C, 'pre-rewrite-2'),  # 0x1be8
    (0x0858, 'rewrite-2'),      # 0x12d8, rules at 0xae3
    (0x0862, 'durations'),      # 0x1454
    (0x086C, 'contour'),        # 0x19bc
    (0x0872, 'frames'),         # 0x29d8
]

# hunk+0x1454 is itself a driver of seven sub-routines, so the same trick
# works one level down: these are the return addresses inside it, and
# capturing them lets each be ported and checked on its own rather than only
# at the far end of all seven.
#
#   0x1970  drops the phonemes that are not spoken, attribute bit 20
#   0x1492  gives the continuation slots rewrite pass 2 created their own
#           durations from hunk+0x3806, inheriting the previous stress
#   0x1586  totals the durations and allocates the frame array
#   0x15e0  writes formants and voicing into every frame
#   0x1472  clears the pitch bytes and marks frame 0
#   0x172a, 0x17d6  coarticulation, not yet read
SUBSTAGES = [
    (0x1458, 'dur/0x1970'),
    (0x145C, 'dur/0x1492'),
    (0x1460, 'dur/0x1586'),
    (0x1464, 'dur/0x15e0'),
    (0x1466, 'dur/0x1472'),
    (0x146A, 'dur/0x172a'),
    (0x146E, 'dur/0x17d6'),
    # hunk+0x19bc is two calls in a row: the contour codes, then the pitch
    # and period pass that reads them.
    (0x19BE, 'contour/0x19c4'),
    (0x19C2, 'contour/0x1a8e'),
    # hunk+0x29d8 is a driver too, of eight sub-routines over the frame array.
    # The first four are the same routine run on one byte column each.
    (0x29F0, 'frames/fill-f1'),      # 0x2aba on byte 0
    (0x29FA, 'frames/fill-f2'),      # 0x2aba on byte 1
    (0x2A04, 'frames/fill-f3'),      # 0x2aba on byte 2
    (0x2A0E, 'frames/fill-pitch'),   # 0x2aba on byte 7
    (0x2A18, 'frames/0x2d54-f2'),
    (0x2A22, 'frames/0x2d86-f3'),
    (0x2A26, 'frames/0x2dca'),
    (0x2A30, 'frames/0x2d54-pitch'),
    (0x2A34, 'frames/0x2bc6'),
    (0x2A36, 'frames/fill-amplitudes'),   # 0x2a4a -> 0x2a92 on bytes 3, 4, 5
    (0x2A3A, 'frames/0x2d1c'),
    (0x2A3E, 'frames/0x2ae0'),
    (0x2A48, 'frames/0x2e80-mouth'),
]

PHONEMES, STRESS, FLAGS, COUNT = 0x0E8, 0x2E8, 0x4E8, 0x9A

# hunk+0x1e1c points nine registers at eight 0x80-byte arrays running from
# A5+0x6e8 to A5+0xa68. Eight of them, and the frame is eight bytes wide --
# the front half builds one array per frame field and 0x29d8 interleaves them.
PARAMS = [0x6E8, 0x768, 0x7E8, 0x868, 0x8E8, 0x968, 0x9E8, 0xA68]
PARAM_LEN = 0x80
# The scalars and array pointers the stages hand each other. Starts at 0x10
# because hunk+0x1a8e reads A5+0x1c, the divisor it turns into the period
# constant at A5+0x20.
SCALARS = (0x10, 0xA0)

# hunk+0x1586 sums the durations into A5+0x3a, allocates 8 bytes per frame
# plus one spare at A5+0x28, and the three sub-routines after it fill that
# array in. It is the stage's real output and lives in allocated memory rather
# than the workspace, so the diff tracer cannot see it -- record it here.
FRAME_PTR, FRAME_TOTAL, FRAME = 0x28, 0x3A, 8
MAX_FRAMES = 4096


def capture(device, phrase, opts, steps, sub=False):
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    if not capture_frames.run_to(n, phrase, h0 + STAGES[0][0], opts):
        return {'in': phrase, 'opts': opts, 'ok': False}

    marks = {h0 + off: name for off, name in STAGES + (SUBSTAGES if sub else [])}
    last = h0 + STAGES[-1][0]
    a5 = cpu.get(A5)
    out = []

    def frames():
        """The frame array, once hunk+0x1586 has allocated one."""
        ptr = cpu.r32(a5 + FRAME_PTR)
        total = cpu.r32(a5 + FRAME_TOTAL)
        if not ptr or not 0 < total <= MAX_FRAMES:
            return None
        raw = cpu.read(ptr, (total + 1) * FRAME)
        return [list(raw[i * FRAME:(i + 1) * FRAME]) for i in range(total + 1)]

    def snap(name):
        count = cpu.r16(a5 + COUNT)
        take = min(max(count, 0) + 1, 0x200)
        out.append({
            'stage': name,
            'count': count,
            'phonemes': list(cpu.read(a5 + PHONEMES, take)),
            'stress': list(cpu.read(a5 + STRESS, take)),
            'flags': list(cpu.read(a5 + FLAGS, take)),
            'params': [list(cpu.read(a5 + b, PARAM_LEN)) for b in PARAMS],
            'scalars': list(cpu.read(a5 + SCALARS[0], SCALARS[1])),
            'frames': frames(),
        })

    snap('parse')
    for _ in range(steps):
        pc = cpu.get(PC)
        name = marks.get(pc)
        if name is not None and pc != h0 + STAGES[0][0]:
            snap(name)
            if pc == last:
                return {'in': phrase, 'opts': opts, 'ok': True, 'stages': out}
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            return {'in': phrase, 'opts': opts, 'ok': False, 'stages': out}
    return {'in': phrase, 'opts': opts, 'ok': False, 'stages': out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phrase', action='append', default=[])
    ap.add_argument('-f', '--file', action='append', default=[])
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('-n', '--steps', type=int, default=30_000_000)
    ap.add_argument('--sub', action='store_true',
                    help="also break inside hunk+0x1454's seven sub-routines")
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()

    phrases = list(args.phrase)
    for path in args.file:
        phrases += capture_parse.read_corpus(Path(path))
    if not phrases:
        ap.error('nothing to capture: pass -p or -f')

    opts = {k: getattr(args, k) for k in N.DEFAULTS}
    out = [capture(args.device, p, opts, args.steps, args.sub) for p in phrases]
    Path(args.out).write_text(json.dumps(out) + '\n')
    for r in out:
        got = len(r.get('stages', []))
        print(f'  {r["in"]!r:32} {got:2}/{len(STAGES)} stages'
              f'{"" if r["ok"] else "  (incomplete)"}')
    print(f'-> {args.out}')


if __name__ == '__main__':
    main()
