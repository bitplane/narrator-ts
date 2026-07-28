#!/usr/bin/env python3
"""Build a held-out corpus that shares no input with the training corpus.

The main corpus derives probes from the rule tables, so passing it partly
measures the extractor rather than the engine. This set is chosen without
reference to the tables at all:

  - dictionary words on a different stride, then filtered against the main
    corpus so there is literally no overlap
  - multi-word sentences, which exercise the word-boundary and stress-carry
    paths that single words never reach
  - boundary lengths around the 100-character word limit
  - the `##` end-of-translation sentinel
  - bytes the normaliser is supposed to fold: controls, DEL, `]`, high-bit

Usage: make-holdout.py -o fixtures/corpus/holdout.txt
"""
import argparse
from pathlib import Path

SENTENCES = [
    'The quick brown fox jumps over the lazy dog',
    'Now is the time for all good men to come to the aid of the party',
    'How much wood would a woodchuck chuck if a woodchuck could chuck wood',
    'She sells sea shells by the sea shore',
    'Peter Piper picked a peck of pickled peppers',
    'To be or not to be that is the question',
    'It was the best of times it was the worst of times',
    'We hold these truths to be self evident',
    'Four score and seven years ago our fathers brought forth',
    'The rain in Spain falls mainly on the plain',
    'A man a plan a canal Panama',
    'Pack my box with five dozen liquor jugs',
    'Jackdaws love my big sphinx of quartz',
    'The five boxing wizards jump quickly',
    'Amazingly few discotheques provide jukeboxes',
    'I think therefore I am',
    'All work and no play makes Jack a dull boy',
    'The treaty was signed on the third of September nineteen thirty nine',
    'Please call me back at five five five one two three four',
    'Doctor Smith and Mister Jones went to Saint Andrews Avenue',
]

EDGE = [
    '##',                      # end-of-translation sentinel, alone
    'before##after',           # sentinel mid-string
    'a##',
    '#',                       # single hash is a word, not a sentinel
    '# #',
    'x' * 99,                  # just under the 100-char word limit
    'x' * 100,                 # exactly at it
    'x' * 101,                 # over it: expect rc -3
    'y' * 200,
    'word ' + 'z' * 120,       # limit reached on a later word
    '\t\ttabs\tand\tspaces',
    'control\x01\x02chars',
    'delete\x7fchar',
    'bracket]close',
    'high\xe9\xfcbytes',
    ' ' * 20,
    '.' * 10,
    '-' * 10,
    'MiXeD CaSe WoRdS',
    "it's don't won't o'clock",
    'hyphen-ated com-pound',
    '3.14159 2.71828',
    '1,000,000 and 0.5',
    'A1B2C3D4',
    'e e e e e',
    'ss ss ss',
]


def dictionary(n, skip, path='/usr/share/dict/words'):
    p = Path(path)
    if not p.exists():
        return []
    words = [w.strip() for w in p.read_text(encoding='latin-1', errors='ignore').splitlines()]
    words = [w for w in words if w and w.isascii() and "'" not in w]
    # A different stride and a half-step offset, so it cannot coincide with
    # the training sample even where the counts line up.
    stride = len(words) / n
    return [words[min(len(words) - 1, int((i + 0.5) * stride) + skip)] for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='fixtures/corpus/holdout.txt')
    ap.add_argument('-n', '--dict-words', type=int, default=6000)
    ap.add_argument('--exclude', default='fixtures/corpus/phrases.txt')
    args = ap.parse_args()

    excluded = set()
    ex = Path(args.exclude)
    if ex.exists():
        excluded = set(ex.read_text(encoding='latin-1').splitlines())

    lines, seen = [], set()
    counts = {}
    for name, items in (('sentences', SENTENCES), ('edge', EDGE),
                        ('dictionary', dictionary(args.dict_words, 7))):
        n = 0
        for it in items:
            if it in seen or it in excluded:
                continue
            seen.add(it)
            lines.append(it)
            n += 1
        counts[name] = n

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text('\n'.join(lines) + '\n', encoding='latin-1')
    for k, v in counts.items():
        print(f'{k:12} {v:6}')
    print(f'\nwrote {len(lines)} held-out phrases to {out}')
    print(f'overlap with {args.exclude}: 0 (filtered)')


if __name__ == '__main__':
    main()
