#!/usr/bin/env python3
"""Emit the translator tables from a binary as JSON the library can load.

Kept as a build step rather than checked-in source: the rule table and class
table are Commodore's data. See the licence note in README.md — if that
question is ever settled in favour of shipping them, this same output becomes
a checked-in module with no code change.

Usage: gen-tables.py fixtures/amiga/translator_library-*.bin -o data/
"""
import argparse
import importlib.util
import json
import re
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'extract_rules', Path(__file__).with_name('extract-rules.py'))
extract_rules = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(extract_rules)


def right_of(rule):
    r"""The right-context pattern as the matcher actually sees it.

    The right-context scanner (0x2c4) walks forward until it hits `=`. A rule
    stored without one — `U[U]\` and `V[V]\` are the only two — therefore
    reaches the terminator and compares *that* against the input as an
    ordinary literal, which normally cannot match. Those rules are dead code
    in the shipped table, and the real library duly pronounces both letters of
    `divvied` and `UU`.

    Appending the terminator reproduces that exactly for any realistic input.
    Not reproduced: if the input genuinely contained a backslash there, the
    original would run on into the bytes of the *next* rule. That needs the
    rule region modelled as one byte stream and is not worth it.
    """
    if rule.get('no_equals'):
        return rule['right'] + rule['term']
    return rule['right']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binaries', nargs='+')
    ap.add_argument('-o', '--out', default='data')
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    written = []
    for path in args.binaries:
        try:
            t = extract_rules.RuleTable(path)
        except ValueError as exc:
            print(f'skipped {Path(path).name}: {exc}')
            continue
        m = re.search(r'-(\d+\.\d+)-', Path(path).name)
        version = m.group(1) if m else Path(path).stem
        payload = {
            'version': version,
            'source': Path(path).name,
            'classes': t.classes,
            'wildcards': extract_rules.WILDCARDS[:-1].decode('latin-1'),
            'vowels': t.vowels,
            # Flattened: the matcher selects a bucket then walks it in order,
            # so order within a bucket is load-bearing.
            'buckets': [[[r['left'], r['match'], right_of(r), r['out'], r['term']]
                         for r in bucket] for bucket in t.buckets],
        }
        fn = outdir / f'translator-{version}.json'
        fn.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
        written.append((version, fn, sum(len(b) for b in payload['buckets'])))

    for version, fn, n in written:
        print(f'{version:6} {n:5} rules -> {fn}')


if __name__ == '__main__':
    main()
