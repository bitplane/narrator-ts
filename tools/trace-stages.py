#!/usr/bin/env python3
"""Watch narrator.device's front half stage by stage, and report what changes.

CMD_WRITE's synthesis path is a straight run of calls at hunk+0x7fe..0x86c,
each handing the next one a workspace rather than a value. Reading 22KB of 68k
to find out which stage owns which byte is the slow way round; this is the
fast one. It snapshots the workspace after every stage and diffs consecutive
snapshots, so each routine is described by exactly the bytes it wrote.

That turns "what does hunk+0x1454 do" from a disassembly problem into a
question with an answer you can check, and it is how the porting order gets
decided: a stage that only ever writes one array can be ported and verified on
its own.

    trace-stages.py -p 'DHIHS IHZ AH TEH4ST'
    trace-stages.py -p AA4 --dump A5+0x2e8:32
"""
import argparse
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

# The return address of each call in the driver, with the routine it followed.
# Order matters: 0x1ee0 and 0x2160 sit in a loop and can be hit repeatedly.
STAGES = [
    (0x0804, 'parse            0xf68'),
    (0x0816, 'after-parse      0x112c'),
    (0x0822, 'table-pass-1     0x12d8 (A6=0x968)'),
    (0x082C, 'unknown          0x11bc'),
    (0x0832, 'unknown          0x1e1c'),
    (0x0838, 'loop-test        0x1ee0'),
    (0x0844, 'loop-body        0x2160'),
    (0x084C, 'unknown          0x1be8'),
    (0x0858, 'table-pass-2     0x12d8 (A6=0xae3)'),
    (0x0862, 'unknown          0x1454'),
    (0x086C, 'unknown          0x19bc'),
    (0x0872, 'frames           0x29d8'),
]

# The workspace runs well past the 0x30c MakeLibrary asked for: three 0x200
# arrays live at A5+0xe8, +0x2e8 and +0x4e8 (later reused as audio buffers).
SPAN = 0xB00

# Arrays worth naming in the report rather than leaving as raw offsets.
NAMED = [
    (0x0E8, 0x200, 'phonemes'),
    (0x2E8, 0x200, 'stress'),
    (0x4E8, 0x200, 'flags'),
    (0x6E8, 0x80, 'arr0'), (0x768, 0x80, 'arr1'), (0x7E8, 0x80, 'arr2'),
    (0x868, 0x80, 'arr3'), (0x8E8, 0x80, 'arr4'), (0x968, 0x80, 'arr5'),
    (0x9E8, 0x80, 'arr6'), (0xA68, 0x80, 'arr7'),
]


def label(off):
    for base, size, name in NAMED:
        if base <= off < base + size:
            return f'{name}[{off - base}]'
    return f'A5+{off:#05x}'


def runs(diff):
    """Collapse changed offsets into contiguous runs, for a readable report."""
    out = []
    for off in sorted(diff):
        if out and off == out[-1][1] + 1:
            out[-1][1] = off
        else:
            out.append([off, off])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phrase', required=True)
    ap.add_argument('-n', '--steps', type=int, default=30_000_000)
    ap.add_argument('--bytes', type=int, default=24,
                    help='how many changed bytes to show per run')
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()
    opts = {k: getattr(args, k) for k in N.DEFAULTS}

    n = Narrator(args.device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    # Stop at the first stage boundary, then step the rest by hand.
    if not capture_frames.run_to(n, args.phrase, h0 + STAGES[0][0], opts):
        raise SystemExit(f'{args.phrase!r}: never reached the parser')

    marks = {h0 + off: name for off, name in STAGES}
    last = h0 + STAGES[-1][0]
    a5 = cpu.get(A5)
    prev = bytes(cpu.read(a5, SPAN))
    print(f'{args.phrase!r}\n  {"parse            0xf68":34} (baseline)')

    for _ in range(args.steps):
        pc = cpu.get(PC)
        name = marks.get(pc)
        if name is not None and pc != h0 + STAGES[0][0]:
            cur = bytes(cpu.read(a5, SPAN))
            changed = [i for i in range(SPAN) if cur[i] != prev[i]]
            print(f'  {name:34} {len(changed):4} bytes')
            for lo, hi in runs(changed):
                span = cur[lo:hi + 1][:args.bytes]
                more = '...' if hi - lo + 1 > args.bytes else ''
                print(f'      {label(lo):16} {hi - lo + 1:4}  {span.hex(" ")}{more}')
            prev = cur
            if pc == last:
                return
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            print('  (device finished early)')
            return
    print('  (step limit)')


if __name__ == '__main__':
    main()
