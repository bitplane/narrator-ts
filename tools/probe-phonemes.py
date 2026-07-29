#!/usr/bin/env python3
"""Discover a narrator.device build's phoneme inventory by asking it.

The device carries a phoneme table — 33.2's is at hunk+0xe9e, reading
`IYIHEHAEAAAHAOUHAXIXERUXQXOHRXLXEY...` — but its stride is irregular and
decoding it is a guess until the synthesis pipeline is understood. The
inventory itself does not need that: every candidate spelling can simply be
spoken, and the device says whether it knows it.

So this tries all of `A`-`Z`, `AA`-`ZZ` and `/A`-`/Z`, and sorts them by what
came back. Exhaustive rather than derived from the table, so nothing depends on
having read the table correctly, and nothing depends on my memory of the manual.

Three outcomes, and the third is the interesting one:

  accepted   spoken, io_Error 0, samples produced
  rejected   io_Error -20, the device's "illegal phoneme"
  crashed    never returned — 1.6 through 36.9 jump to address zero on a lone
             LX, NH or RX. A real bug in the device, reproduced not hidden.

Usage: probe-phonemes.py [-d fixtures/amiga/narrator_device-*.bin] [--json out]
"""
import argparse
import json
import re
import string
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / 'oracle'))

from narrator import DEFAULT_DEV, Narrator, run_corpus     # noqa: E402

# A lone phoneme is a fraction of a second; anything still running after this
# is not going to stop. Small, because a crash costs a whole bring-up.
CRASH_CYCLES = 4_000_000


def candidates():
    """Every one- and two-letter spelling, plus the `/X` forms."""
    out = list(string.ascii_uppercase)
    out += [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]
    out += ['/' + a for a in string.ascii_uppercase]
    return out


def probe(device):
    accepted, rejected, crashed = {}, [], []
    for rec in run_corpus(device, candidates(), max_cycles=CRASH_CYCLES):
        if rec['sha'] == 'crash':
            crashed.append(rec['in'])
        elif rec['err'] == 0 and rec['writes']:
            accepted[rec['in']] = rec['samples'] // 2
        else:
            rejected.append(rec['in'])
    return accepted, rejected, crashed


def atomic(accepted):
    """The phonemes proper: accepted tokens that are not just two others.

    Acceptance alone over-counts badly. `BB` is spoken happily because it is
    `B` then `B`, not because the device has a BB phoneme — 33.2 "accepts" 385
    of 728 candidates on that basis. The inventory is the minimal set that
    generates the rest, so a two-letter token counts only when it cannot be
    split into two accepted singles.

    That is decisive here because the letters A C E H I O U X are not phonemes
    on their own, so everything real — AA, CH, NX, /H, UW — has at least one
    half that cannot stand alone.
    """
    singles = {p for p in accepted if len(p) == 1}
    return sorted(p for p in accepted
                  if len(p) == 1 or not (p[0] in singles and p[1] in singles))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', nargs='+', default=[DEFAULT_DEV])
    ap.add_argument('--json', help='write the inventories here')
    args = ap.parse_args()

    out = {}
    for dev in args.device:
        m = re.search(r'-(\d+\.\d+)-', Path(dev).name)
        version = m.group(1) if m else Path(dev).stem
        accepted, rejected, crashed = probe(dev)
        phonemes = atomic(accepted)
        out[version] = {'phonemes': phonemes, 'crashed': sorted(crashed),
                        'accepted': len(accepted), 'samples': accepted}
        print(f'{version:6} {len(phonemes)} phonemes '
              f'({len(accepted)} tokens accepted, the rest are sequences), '
              f'{len(crashed)} crashed'
              + (f': {" ".join(sorted(crashed))}' if crashed else ''))
        print('       ' + ' '.join(phonemes))

    if len(out) > 1:
        print('\ndifferences between builds:')
        allp = sorted(set().union(*(set(v['phonemes']) for v in out.values())))
        for p in allp:
            has = [v for v, d in out.items() if p in d['phonemes']]
            if len(has) != len(out):
                print(f'  {p:3} only in {", ".join(has)}')
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=1) + '\n')
        print(f'\nwrote {args.json}', file=sys.stderr)


if __name__ == '__main__':
    main()
