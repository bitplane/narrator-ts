#!/usr/bin/env python3
"""Single-step narrator.device's render loop, logging pulses and frame starts.

The renderer is checked against captured frames, and when the port and the
device disagree the useful question is *which counter* went out of step, not
which sample. This answers that directly: it reports the output index at every
pitch pulse (hunk+0x55b6) and every frame decode (hunk+0x5544), so the two
timelines can be laid side by side.

Single-stepping is slow, so pass a short phrase.

    trace-render.py -p J | head -60
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))

import narrator as N                                          # noqa: E402
from m68k import A5, A6, PC                                   # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

sys.path.insert(0, str(ROOT / 'tools'))
from importlib import import_module                           # noqa: E402

capture_frames = import_module('capture-frames')

# Offsets in the render loop worth knowing about.
PULSE = 0x55B6      # the pitch pulse: reloads amplitudes, restarts the waveform
DECODE = 0x5544     # the top of a frame
VOICED = 0x54C0     # writes two samples
UNV1 = 0x5648       # writes one
UNV2 = 0x565A       # writes one
DONE = 0x56EA       # the end marker was seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phrase', required=True)
    ap.add_argument('-n', '--steps', type=int, default=4_000_000)
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()
    opts = {k: getattr(args, k) for k in N.DEFAULTS}

    n = Narrator(args.device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    if not capture_frames.run_to(n, args.phrase, h0 + capture_frames.BREAK, opts):
        raise SystemExit(f'{args.phrase!r}: never reached the render loop')

    marks = {h0 + PULSE: 'pulse', h0 + DECODE: 'frame', h0 + VOICED: 2,
             h0 + UNV1: 1, h0 + UNV2: 1, h0 + DONE: 'done'}
    out, frame = 0, -1
    for _ in range(args.steps):
        pc = cpu.get(PC)
        what = marks.get(pc)
        if what == 2 or what == 1:
            out += what
        elif what == 'frame':
            frame += 1
            a5 = cpu.get(A5)
            f = cpu.read(cpu.get(A6), 8)
            print(f'frame {frame:3} @{out:6}  f1={f[0]:3} v={f[6]:02x} '
                  f'p={f[7]:3}  d0={cpu.get(0):08x}')
        elif what == 'pulse':
            a6 = cpu.get(A6)
            amps = cpu.read(a6 - 5, 3)
            print(f'  pulse   @{out:6}  a1={amps[0]:3} a2={amps[1]:3} '
                  f'a3={amps[2]:3}  d0={cpu.get(0):08x}')
        elif what == 'done':
            print(f'  done    @{out:6}')
            return
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            return
    print('  (step limit)')


if __name__ == '__main__':
    main()
