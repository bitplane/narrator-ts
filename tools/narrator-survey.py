#!/usr/bin/env python3
"""How many narrator.device synthesizers are there really?

The translator turned out to have two behaviours across seven builds, not
seven. This asks the same question of the narrator, and it has to be asked
before any TypeScript is written: a port that targets "33.2" is only worth
writing once it is known which other builds come along for free.

Two sweeps, because agreeing at default settings is weak evidence:

  full     every phrase of fixtures/corpus/phonemes.txt at the defaults
  params   a subset at each of a grid of parameter settings, including the
           extremes of every range — a build could match at 150 words/minute
           and diverge at 40

Comparison is on the digest of the whole write stream, so it covers the
samples *and* the channel, period, volume and cycle count they were written
with. Two builds count as the same only if audio.device could not tell them
apart.

Each build runs in its own process. That is not for speed: the 68k core is a
process-global singleton, so two Machines cannot be live at once (amiga.py
retires the older one rather than let it answer with the wrong memory).

    narrator-survey.py                       # everything, ~7 minutes
    narrator-survey.py --quick               # subset only, ~1 minute
"""
import argparse
import itertools
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NARRATOR = ROOT / 'tools' / 'oracle' / 'narrator.py'
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))

from amiga import AmigaError            # noqa: E402
from narrator import Narrator           # noqa: E402

# The defaults, then one axis at a time to each end of its documented range.
# Deliberately not a full cross product: this is looking for a build that
# behaves differently *somewhere*, and a difference that only shows up at a
# particular combination of two extremes would be a surprise worth a separate
# hunt rather than something to pay for on every run.
SETTINGS = [
    ('default', {}),
    ('sex1', {'sex': 1}),
    ('mode1', {'mode': 1}),
    ('rate40', {'rate': 40}),
    ('rate400', {'rate': 400}),
    ('pitch65', {'pitch': 65}),
    ('pitch320', {'pitch': 320}),
    ('freq5000', {'sampfreq': 5000}),
    ('freq28000', {'sampfreq': 28000}),
    ('vol0', {'volume': 0}),
    ('vol32', {'volume': 32}),
]


def version_of(path):
    m = re.search(r'-(\d+\.\d+)-', Path(path).name)
    return m.group(1) if m else Path(path).stem


def run(device, corpus, out, params):
    cmd = [sys.executable, str(NARRATOR), '-d', str(device),
           '-f', str(corpus), '-o', str(out)]
    for k, v in params.items():
        cmd += [f'--{k}', str(v)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f'{device} {params}: {r.stderr[-400:]}')
    return out


def load(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l]


def compare(a, b):
    """Differing phrases between two runs of the same corpus."""
    diffs = []
    for x, y in zip(a, b):
        assert x['in'] == y['in'], 'corpora out of step'
        if x['sha'] != y['sha'] or x['err'] != y['err']:
            diffs.append((x['in'], x, y))
    return diffs


def classes(names, differing):
    """Group builds that agree everywhere, by transitive closure."""
    groups = []
    for n in names:
        for g in groups:
            if all(not differing.get(frozenset((n, m))) for m in g):
                g.append(n)
                break
        else:
            groups.append([n])
    return groups


def survey(devices, corpus, settings, outdir, label):
    versions = [version_of(d) for d in devices]
    jobs = [(d, v, name, params)
            for d, v in zip(devices, versions) for name, params in settings]
    outdir.mkdir(parents=True, exist_ok=True)

    def one(job):
        dev, ver, name, params = job
        out = outdir / f'narrator-{label}-{ver}-{name}.jsonl'
        run(dev, corpus, out, params)
        return (ver, name), out

    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        results = dict(pool.map(one, jobs))

    print(f'\n=== {label}: {len(load(next(iter(results.values()))))} phrases '
          f'x {len(settings)} setting(s) x {len(versions)} builds')
    differing = {}
    detail = {}
    for a, b in itertools.combinations(versions, 2):
        total = 0
        for name, _ in settings:
            d = compare(load(results[(a, name)]), load(results[(b, name)]))
            total += len(d)
            if d:
                detail.setdefault(frozenset((a, b)), {})[name] = d
        differing[frozenset((a, b))] = total

    w = max(len(v) for v in versions) + 1
    print(' ' * w + ''.join(f'{v:>8}' for v in versions))
    for a in versions:
        row = ''.join('       -' if a == b else
                      f'{differing[frozenset((a, b))]:8}' for b in versions)
        print(f'{a:<{w}}{row}')

    groups = classes(versions, differing)
    print(f'\ndistinct behaviours: {len(groups)}')
    for g in groups:
        print('  ' + ' == '.join(g))
    return differing, detail, results


OVERREAD_PROBE = 'SHAH4'


def overread(devices):
    """How far past io_Length does each build read?

    Found the hard way. `SAA4FAES` followed by `SHAH4` fails on 1.6 with
    "illegal phoneme" while `SHAH4` alone is fine: the shorter string leaves
    the tail of the longer one in the buffer, and 1.6 reads into it. That made
    the first survey report three engines instead of two, all of it an artefact
    of the order the corpus happened to be in.

    So the sweeps now hand the device a cleared buffer, and the over-read is
    measured here deliberately instead: put a byte that is not a phoneme at a
    known distance past the end and see whether it is noticed.
    """
    print('\n=== reading past io_Length')
    print(f'   probe {OVERREAD_PROBE!r}, io_Length={len(OVERREAD_PROBE)}, '
          f'an invalid byte at +N')
    for dev in devices:
        n = Narrator(dev)
        n.open()
        reach = []
        for off in range(0, 8):
            # `E` is not a phoneme, so noticing it means reading that far.
            # +0 is the first byte past io_Length, where the NUL normally is.
            pad = b'\0' * off + b'E'
            try:
                seen = n.say(OVERREAD_PROBE, max_cycles=20_000_000,
                             trailing=pad)['io_Error'] != 0
            except (AmigaError, RuntimeError):
                seen = True
                n = Narrator(dev)
                n.open()
            if seen:
                reach.append(off)
        past = max(reach) + 1 if reach else 0
        print(f'  {version_of(dev):6} reads {past} byte(s) past the end'
              + (f' (noticed at +{reach})' if reach else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', nargs='+',
                    default=sorted(str(p) for p in
                                   (ROOT / 'fixtures' / 'amiga').glob('narrator_device-*.bin')))
    ap.add_argument('-o', '--outdir', default=ROOT / 'fixtures' / 'golden')
    ap.add_argument('--quick', action='store_true',
                    help='skip the full-corpus sweep')
    ap.add_argument('--examples', type=int, default=6)
    args = ap.parse_args()

    if len(args.device) < 2:
        raise SystemExit('need at least two builds to compare')
    outdir = Path(args.outdir)
    full = ROOT / 'fixtures' / 'corpus' / 'phonemes.txt'
    subset = ROOT / 'fixtures' / 'corpus' / 'phonemes-subset.txt'

    if not args.quick:
        survey(args.device, full, [('default', {})], outdir, 'full')
    _, detail, _ = survey(args.device, subset, SETTINGS, outdir, 'params')
    overread(args.device)

    if detail:
        print('\nwhere the differences are:')
        for pair, by_setting in sorted(detail.items(), key=lambda kv: sorted(kv[0])):
            a, b = sorted(pair)
            counts = ', '.join(f'{k}:{len(v)}' for k, v in by_setting.items())
            print(f'  {a} vs {b} — {counts}')
            first = next(iter(by_setting.values()))
            for phrase, x, y in first[:args.examples]:
                print(f'      {phrase[:34]!r:38} '
                      f'{a}: {x["samples"]:6}sm err={x["err"]}   '
                      f'{b}: {y["samples"]:6}sm err={y["err"]}')


if __name__ == '__main__':
    main()
