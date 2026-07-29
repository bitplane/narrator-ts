#!/usr/bin/env python3
"""Pull narrator.device's phoneme table and per-phoneme attribute flags.

The parser at hunk+0xf68 matches the input two characters at a time against a
table of 112 two-byte names at hunk+0xe88, and the index it lands on is used
everywhere downstream — including as a longword index into an attribute table
at hunk+0x2f08 whose bits are tested all over the synthesizer.

Both are static data, so they can be read out of the binary rather than
observed. That matters: the port needs the *whole* table, including the entries
no phrase in any corpus happens to reach.

Empty name slots are not padding. A diphthong or a stop occupies several
consecutive indices — one per frame it expands to — and only the first carries
a name. So a gap in the names is a phoneme that is more than one frame long,
which is a fact about the synthesizer, not about the table's layout.

    extract-phonemes.py fixtures/amiga/narrator_device-33.2-*.bin -o out.json
"""
import argparse
import json
from pathlib import Path

# Hunk 0's contents start this far into the file: HUNK_HEADER for a
# three-hunk load file, then HUNK_CODE and its length longword.
FILE_BIAS = 0x28

NAMES = 0xE88       # 112 two-byte phoneme names
COUNT = 112

# One longword of flags per phoneme -- but only 102 of them. The last ten
# names are the stress digits '0'..'9', and the parser peels those off as
# stress marks (hunk+0xfea, before the lookup at 0x1028), so they never index
# this table. It ends at hunk+0x30a0, where an unrelated byte table starts.
ATTRS = 0x2F08
ATTR_COUNT = 102

# Bits the code is seen to test, with the offset that tests them. Named only
# where the surrounding code makes the meaning plain; the rest are recorded by
# number rather than guessed at.
BITS = {
    0: 'digit-follows-ok',      # 0xf68+0xa2: gates a stress digit
    4: 'bit4',                  # 0x107a bset, on the *previous* phoneme
    5: 'bit5',                  # 0x106a bset, on this one
    0x19: 'needs-terminator',   # 0x10de: if clear, a '-' is appended
    0x1a: 'bit1a',              # 0x103a
    0x1b: 'illegal-here',       # 0x1032: rejects the input
}


def read_hunk(path):
    return Path(path).read_bytes()[FILE_BIAS:]


def names(data):
    out = []
    for i in range(COUNT):
        raw = data[NAMES + 2 * i:NAMES + 2 * i + 2]
        out.append(raw.rstrip(b'\0').decode('latin-1'))
    return out


def attrs(data):
    return [int.from_bytes(data[ATTRS + 4 * i:ATTRS + 4 * i + 4], 'big')
            for i in range(ATTR_COUNT)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binary')
    ap.add_argument('-o', '--out')
    args = ap.parse_args()

    data = read_hunk(args.binary)
    nm, at = names(data), attrs(data)

    rows = []
    for i, n in enumerate(nm):
        a = at[i] if i < ATTR_COUNT else None
        rows.append({'index': i, 'name': n, 'attrs': a,
                     'bits': sorted(b for b in range(32) if a >> b & 1)
                     if a is not None else None})

    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1) + '\n')
        print(f'-> {args.out}')

    print(f'{len(rows)} slots, {sum(1 for r in rows if r["name"])} named')
    for r in rows:
        label = r['name'] or '(continuation)'
        if r['attrs'] is None:
            print(f'  {r["index"]:3} {label:14} --------  (stress digit)')
            continue
        flags = ' '.join(BITS.get(b, str(b)) for b in r['bits'])
        print(f'  {r["index"]:3} {label:14} {r["attrs"]:08x}  {flags}')


if __name__ == '__main__':
    main()
