#!/usr/bin/env python3
"""Diff the Amiga translator.library rule table against the published NRL rules.

The Amiga table is not original letter-to-sound research: it is the 329 rules
of NRL Report 7948 (Elovitz, Johnson, McHugh & Shore, 1976 - a work of the US
Government, and so not subject to copyright in the United States), extended by
SoftVoice.  This tool measures the extension precisely, so the licence question
can rest on a number rather than an impression.

The notation is the same in both, `left[match]right=output`, but the report
writes phonemes as space-separated tokens between slashes.  Four mechanical
differences have to be undone before outputs can be compared:

  * tokens are concatenated                    /AA R/     -> AAR
  * JH is spelled J                            /IH JH/    -> IHJ
  * HH is spelled /H                           /HH UW/    -> /HUW
  * a schwa or short-I before a liquid or nasal becomes one of SAM's six
    syllabic phonemes                          /AX L IY/  -> ULIY

The last is not a guess.  `narrator.device` carries the string `ULUMUNILIMIN`
- UL UM UN IL IM IN, exactly this set - and applying the fold turns NRL's
`[7]=/S EH V AX N/` into the Amiga's `SEH4VUN`.

One structural difference also has to be undone.  The report's TRANS program
inserts blanks on either side of punctuation before matching (see the SNOBOL
listing under "BLANKS ON EITHER SIDE OF ANY PUNCTUATION APPEARING"), so a
possessive is matched as `JOHN ' S` and the rule reads `. [' S]`.  The Amiga
dropped that pass and closed the rules up to `.['S]`.  Rules whose match
literal contains a space are therefore compared both ways.

Rules are matched on context, not position, and reordering is reported
separately - SoftVoice both interleaved new rules and moved existing ones,
and a moved rule is a change in match priority, not a deletion.
"""
import argparse
import json
import re
from difflib import SequenceMatcher
from pathlib import Path

REFERENCE = Path(__file__).resolve().parent.parent / 'reference' / 'nrl-7948.json'

# NRL bucket names to the Amiga's bucket indices.  Selection at 0x258 remaps a
# digit to '[' and any other non-letter to '\', then indexes char-'A', so 26 is
# digits and 27 is punctuation.
BUCKET = {chr(ord('A') + i): i for i in range(26)} | {'NUMBER': 26, 'PUNCT': 27}

SYLLABIC = {('AX', 'L'): 'UL', ('AX', 'M'): 'UM', ('AX', 'N'): 'UN',
            ('IH', 'L'): 'IL', ('IH', 'M'): 'IM', ('IH', 'N'): 'IN'}
RESPELL = {'JH': 'J', 'HH': '/H'}

RULE = re.compile(r'^(.*?)\[(.*?)\](.*?)=/(.*)/$')
STRESS = re.compile(r'[1-9]')
# `<x>` is "emit x literally"; anything else is a phoneme name.
TOKEN = re.compile(r'<(.)>|(\S+)')


def nrl_tokens(body):
    """Split a rule body into (text, is_literal) pairs.

    `<x>` has to survive tokenisation rather than being unwrapped first: it is
    the only way a rule can emit a space, so splitting on blanks up front
    turns `/< >/` (emit one space) into `//` (emit nothing).  An empty body,
    `/ /`, really does mean silence.
    """
    return [(m[1], True) if m[1] is not None else (m[2], False)
            for m in TOKEN.finditer(body)]


def nrl_output(body):
    """Join NRL's token list into the Amiga's run-together phoneme string."""
    toks, out, i = nrl_tokens(body), [], 0
    while i < len(toks):
        text, literal = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if not literal and nxt and not nxt[1] and (text, nxt[0]) in SYLLABIC:
            out.append(SYLLABIC[(text, nxt[0])])
            i += 2
        else:
            out.append(text if literal else RESPELL.get(text, text))
            i += 1
    return ''.join(out)


def load_nrl(path=REFERENCE):
    doc = json.loads(Path(path).read_text())
    out = {}
    for name, rules in doc['rules'].items():
        parsed = []
        for r in rules:
            m = RULE.match(r)
            if not m:
                raise ValueError(f'unparsed NRL rule: {r!r}')
            left, match, right, body = m.groups()
            parsed.append({'left': left, 'match': match, 'right': right,
                           'out': nrl_output(body), 'raw': r})
        out[BUCKET[name]] = parsed
    return doc, out


def load_amiga(path):
    t = json.loads(Path(path).read_text())
    return {i: [{'left': l, 'match': m, 'right': r, 'out': o, 'term': term}
                for l, m, r, o, term in b]
            for i, b in enumerate(t['buckets'])}


def keys(rule):
    """Context keys to try, most faithful first, tagged with why they differ.

    `#^:` and `#:^` both mean "vowels followed by one or more consonants" and
    differ only in where the greedy part sits.  The report uses the first; the
    Amiga uses the second, in all ten rules and no others.

    That is a port, not an edit.  A left context is scanned outwards from the
    match, and `:` steps back exactly one after over-consuming (0x4c2), so the
    character `^` goes on to test is the one that *ended* `:`'s run - never a
    consonant.  `^:` in a left context is therefore unsatisfiable without
    backtracking, which SNOBOL has and the 68k matcher does not.  Building the
    table both ways and running it confirms this: the ten rules never fire as
    written (tools/gen-nrl-table.py --verbatim).  They count as the same rule
    here, and are reported separately.
    """
    left, match, right = rule['left'], rule['match'], rule['right']
    ks = [((left, match, right), None)]
    if ' ' in match:
        ks.append((((left[:-1] if left.endswith(' ') else left),
                    match.replace(' ', ''),
                    (right[1:] if right.startswith(' ') else right)), 'blanks'))
    if '^:' in left or '^:' in right:
        ks.append(((left.replace('^:', ':^'), match,
                    right.replace('^:', ':^')), 'caret-colon'))
    return ks


def classify(n, a):
    if n['out'] == a['out']:
        return 'identical'
    if STRESS.sub('', a['out']) == n['out']:
        return 'stress'
    return 'edited'


def compare(nrl, amiga):
    # 'respelt' overlaps the output categories: it counts rules whose context
    # needed a documented notation adjustment before it would match at all.
    counts = {'identical': 0, 'stress': 0, 'edited': 0,
              'absent': 0, 'added': 0, 'reordered': 0, 'respelt': 0}
    detail = {k: [] for k in counts}

    for b in sorted(set(nrl) | set(amiga)):
        nb, ab = nrl.get(b, []), amiga.get(b, [])
        # Index the Amiga bucket by context key.  Duplicate keys occur (a rule
        # can appear twice with different terminators) so each is a queue.
        index = {}
        for i, a in enumerate(ab):
            index.setdefault((a['left'], a['match'], a['right']), []).append(i)
        taken, pairs = set(), []
        for n in nb:
            hit = why = None
            for k, tag in keys(n):
                if index.get(k):
                    hit, why = index[k].pop(0), tag
                    break
            if hit is None:
                counts['absent'] += 1
                detail['absent'].append((b, n, None))
                continue
            if why:
                counts['respelt'] += 1
                detail['respelt'].append((b, n, ab[hit]))
            taken.add(hit)
            a = ab[hit]
            c = classify(n, a)
            counts[c] += 1
            detail[c].append((b, n, a))
            pairs.append(hit)

        # Of the rules that survived, how many kept their relative order?
        # Match priority is positional, so a move is a behavioural change.
        sm = SequenceMatcher(None, pairs, sorted(pairs), autojunk=False)
        kept = sum(n for _, _, n in sm.get_matching_blocks())
        counts['reordered'] += len(pairs) - kept

        for i, a in enumerate(ab):
            if i not in taken:
                counts['added'] += 1
                detail['added'].append((b, None, a))
    return counts, detail


def show(rule):
    return '-' if rule is None else \
        f"{rule['left']}[{rule['match']}]{rule['right']}={rule['out']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tables', nargs='+', help='data/translator-*.json')
    ap.add_argument('--reference', default=REFERENCE)
    ap.add_argument('--detail', choices=['identical', 'stress', 'edited',
                                         'absent', 'added', 'respelt'],
                    help='list the rules in one category')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    doc, nrl = load_nrl(args.reference)
    n_nrl = sum(len(v) for v in nrl.values())
    prov = doc['_provenance']
    print(f"reference: {prov['report']} ({prov['published']}), {n_nrl} rules")
    print(f"           {prov['rights']}\n")

    hdr = (f"{'version':>8} {'rules':>6} {'ident':>6} {'stress':>7} {'edited':>7} "
           f"{'absent':>7} {'moved':>6} {'added':>6} {'NRL-derived':>12}")
    print(hdr)
    print('-' * len(hdr))
    last = None
    for path in args.tables:
        version = re.sub(r'.*translator-|\.json$', '', str(path))
        counts, detail = compare(nrl, load_amiga(path))
        total = sum(len(v) for v in load_amiga(path).values())
        derived = counts['identical'] + counts['stress'] + counts['edited']
        print(f"{version:>8} {total:6} {counts['identical']:6} {counts['stress']:7} "
              f"{counts['edited']:7} {counts['absent']:7} {counts['reordered']:6} "
              f"{counts['added']:6} {derived / total * 100:11.1f}%")
        last = (version, counts, detail)

    if args.detail and last:
        version, counts, detail = last
        rows = detail[args.detail][:args.limit or None]
        print(f"\n--- {args.detail} ({counts[args.detail]} in {version})")
        for b, n, a in rows:
            label = 'NUMBER' if b == 26 else 'PUNCT' if b == 27 else chr(65 + b)
            if args.detail in ('added', 'absent'):
                print(f'  {label:6} {show(n or a)}')
            else:
                print(f'  {label:6} NRL   {show(n)}\n         amiga {show(a)}')


if __name__ == '__main__':
    main()
