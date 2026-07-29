#!/usr/bin/env python3
"""Count how often the device reaches each decision point in a routine.

A port that matches the fixtures proves nothing about a branch the fixtures
never take -- the stress spreader passed 27 of 30 captures with a real bug in
it, because only multi-syllable words went down the affected path. So before
believing a stage is done, ask the device which paths the corpus actually
drives, and go and write corpus entries for the ones that read zero.

Addresses are hunk offsets, named on the command line or in ROUTINES below.

    branch-coverage.py -r durations -f fixtures/corpus/frames.txt
    branch-coverage.py -a 0x1c34=terminal -a 0x1c48=phrase-end -p '/HEH4LOW'
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))
sys.path.insert(0, str(ROOT / 'tools'))

import narrator as N                                          # noqa: E402
from m68k import PC                                           # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

from importlib import import_module                           # noqa: E402
capture_frames = import_module('capture-frames')
capture_parse = import_module('capture-parse')

# Every point in hunk+0x1be8 where the duration scale is multiplied, or the
# stored value is adjusted. The names are the ones in src/narrator/duration.ts.
DURATIONS = [
    (0x1C34, 'terminal 24 flat'),
    (0x1C48, 'phrase-end x45'),
    (0x1C60, 'liquid/nasal before pause x45'),
    (0x1C74, 'vowel not the nucleus x27'),
    (0x1C80, 'inside a spread x26'),
    (0x1C8C, 'unstressed x22'),
    (0x1CB0, 'stressed vowel before pause x38'),
    (0x1CC8, 'vowel before voiced fricative x38'),
    (0x1CD8, 'vowel before voiced stop x38'),
    (0x1CF2, 'vowel before unstressed nasal x27'),
    (0x1D02, 'vowel before voiceless stop x22'),
    (0x1D1A, 'consonant not after a pause x27'),
    (0x1D40, 'liquid/glide before a vowel x3'),
    (0x1D76, 'vowel before a vowel x38'),
    (0x1D82, 'vowel after a vowel x22'),
    (0x1D96, 'consonant in a cluster both sides x16'),
    (0x1DA4, 'consonant in a cluster one side x22'),
    (0x1DD4, 'halve the unstressed floor'),
    (0x1DFA, 'stressed vowel after a voiceless stop +3'),
    (0x1E04, 'clamp to 0x3f'),
]

ROUTINES = {'durations': DURATIONS}


def run(device, phrase, opts, marks, steps, counts):
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    # Getting to the parser proves the phrase is legal and puts us on the
    # synthesis path; from there step and watch.
    if not capture_frames.run_to(n, phrase, h0 + 0x804, opts):
        return False
    watch = {h0 + off: name for off, name in marks}
    for _ in range(steps):
        name = watch.get(cpu.get(PC))
        if name is not None:
            counts[name] += 1
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            return True
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-r', '--routine', choices=sorted(ROUTINES))
    ap.add_argument('-a', '--at', action='append', default=[],
                    help='extra point as offset=name, e.g. 0x1c34=terminal')
    ap.add_argument('-p', '--phrase', action='append', default=[])
    ap.add_argument('-f', '--file', action='append', default=[])
    ap.add_argument('-n', '--steps', type=int, default=30_000_000)
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()

    marks = list(ROUTINES.get(args.routine, []))
    for spec in args.at:
        off, _, name = spec.partition('=')
        marks.append((int(off, 0), name or off))
    if not marks:
        ap.error('nothing to watch: pass -r or -a')

    phrases = list(args.phrase)
    for path in args.file:
        phrases += capture_parse.read_corpus(Path(path))
    if not phrases:
        ap.error('nothing to run: pass -p or -f')

    opts = {k: getattr(args, k) for k in N.DEFAULTS}
    counts = Counter({name: 0 for _, name in marks})
    for p in phrases:
        run(args.device, p, opts, marks, args.steps, counts)

    width = max(len(name) for _, name in marks)
    cold = 0
    for _, name in marks:
        n = counts[name]
        cold += n == 0
        print(f'  {name:{width}}  {n:5}{"   <- never taken" if not n else ""}')
    print(f'{len(marks) - cold}/{len(marks)} reached over {len(phrases)} phrases')


if __name__ == '__main__':
    main()
