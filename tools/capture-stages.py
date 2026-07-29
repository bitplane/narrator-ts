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
#   0x1970  first, and the likeliest home of the main duration assignment
#   0x1492  gives the continuation slots rewrite pass 2 created their own
#           durations from hunk+0x3806, inheriting the previous stress
#   0x1586, 0x15e0, 0x1472, 0x172a, 0x17d6  not yet read
SUBSTAGES = [
    (0x1458, 'dur/0x1970'),
    (0x145C, 'dur/0x1492'),
    (0x1460, 'dur/0x1586'),
    (0x1464, 'dur/0x15e0'),
    (0x1466, 'dur/0x1472'),
    (0x146A, 'dur/0x172a'),
    (0x146E, 'dur/0x17d6'),
]

PHONEMES, STRESS, FLAGS, COUNT = 0x0E8, 0x2E8, 0x4E8, 0x9A

# hunk+0x1e1c points nine registers at eight 0x80-byte arrays running from
# A5+0x6e8 to A5+0xa68. Eight of them, and the frame is eight bytes wide --
# the front half builds one array per frame field and 0x29d8 interleaves them.
PARAMS = [0x6E8, 0x768, 0x7E8, 0x868, 0x8E8, 0x968, 0x9E8, 0xA68]
PARAM_LEN = 0x80
# The scalars and array pointers the stages hand each other, A5+0x20..0xb0.
SCALARS = (0x20, 0x90)


def capture(device, phrase, opts, steps, sub=False):
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    if not capture_frames.run_to(n, phrase, h0 + STAGES[0][0], opts):
        return {'in': phrase, 'ok': False}

    marks = {h0 + off: name for off, name in STAGES + (SUBSTAGES if sub else [])}
    last = h0 + STAGES[-1][0]
    a5 = cpu.get(A5)
    out = []

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
        })

    snap('parse')
    for _ in range(steps):
        pc = cpu.get(PC)
        name = marks.get(pc)
        if name is not None and pc != h0 + STAGES[0][0]:
            snap(name)
            if pc == last:
                return {'in': phrase, 'ok': True, 'stages': out}
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            return {'in': phrase, 'ok': False, 'stages': out}
    return {'in': phrase, 'ok': False, 'stages': out}


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
