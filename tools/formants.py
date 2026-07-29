#!/usr/bin/env python3
"""Read a voice's formant tables in Hz, and diff them against published data.

The frame holds phase increments, not frequencies. The renderer advances a
10-bit accumulator by the increment and emits *two* samples per advance
(hunk+0x54c0), so

    F1 = increment x sampfreq / 2048
    F2 = increment x sampfreq / 2048
    F3 = increment x sampfreq / 1024      (hunk+0x5558 doubles it)

which makes every table entry readable as a frequency, and any frequency
writable as a table entry. That is the whole basis of building a voice: pick
the Hz from the literature, divide, round.

    formants.py                       # the extracted voice, in Hz
    formants.py --diff                # beside reference/formants.json
    formants.py --hz 270 2290 3010    # what those would be stored as

Reading a voice needs data/narrator-*.json (tools/gen-voice.py). The --hz
direction needs nothing.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# hunk+0x52e2 divides this by sampfreq to get the Paula period; PAL Paula's
# clock divided by that period is the rate the samples are actually played at.
PERIOD_NUMERATOR = 0x369C78
PAL_CLOCK = 3546895

# Two output samples per phase advance, and a 10-bit accumulator.
DIVISOR = 2048


def rate(sampfreq):
    return PAL_CLOCK / (PERIOD_NUMERATOR // sampfreq)


def to_hz(increment, sampfreq, third=False):
    return increment * rate(sampfreq) / (DIVISOR // (2 if third else 1))


def to_increment(hz, sampfreq, third=False):
    return round(hz * (DIVISOR // (2 if third else 1)) / rate(sampfreq))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-v', '--voice', default='data/narrator-33.2.json')
    ap.add_argument('--sampfreq', type=int, default=22200)
    ap.add_argument('--diff', action='store_true',
                    help='compare against reference/formants.json')
    ap.add_argument('--hz', nargs=3, type=float, metavar=('F1', 'F2', 'F3'),
                    help='convert a frequency triple to table entries')
    args = ap.parse_args()

    sf = args.sampfreq
    if args.hz:
        f1, f2, f3 = args.hz
        print(f'  F1 {f1:7.0f} Hz -> {to_increment(f1, sf):3}')
        print(f'  F2 {f2:7.0f} Hz -> {to_increment(f2, sf):3}')
        print(f'  F3 {f3:7.0f} Hz -> {to_increment(f3, sf, True):3}')
        return

    path = Path(args.voice)
    if not path.exists():
        raise SystemExit(f'{path} is missing; run tools/gen-voice.py')
    d = json.loads(path.read_text())
    names, P = d['names'], d['params']

    if not args.diff:
        print(f'  {"":6} {"F1":>18} {"F2":>18} {"F3":>18}')
        for i, n in enumerate(names):
            if not n or i >= len(P['f1']):
                continue
            if not (P['f1'][i] or P['f2'][i] or P['f3'][i]):
                continue
            print(f'  {n:6} '
                  f'{P["f1"][i]:4} = {to_hz(P["f1"][i], sf):6.0f} Hz  '
                  f'{P["f2"][i]:4} = {to_hz(P["f2"][i], sf):6.0f} Hz  '
                  f'{P["f3"][i]:4} = {to_hz(P["f3"][i], sf, True):6.0f} Hz')
        return

    ref = json.loads((ROOT / 'reference' / 'formants.json').read_text())
    print(f'  {ref["source"]}\n')
    print(f'  {"":5} {"F1  amiga / pub":>20} {"F2  amiga / pub":>20} '
          f'{"F3  amiga / pub":>20}')
    worst = []
    for n, want in ref['vowels'].items():
        if n not in names:
            continue
        i = names.index(n)
        got = (to_hz(P['f1'][i], sf), to_hz(P['f2'][i], sf),
               to_hz(P['f3'][i], sf, True))
        cells = []
        for g, w in zip(got, want):
            pct = 100 * (g - w) / w
            worst.append((abs(pct), n))
            cells.append(f'{g:6.0f} /{w:5}  {pct:+5.1f}%')
        print(f'  {n:5} ' + ' '.join(cells))
    worst.sort(reverse=True)
    inside = sum(1 for p, _ in worst if p <= 10)
    print(f'\n  {inside}/{len(worst)} within 10%; '
          f'largest divergence {worst[0][0]:.0f}% on {worst[0][1]}')


if __name__ == '__main__':
    main()
