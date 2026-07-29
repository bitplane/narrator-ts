#!/usr/bin/env python3
"""Capture what narrator.device's phoneme parser produces, per utterance.

The front half of the synthesizer starts by turning the input string into
three parallel byte arrays, and everything after it works from those rather
than from the text. Capturing them makes the parser checkable on its own,
the way capture-frames.py makes the renderer checkable on its own -- which
matters, because a parser bug and a duration bug look identical in the audio.

The parser is hunk+0xf68. It matches two characters at a time against the
112-name table at hunk+0xe88 and writes, at index 4 onwards:

    A5+0x0e8   the phoneme index, one byte each
    A5+0x2e8   the stress digit as ASCII, or 0
    A5+0x4e8   flags it sets while scanning (bits 4 and 5)

and 0xff into all three as a terminator, with the count in A5+0x9a. Index 2 of
the phoneme array is seeded with 0x15 (QX) before the scan.

Note the first two arrays are the same memory the renderer later uses as its
two audio buffers -- the workspace is reused between stages, so these have to
be read at the parser's exit and not afterwards.

    capture-parse.py -f fixtures/corpus/parse.txt -o fixtures/golden/parse-edge.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))
sys.path.insert(0, str(ROOT / 'tools'))

import narrator as N                                          # noqa: E402
from m68k import A5                                           # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

from importlib import import_module                           # noqa: E402
capture_frames = import_module('capture-frames')

# hunk+0x1122: the parser's success exit, after the terminator is written and
# with the count still in D3.
BREAK = 0x1122
# hunk+0x10ca: the rejection exit's `rts`, which is where D3 finally holds the
# 1-based offset of the offending character rather than an error code. Note
# 0x10c2, the label the branches target, is three instructions too early --
# stopping there reads the phoneme write index and gets a plausible wrong
# answer. Worth capturing at all because a port that accepts what the device
# rejects is not a faithful one.
BREAK_ERR = 0x10CA
# hunk+0x1120: the third exit. Input that yields no phoneme at all -- a lone
# pause, or a '#' before anything -- returns zero here rather than an empty
# utterance, and never reaches either of the above.
BREAK_EMPTY = 0x1120

PHONEMES = 0x0E8
STRESS = 0x2E8
FLAGS = 0x4E8
COUNT = 0x9A
MAX = 0x200


def read_corpus(path):
    """One input per line, `#` comments, blanks ignored.

    Leading and trailing spaces are exactly what this parser handles specially,
    and a line in a text file cannot carry them visibly. So a line may instead
    be wrapped in double quotes, and then it is taken between the quotes
    verbatim — `" AA4"` is a leading space and means it on purpose.
    """
    out = []
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        line = line.strip()
        if len(line) >= 2 and line[0] == '"' and line[-1] == '"':
            out.append(line[1:-1])
        else:
            out.append(line)
    return out


def run_to(device, phrase, off, opts):
    """A fresh machine, run until hunk+`off`. None if it never gets there.

    Fresh every time because a run that misses its target has already spoken the
    utterance and left the workspace in the next stage's hands.
    """
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    if not capture_frames.run_to(n, phrase, n.hunks[0].addr + off, opts):
        return None
    return n


def capture(device, phrase, opts):
    n = run_to(device, phrase, BREAK, opts)
    if n is None:
        n = run_to(device, phrase, BREAK_ERR, opts)
        if n is not None:
            return {'in': phrase, 'parsed': False,
                    'error': n.m.cpu.get(3) & 0xFFFF}
        n = run_to(device, phrase, BREAK_EMPTY, opts)
        if n is not None:
            return {'in': phrase, 'parsed': False, 'empty': True}
        return {'in': phrase, 'parsed': False}
    cpu = n.m.cpu
    a5 = cpu.get(A5)
    count = cpu.get(3) & 0xFFFF          # D3
    take = min(count + 1, MAX)
    return {
        'in': phrase,
        'parsed': True,
        'count': count,
        'phonemes': list(cpu.read(a5 + PHONEMES, take)),
        'stress': list(cpu.read(a5 + STRESS, take)),
        'flags': list(cpu.read(a5 + FLAGS, take)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phrase', action='append', default=[])
    ap.add_argument('-f', '--file')
    ap.add_argument('-o', '--out', required=True)
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()

    phrases = list(args.phrase)
    if args.file:
        phrases += read_corpus(Path(args.file))
    if not phrases:
        ap.error('nothing to capture: pass -p or -f')

    opts = {k: getattr(args, k) for k in N.DEFAULTS}
    out = [capture(args.device, p, opts) for p in phrases]
    Path(args.out).write_text(json.dumps(out) + '\n')
    for r in out:
        if not r['parsed']:
            why = (f'rejected at character {r["error"]}' if 'error' in r
                   else 'no phonemes at all' if r.get('empty')
                   else 'never reached any parser exit')
            print(f'  {r["in"]!r:32} {why}')
            continue
        print(f'  {r["in"]!r:32} {r["count"]:4} phonemes  '
              f'{r["phonemes"][:12]}')
    print(f'-> {args.out}')


if __name__ == '__main__':
    main()
