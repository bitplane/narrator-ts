#!/usr/bin/env python3
"""Capture narrator.device's renderer input, so the port can be checked on it.

The synthesizer splits cleanly in two. The front half turns phonemes into an
array of 8-byte frames; the back half turns those frames into samples. The back
half is the part that has to be sample-exact and is the part that is fully
understood (research/02-narrator.md), so it is worth verifying on its own
rather than waiting for the front half.

This stops the device at the top of its render loop, dumps the frame array, the
two waveform tables and the scalars the loop reads out of A5, and pairs them
with the PCM the same utterance produced. `src/narrator/render.test.ts` then
asks the TypeScript for those samples given those frames.

The frame, at hunk+0x5544 and hunk+0x55d0:

    +0  F1 phase increment        +4  F2 amplitude
    +1  F2 phase increment        +5  F3 amplitude
    +2  F3 phase increment (x2)   +6  voicing descriptor
    +3  F1 amplitude              +7  length in samples

A +0 with bit 7 set ends the array. A +6 of zero is fully voiced; otherwise
bit 7 means "voiced as well", bits 4-6 pick one of eight fricative tables and
bits 0-3 are the noise amplitude.

Output is a build product, like everything else derived by running the binary.

    capture-frames.py -p AA4 -p IY4 -o fixtures/golden/frames.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))

import narrator as N                                          # noqa: E402
from amiga import STACK_TOP                                   # noqa: E402
from m68k import A0, A1, A5, A6, PC                           # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

# The first frame load, after CMD_WRITE has built the array and the tables.
BREAK = 0x5464
# A0 steps 0x40 every `waveStep` samples and only resets on a pitch pulse, so
# the longest pitch period reaches (255/9)*0x40 = 0x700. A1 is indexed by the
# *word* (amplitude<<5 | waveform), and amplitude is a byte, so 0x2000.
WAVE_LEN = 0x1000
AMP_LEN = 0x2000
FRAME = 8
MAX_FRAMES = 4096


def run_to(n, phrase, addr, opts):
    """Start a CMD_WRITE and stop the moment PC reaches `addr`."""
    cpu, m = n.m.cpu, n.m
    raw = phrase.encode('latin-1', 'replace')
    cpu.clear(n.inbuf, N.INBUF)
    cpu.write(n.inbuf, raw + b'\0')
    cpu.w16(n.req + 28, 3)
    cpu.w32(n.req + N.IO_DATA, n.inbuf)
    cpu.w32(n.req + N.IO_LENGTH, len(raw))
    for off, key in ((N.NR_RATE, 'rate'), (N.NR_PITCH, 'pitch'),
                     (N.NR_MODE, 'mode'), (N.NR_SEX, 'sex'),
                     (N.NR_VOLUME, 'volume'), (N.NR_SAMPFREQ, 'sampfreq')):
        cpu.w16(n.req + off, opts[key])
    cpu.w16(n.req + N.NR_NMMASKS, 4)
    cpu.w32(n.req + N.NR_CHMASKS, n.masks)

    m.sched.restore(m.host_task)
    cpu.set(15, STACK_TOP)
    cpu.set(A1, n.req)
    cpu.set(14 + 2, n.execlib.base)          # A6
    cpu.push32(m._ret_magic)
    cpu.set(PC, m.execlib.base - 456)
    m.finished = False
    for _ in range(20_000_000):
        cpu.execute(1)
        if m.sched.switch_pending:
            m.sched.switch_pending = False
            m.sched.switch()
        if cpu.get(PC) == addr:
            return True
        if m.finished:
            return False
    return False


def frames_at(cpu, a6):
    """The 8-byte frames, from A6 (which points at byte 1 of the first)."""
    start = a6 - 1
    out = []
    for i in range(MAX_FRAMES):
        f = list(cpu.read(start + i * FRAME, FRAME))
        out.append(f)
        if f[0] & 0x80:
            break
    return out


def capture(device, phrase, opts):
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    if not run_to(n, phrase, h0 + BREAK, opts):
        raise SystemExit(f'{phrase!r}: never reached the render loop')
    a5, a6 = cpu.get(A5), cpu.get(A6)
    wave, amp = cpu.get(A0), cpu.get(A1)
    rec = {
        'in': phrase,
        'params': dict(opts),
        'frames': frames_at(cpu, a6),
        # A5+0x24 is the pitch-period counter, A5+0x32 the waveform-step
        # reload; both are computed from sampfreq and pitch at hunk+0x53fa.
        'periodCount': cpu.r16(a5 + 0x24),
        'waveStep': cpu.r16(a5 + 0x32),
        'wave': list(cpu.read(wave, WAVE_LEN)),
        'ampTable': list(cpu.read(amp, AMP_LEN)),
        'waveAddr': wave - h0,
        'ampAddr': amp - h0,
        # The eight fricative tables, whose pointers CMD_WRITE writes to
        # A5+0xa2 (hunk+0x52bc). The voicing byte's bits 4-6 pick one.
        'fricatives': [list(cpu.read(cpu.r32(a5 + 0xa2 + 4 * i), 0x1e0))
                       for i in range(8)],
    }
    # And the audio the same utterance actually produces, one channel of it.
    n2 = Narrator(device)
    n2.open()
    r = n2.say(phrase, **opts)
    w = [x for x in r['writes'] if x.channel == r['writes'][0].channel]
    rec['pcm'] = list(b''.join(x.samples for x in w))
    rec['period'] = w[0].period if w else 0
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phrase', action='append', required=True)
    ap.add_argument('-o', '--out', required=True)
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()

    opts = {k: getattr(args, k) for k in N.DEFAULTS}
    out = [capture(args.device, p, opts) for p in args.phrase]
    Path(args.out).write_text(json.dumps(out) + '\n')
    for rec in out:
        voiced = sum(1 for f in rec['frames'] if f[6] == 0)
        print(f'  {rec["in"]!r:10} {len(rec["frames"]):4} frames '
              f'({voiced} voiced), {len(rec["pcm"]):6} samples, '
              f'periodCount {rec["periodCount"]}, waveStep {rec["waveStep"]}')
    print(f'-> {args.out}')


if __name__ == '__main__':
    main()
