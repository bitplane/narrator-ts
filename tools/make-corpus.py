#!/usr/bin/env python3
"""Build the phrase corpus the translator is measured against.

The goal is coverage that cannot be satisfied by accident, plus a large body of
input nobody designed around:

  letters     every character the normaliser can be handed, alone and in
              context — the punctuation and digit paths word lists never reach
  rules       one probe per rule, generated from every rule table we have, so
              no rule can be silently unimplemented. Probes are derived from
              the *binaries*, not from anything the implementation does, and
              cover every version's table so a rule that exists only in 1.3 or
              only in 37.1 still gets exercised
  edge        hand-picked contexts: silent E, -ED, -ION, digraphs, the
              abbreviations the table expands
  dictionary  a deterministic stride through /usr/share/dict/words — natural
              input that was not chosen to make anything pass

Writes one phrase per line. The output is our own text, so it is checked in;
the phoneme transcriptions derived from it are not.
"""
import argparse
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'extract_rules', Path(__file__).with_name('extract-rules.py'))
extract_rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(extract_rules)

LETTERS = (
    [chr(c) for c in range(ord('a'), ord('z') + 1)] +
    [chr(c) for c in range(ord('A'), ord('Z') + 1)] +
    [str(d) for d in range(10)] +
    [chr(c) for c in range(0x20, 0x7F)] +          # every printable input
    ['\t', '\x01', '\x7f'] +                        # control chars -> space
    ['0', '00', '007', '10', '19', '100', '1000', '12345', '3.14', '-5',
     '1st', '2nd', '1,000', '$5.00', '50%']
)

EDGE = [
    'mat mate', 'bit bite', 'hop hope', 'cut cute', 'rid ride',
    'walked', 'played', 'wanted', 'jumped', 'needed', 'loved',
    'nation', 'mission', 'vision', 'musician', 'question', 'suggestion',
    'church', 'chemist', 'machine', 'ghost', 'though', 'through', 'cough',
    'laugh', 'photo', 'phone', 'knight', 'gnome', 'wrist', 'psalm',
    'cat cell cycle', 'go gem gym', 'garage', 'suggest',
    # the classic NRL failures — a faithful port must fail here too
    'versatile', 'photography', 'colonel', 'yacht', 'choir', 'one once',
    'Dr. Mr. Mrs. Ms. St. Ave. Blvd. etc. vs. Jr. Sr.',
    'a an and as at am are', 'the the end', 'aaa bbb zzz',
    'hello  world', ' leading', 'trailing ', '',
    'x1', '3d', 'mp3', 'level42',
    # doubled letters, which some rules silence
    'uu vv ll ss ee oo tt', 'vacuum', 'skiing',
    'Amiga', 'Commodore', 'Workbench', 'Kickstart',
    'narrator device', 'translator library', 'phoneme', 'synthesizer',
]

# Wildcards, from the class table's companion string. A probe has to satisfy
# them for the rule to fire at all.
WILDCARD_FILL = {
    '#': 'A',      # one or more vowels
    '*': 'B',      # one or more consonants
    '.': 'D',      # a voiced consonant
    '$': 'BE',     # one consonant plus E or I
    '%': 'ER',     # a suffix
    '&': 'S',      # a sibilant
    '@': 'T',      # a consonant that changes a following long U
    '^': 'B',      # exactly one consonant
    '+': 'E',      # a front vowel
    ':': '',       # zero or more consonants
    '?': '',
    '_': '',
}


def probes_for(rule):
    """Build inputs that reach this rule, in the positions it can match."""
    def fill(pattern):
        return ''.join(WILDCARD_FILL.get(c, c) for c in pattern)

    left, match, right = fill(rule['left']), rule['match'], fill(rule['right'])
    if not match:
        return []
    core = f'{left}{match}{right}'.strip()
    if not core:
        return []
    out = [core]
    # The same letters word-initially, medially and finally, because the class
    # of a character depends on its neighbours and a bare probe only tests one
    # of the three.
    if left.strip() == '' and right.strip() == '':
        out += [f'{match} ', f' {match}', f'A{match}A']
    return out


def rule_probes(binaries):
    seen = {}
    for path in binaries:
        try:
            table = extract_rules.RuleTable(path)
        except ValueError as exc:
            print(f'  skipped {Path(path).name}: {exc}')
            continue
        n = 0
        for bucket in table.buckets:
            for rule in bucket:
                for p in probes_for(rule):
                    if p not in seen:
                        seen[p] = None
                        n += 1
        print(f'  {Path(path).name}: +{n}')
    return list(seen)


def dictionary(n, path='/usr/share/dict/words'):
    p = Path(path)
    if not p.exists():
        return []
    words = [w.strip() for w in p.read_text(encoding='latin-1', errors='ignore').splitlines()]
    words = [w for w in words if w and w.isascii() and "'" not in w]
    if n >= len(words):
        return words
    stride = len(words) / n
    return [words[int(i * stride)] for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='fixtures/corpus/phrases.txt')
    ap.add_argument('-n', '--dict-words', type=int, default=8000)
    ap.add_argument('--rules-from', default='fixtures/amiga',
                    help='directory of translator.library builds')
    args = ap.parse_args()

    binaries = sorted(Path(args.rules_from).glob('translator_library-*.bin'))
    print('rule probes:')
    probes = rule_probes([str(b) for b in binaries])

    groups = [
        ('letters', LETTERS),
        ('edge', EDGE),
        ('rules', probes),
        ('dictionary', dictionary(args.dict_words)),
    ]

    seen, lines = set(), []
    print()
    for name, items in groups:
        added = 0
        for it in items:
            it = it.replace('\n', ' ').replace('\r', '')
            if it in seen:
                continue
            seen.add(it)
            lines.append(it)
            added += 1
        print(f'{name:12} {added:6}')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text('\n'.join(lines) + '\n', encoding='latin-1')
    print(f'\nwrote {len(lines)} phrases to {out}')


if __name__ == '__main__':
    main()
