#!/usr/bin/env python3
"""Build the phoneme corpus narrator.device is measured on.

The translator's corpus is English text; this one is what comes out the other
side, so it is built from the device's own inventory rather than from a word
list. Five parts, each aimed at something a synthesizer can get wrong:

  singles      every phoneme alone — does it exist, and how long is it
  stress       every vowel at every stress level, 1-9
  pairs        every ordered phoneme pair. This is the bulk of it, because
               coarticulation is where a formant synthesizer actually lives:
               a transition is not a property of either phoneme on its own
  words        real translator output, so the common transitions are weighted
               the way English weights them and not uniformly
  prosody      punctuation and multi-word strings, which drive intonation

The inventory comes from `probe-phonemes.py`, which asks the device rather
than reading its table, and the union across builds is used so that a phoneme
only one engine knows still gets probed on both. `LX`, `NH` and `RX` are left
out: alone they crash 1.6 through 36.9 outright, so including them would
measure the crash and nothing else. They appear inside pairs, where they are
harmless.

Usage:
    make-narrator-corpus.py -o fixtures/corpus/phonemes.txt
    make-narrator-corpus.py --subset 300 -o fixtures/corpus/phonemes-subset.txt
"""
import argparse
import json
import random
import re
import subprocess
import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))

# Seeded so the corpus is a build product, not a lottery: two people running
# this get the same file.
SEED = 20260729

# Alone these send 1.6-36.9 to address zero. See research/02-narrator.md.
CRASHERS = {'LX', 'NH', 'RX'}

# Stress digits are only meaningful on a vowel, and the device's vowels are
# exactly the phonemes it will accept a digit after — which is itself worth
# checking, so this is a claim the corpus tests rather than assumes.
VOWELISH = re.compile(r'^(AA|AE|AH|AO|AW|AX|AY|EH|ER|EY|IH|IX|IY|OH|OW|OY'
                      r'|UH|UW|UX|IL|IM|IN|UL|UM|UN)$')

# `/H` is one phoneme: a bare `HEH4LOW` starts with an `H` the device does not
# have, and is rejected with -20.
PROSODY = [
    '/HEH4LOW WER4LD.', '/HEH4LOW WER4LD?', '/HEH4LOW, WER4LD.',
    '/HEH4LOW WER4LD -', 'DHIHS IHZ WAH4N. DHIHS IHZ TUW4.',
    'IHZ DHIHS AH KWEH4SCHAXN?', 'YEH4S. NOW4. MEY4BIY.',
    'WAH4N TUW4 THRIY4 FOH4R FAY4V.', 'AA4 EH4 IY4 OW4 UW4',
    'AA1 AA2 AA3 AA4 AA5 AA6 AA7 AA8 AA9',
]


def inventory(devices):
    """The union of every build's phoneme set, via probe-phonemes.py."""
    with tempfile.NamedTemporaryFile(suffix='.json') as tmp:
        subprocess.run(
            [sys.executable, str(ROOT / 'tools' / 'probe-phonemes.py'),
             '-d', *devices, '--json', tmp.name],
            capture_output=True, text=True, check=True)
        data = json.loads(Path(tmp.name).read_text())
    phonemes = sorted(set().union(*(set(v['phonemes']) for v in data.values())))
    return phonemes, data


def words(limit):
    """Real phoneme strings, by running the corpus through translator.library."""
    src = ROOT / 'fixtures' / 'corpus' / 'phrases.txt'
    if not src.exists():
        return []
    from translate import Translator
    t = Translator()
    lines = [l for l in src.read_text(encoding='latin-1').splitlines() if l.strip()]
    rng = random.Random(SEED)
    rng.shuffle(lines)
    out = []
    for line in lines:
        if len(out) >= limit:
            break
        phon, rc = t.translate(line)
        phon = phon.strip()
        if rc == 0 and phon:
            out.append(phon)
    return out


def build(phonemes, n_words):
    safe = [p for p in phonemes if p not in CRASHERS]
    singles = list(safe)
    stress = [f'{p}{d}' for p in safe if VOWELISH.match(p) for d in '123456789']
    # Pairs use the full inventory: a crasher is only fatal on its own.
    pairs = [a + b for a in phonemes for b in phonemes]
    return {'singles': singles, 'stress': stress, 'pairs': pairs,
            'words': words(n_words), 'prosody': PROSODY}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='fixtures/corpus/phonemes.txt')
    ap.add_argument('-d', '--device', nargs='+',
                    default=sorted(str(p) for p in
                                   (ROOT / 'fixtures' / 'amiga').glob('narrator_device-*.bin')))
    ap.add_argument('--words', type=int, default=600)
    ap.add_argument('--subset', type=int,
                    help='sample this many, spread across every section')
    args = ap.parse_args()

    if not args.device:
        raise SystemExit('no narrator.device binaries; see README')
    phonemes, per_build = inventory(args.device)
    parts = build(phonemes, args.words)

    if args.subset:
        rng = random.Random(SEED)
        # Proportional, but never dropping a section entirely: the parameter
        # sweep runs on this and every kind of input has to survive into it.
        total = sum(len(v) for v in parts.values())
        for name, items in parts.items():
            k = max(1, round(args.subset * len(items) / total))
            parts[name] = sorted(rng.sample(items, min(k, len(items))))

    lines = []
    for name in ('singles', 'stress', 'pairs', 'words', 'prosody'):
        lines.extend(parts[name])
    Path(args.out).write_text('\n'.join(lines) + '\n')

    print(f'{len(phonemes)} phonemes across {len(per_build)} builds')
    for name in ('singles', 'stress', 'pairs', 'words', 'prosody'):
        print(f'  {name:9} {len(parts[name]):6}')
    print(f'  {"total":9} {len(lines):6} -> {args.out}')


if __name__ == '__main__':
    main()
