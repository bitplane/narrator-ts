#!/usr/bin/env python3
"""Attribute narrator.device's code by watching which of it runs.

Reading 22KB of undocumented synthesis statically is slow and error-prone. It
is much faster to ask the running device: a routine that executes for `AA4` but
not for `AA` is doing something with stress, and one that stops executing when
`mode=1` is part of natural-mode intonation. Static reading then confirms it,
starting from a short list instead of from the whole binary.

The shim counts executions per address (`Cpu.cover`), which is nearly free
because the instruction hook already fires on every instruction. Addresses are
grouped into routines by the nearest preceding `bsr`/`jsr` target, so a routine
here means "code reached through this entry point", and code that only falls
through from above is counted with its predecessor.

    narrator-coverage.py                      # the default probe set
    narrator-coverage.py -p AA4 -p S          # compare two inputs
    narrator-coverage.py --exclusive          # only routines that differ

The columns are execution counts. Equal counts across a column pair mean the
difference between those two inputs is carried in data, not in control flow —
which is a result in itself: rate, pitch, sampfreq and volume change no branch
at all.
"""
import argparse
import bisect
import collections
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))

from narrator import DEFAULT_DEV, Narrator          # noqa: E402

CALL = re.compile(r'^(?:bsr|jsr)\b.*\$([0-9a-f]+)')

# One probe per question. Each is (phonemes, parameter overrides).
PROBES = [
    ('AA', {}), ('S', {}), ('AA4', {}), ('AA AA', {}), ('AA.', {}),
    ('AA', {'sex': 1}), ('AA', {'mode': 1}), ('AA', {'rate': 400}),
    ('AA', {'pitch': 320}), ('AA', {'sampfreq': 5000}), ('AA', {'volume': 0}),
]


def call_targets(cpu, base, end):
    """Every address reached by a bsr or jsr, as routine boundaries."""
    targets, pc = set(), base
    while pc < end:
        text, n = cpu.disasm(pc)
        m = CALL.match(text)
        if m:
            t = int(m.group(1), 16)
            if base <= t < end:
                targets.add(t)
        pc += n or 2
    return sorted(targets)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--probe', action='append',
                    help='a phoneme string; repeatable. Overrides the defaults')
    ap.add_argument('--exclusive', action='store_true',
                    help='hide routines whose counts are the same everywhere')
    args = ap.parse_args()

    probes = [(p, {}) for p in args.probe] if args.probe else PROBES
    n = Narrator(args.device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0, size = n.hunks[0].addr, n.hunks[0].size
    cpu = n.m.cpu
    bounds = call_targets(cpu, h0, h0 + size)
    cpu.cover(h0, h0 + size)

    def routine(addr):
        i = bisect.bisect_right(bounds, addr) - 1
        return bounds[i] if i >= 0 else h0

    results = {}
    for phonemes, params in probes:
        label = phonemes + (' ' + ','.join(f'{k}={v}' for k, v in params.items())
                            if params else '')
        cpu.cover_reset()
        n.say(phonemes, **params)
        per = collections.Counter()
        for addr, count in cpu.coverage().items():
            per[routine(addr)] += count
        results[label] = per

    labels = list(results)
    rows = sorted(set().union(*(set(v) for v in results.values())))
    if args.exclusive:
        rows = [r for r in rows
                if len({results[l].get(r, 0) for l in labels}) > 1]

    print(f'{len(bounds)} routines found, {len(rows)} shown\n')
    for i, l in enumerate(labels):
        print(f'  {i}: {l}')
    print()
    print(f"{'routine':>12} " + ''.join(f'{i:>8}' for i in range(len(labels))))
    for r in rows:
        cells = ''.join(f'{results[l].get(r, 0):8}' for l in labels)
        print(f'hunk+{r - h0:#07x} {cells}')


if __name__ == '__main__':
    main()
