#!/usr/bin/env python3
r"""Build a TranslatorTables from the published NRL rules alone.

Unlike `gen-tables.py`, whose output is Commodore and SoftVoice's data and is
gitignored, this reads only `reference/nrl-7948.json` - a work of the US
Government, not subject to copyright in the United States - and its output is
checked in.  It is the free-licence table: a translator anyone can ship.

It is *not* a reconstruction of the Amiga table.  It has no stress marks, no
whole-word pronunciations and no letter-name rules, because NRL has none; see
`research/03-nrl-provenance.md` for the measured difference.

Three things the report specifies but the JSON does not store directly:

**The character-class table.**  Built from the report's own SNOBOL class
definitions rather than lifted from a binary.  That the Amiga's table at hunk
0x642 agrees with them character for character - including NONPAL, which is a
peculiar enough set to be diagnostic - is what established the provenance in
the first place, and `--check` re-runs that comparison.

**The metacharacters.**  NRL defines ten; the Amiga added `?` and `_`.  Only
the ten are marked here, so `?` in `[?]=/<?>/` stays an ordinary literal.

**Stress.**  NRL has no notion of it.  Every rule therefore gets the backtick
terminator, which is the matcher's "not eligible for a stress mark" flag, and
the vowel table the stress pass would consult is left empty.  This also keeps
the output free of the one piece of narrator-side data the pass needs.

Two deviations from the report are forced by the matcher, and both are the
deviation SoftVoice made.  Neither is discretionary: as transcribed, the
affected rules are provably dead here.

**Blank insertion.**  NRL's TRANS inserts blanks on either side of punctuation
before matching, so a possessive is matched as `JOHN ' S` and its rule reads
`. [' S]`.  That pass cannot be reproduced: this matcher buffers one word at a
time (0x4fc), so an inserted blank would split `JOHN ' S` into three words and
the left context `.` could no longer see the N.  Blanks adjacent to an
apostrophe are closed up instead.

**`^:` in a left context.**  A left context is scanned outwards from the match
(0x3be), so its characters are applied in reverse, and there is no
backtracking.  `:` consumes consonants until one is not, then steps back
exactly one (0x4c2) - so the character `^` goes on to test is the one that
*ended* `:`'s run, which is by definition not a consonant.  `^` immediately
left of `:` therefore cannot match, ever, and the ten NRL rules written `#^:`
would be dead code.  SNOBOL backtracks and so has no such problem, which is
why the report can write them that way.  Swapping to `#:^` restores the
report's meaning under a matcher that does not; it is what every Amiga build
does.  `--verbatim` disables the swap so the claim can be checked.

Usage: gen-nrl-table.py [-o reference/nrl-table.json] [--check data/translator-33.2.json]
"""
import argparse
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    'nrl_diff', Path(__file__).with_name('nrl-diff.py'))
nrl_diff = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nrl_diff)

# src/translator/types.ts CLASS.  Bit 9 and 12-15 are unused in every build.
PUNCT, DIGIT, AFFECTS_U, VOICED = 1 << 0, 1 << 1, 1 << 2, 1 << 3
SIBILANT, CONSONANT, VOWEL, LETTER = 1 << 4, 1 << 5, 1 << 6, 1 << 7
FRONT_VOWEL, WILDCARD, DELIMITER = 1 << 8, 1 << 10, 1 << 11

# Report class name -> the bit the matcher's wildcard handlers test.
CLASS_BIT = {'VOWEL': VOWEL, 'CONSONANT': CONSONANT, 'VOICED': VOICED,
             'FRONT': FRONT_VOWEL, 'SIBILANT': SIBILANT, 'NONPAL': AFFECTS_U}

BUCKET_NAME = [chr(ord('A') + i) for i in range(26)] + ['NUMBER', 'PUNCT']

# The matcher's stress-suppressing terminator (0x334).  Used for every rule.
NO_STRESS = '`'


def class_table(classes, wildcards):
    """The 128-entry class table, derived from the report's definitions.

    Bits 0 and 11 are never read by the matcher.  Bit 0 follows the Amiga's
    convention - printable non-alphanumerics and the space - because it costs
    nothing.  Bit 11 is left clear: the Amiga marks ` !#(),-.?` as delimiters
    but nothing reads it, and NRL does not define the set, so inventing one
    would be the only unsourced number in the file.
    """
    table = [0] * 128
    for code in range(128):
        ch, bits = chr(code), 0
        # Uppercase only, as in every shipped build: the buffer filler folds
        # case before anything reads a class (0x53a), so the lowercase half of
        # the table is unreachable and is left clear rather than duplicated.
        if ch.isupper():
            bits |= LETTER
        elif ch.isdigit():
            bits |= DIGIT
        if code == 0x20 or (0x21 <= code <= 0x7e and not ch.isalnum()):
            bits |= PUNCT
        for name, bit in CLASS_BIT.items():
            if ch in classes[name]:
                bits |= bit
        if ch in wildcards:
            bits |= WILDCARD
        table[code] = bits
    return table


def deblank(left, match, right):
    r"""Undo the blank-insertion pass around apostrophes.

    The three parts are joined so adjacency works across the brackets: in
    `. [' S]` the blank sits in the left context but belongs to the `'` that
    opens the match.  Returns None for a rule whose match literal is emptied
    by this, which is `[ ]'=/ /` - the blank *before* an apostrophe, an
    artefact of the pass with nothing left to match.  An empty match literal
    would succeed without consuming a character and hang the matcher, which is
    presumably why SoftVoice dropped that rule too.
    """
    marks = [0] * len(left) + [1] * len(match) + [2] * len(right)
    text = left + match + right
    keep = [i for i, c in enumerate(text)
            if not (c == ' ' and ((i and text[i - 1] == "'")
                                  or (i + 1 < len(text) and text[i + 1] == "'")))]
    parts = ['', '', '']
    for i in keep:
        parts[marks[i]] += text[i]
    return None if not parts[1] else tuple(parts)


def build(reference, pronunciations=None, verbatim=False):
    doc = json.loads(Path(reference).read_text())
    buckets, dropped, deblanked, swapped = [], [], [], []
    for name in BUCKET_NAME:
        rules = []
        for raw in doc['rules'][name]:
            m = nrl_diff.RULE.match(raw)
            if not m:
                raise ValueError(f'unparsed NRL rule: {raw!r}')
            left, match, right, body = m.groups()
            fixed = deblank(left, match, right)
            if fixed is None:
                dropped.append((name, raw))
                continue
            if fixed != (left, match, right):
                deblanked.append((name, raw, '%s[%s]%s' % fixed))
            if not verbatim and '^:' in fixed[0]:
                fixed = (fixed[0].replace('^:', ':^'), fixed[1], fixed[2])
                swapped.append((name, raw, '%s[%s]%s' % fixed))
            rules.append([*fixed, nrl_diff.nrl_output(body), NO_STRESS])
        buckets.append(rules)

    if pronunciations is not None:
        overlay = json.loads(Path(pronunciations).read_text())
        for rule in reversed(overlay.get('rules', [])):
            if (len(rule) != 5 or not rule[1] or
                    not rule[1][0].isalpha() or
                    not rule[1][0].isupper() or
                    not rule[3] or len(rule[4]) != 1):
                raise ValueError(f'invalid free pronunciation rule: {rule!r}')
            bucket = ord(rule[1][0]) - ord('A')
            buckets[bucket].insert(0, rule)
        # Insert prefixes first so exact words, inserted afterwards at the
        # same bucket head, take precedence when both can match.
        for kind, right in (('prefixes', ''), ('words', ' ')):
            for word, output in overlay.get(kind, {}).items():
                if not word.isalpha() or not word.isupper() or not output:
                    raise ValueError(
                        f'invalid free pronunciation: {word!r}: {output!r}')
                bucket = ord(word[0]) - ord('A')
                buckets[bucket].insert(
                    0, [' ', word, right, output, NO_STRESS])

    prov = doc['_provenance']
    table = {
        'version': 'nrl-7948',
        'source': f"{prov['report']} ({prov['published']})",
        '_provenance': prov['rights'],
        'classes': class_table(doc['classes'], ''.join(doc['metacharacters']) + ' '),
        'wildcards': ''.join(doc['metacharacters']) + ' ',
        # NRL has no stress pass, so nothing consults this.
        'vowels': [],
        'buckets': buckets,
    }
    return table, dropped, deblanked, swapped


def check(table, amiga_path):
    """Compare the derived class table against a real build's, bit by bit."""
    amiga = json.loads(Path(amiga_path).read_text())
    names = {PUNCT: 'PUNCT', DIGIT: 'DIGIT', AFFECTS_U: 'AFFECTS_U',
             VOICED: 'VOICED', SIBILANT: 'SIBILANT', CONSONANT: 'CONSONANT',
             VOWEL: 'VOWEL', LETTER: 'LETTER', FRONT_VOWEL: 'FRONT_VOWEL',
             WILDCARD: 'WILDCARD', DELIMITER: 'DELIMITER'}
    print(f"\nclass table vs {Path(amiga_path).name}:")
    for bit, label in names.items():
        ours = {chr(c) for c in range(128) if table['classes'][c] & bit}
        theirs = {chr(c) for c in range(128) if amiga['classes'][c] & bit}
        def show(s):
            return ''.join(sorted(c if c.isprintable() and c != ' ' else '<sp>'
                                  for c in s)) or '-'
        if ours == theirs:
            print(f'  {label:12} same  {show(ours)}')
        else:
            print(f'  {label:12} DIFFERS  only ours: {show(ours - theirs)}'
                  f'  only theirs: {show(theirs - ours)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reference', default=ROOT / 'reference' / 'nrl-7948.json')
    ap.add_argument('--pronunciations',
                    default=ROOT / 'reference' / 'free-pronunciations.json')
    ap.add_argument('-o', '--out', default=ROOT / 'reference' / 'nrl-table.json')
    ap.add_argument('--check', metavar='AMIGA_TABLE',
                    help='also diff the derived class table against a build')
    ap.add_argument('--verbatim', action='store_true',
                    help='keep `^:` left contexts as transcribed (see above)')
    args = ap.parse_args()

    table, dropped, deblanked, swapped = build(
        args.reference, args.pronunciations, args.verbatim)
    Path(args.out).write_text(json.dumps(table, separators=(',', ':')) + '\n')
    n = sum(len(b) for b in table['buckets'])
    print(f'{n} rules across {len(table["buckets"])} buckets -> {args.out}')

    if deblanked:
        print(f'\nblank-insertion pass undone ({len(deblanked)}):')
        for name, before, after in deblanked:
            print(f'  {name:6} {before:24} -> {after}')
    if swapped:
        print(f'\n`^:` left contexts reordered ({len(swapped)}):')
        for name, before, after in swapped:
            print(f'  {name:6} {before:24} -> {after}')
    if dropped:
        print(f'\ndropped, empty match after undoing it ({len(dropped)}):')
        for name, raw in dropped:
            print(f'  {name:6} {raw}')
    if args.check:
        check(table, args.check)


if __name__ == '__main__':
    main()
