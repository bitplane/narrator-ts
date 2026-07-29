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

# Two per-phoneme duration tables, in frames, read by hunk+0x1520. Bit 4 of
# the stress byte -- the one the onset marker and the spreader both set --
# picks between them, so these are "stressed" and "unstressed" durations.
# The syllabics UL/UM/UN/IL/IM/IN read 0 in both because the first rewrite
# pass always expands them and they never reach this stage; NH reads 0 too,
# and NH is one of the three phonemes that crash the device when spoken alone.
DURATION = 0x3806
DURATION_UNSTRESSED = 0x3886

# hunk+0x15e0 fills the frame array from a contiguous block of 0x80-byte
# per-phoneme tables: the three formant phase increments it writes into frame
# bytes 0-2, the three amplitudes into bytes 3-5, and the voicing byte into 6.
# The names are what the renderer does with each byte (research/02, "The frame
# format") rather than a guess from the tables' contents.
#
# A stressed phoneme has 2 added to each amplitude, clamped at 0x1f, which is
# most of what stress *sounds* like. A non-zero `sex` parameter (A5+0x26)
# swaps the frequency triple for a second set at hunk+0x50ae -- higher
# formants, the same amplitudes and the same voicing.
PARAM_TABLES = {
    'f1': 0x3506, 'f2': 0x3586, 'f3': 0x3606,
    'a1': 0x3686, 'a2': 0x3706, 'a3': 0x3786,
    'voicing': 0x3A06,
}
PARAM_TABLES_ALT = {'f1': 0x50AE, 'f2': 0x512E, 'f3': 0x51AE}

# Four more in the same block, read by the two coarticulation routines at the
# end of hunk+0x1454. They are the SAM tables under different addresses: a
# blend rank that decides which of two neighbours wins a boundary, a weight
# for how far the loser is pulled towards it, and the number of frames each
# phoneme spends transitioning in and out.
#
# `.`/`?`/`,`/`-` rank 31 and beat everything; the vowels rank 2 and lose to
# almost everything, which is why a vowel next to a consonant takes the
# consonant's shape at the join rather than the other way round.
# And one more, read only when narrator_rb.mouths is set: hunk+0x16dc looks
# the phoneme up here and writes the byte into the lip-sync stream, once per
# frame. Low nibble a width, high nibble a height.
MOUTH_TABLE = {'mouth': 0x30A0}

BLEND_TABLES = {
    'rank': 0x3A86, 'weight': 0x3B06,
    'transitionIn': 0x3906, 'transitionOut': 0x3986,
}

# Not per-phoneme, so written to their own file. hunk+0x2d1c runs every
# amplitude in the frame array through this one on the way out: 32 entries,
# rising 0, 1, 1, 1, ... 25, 28, 31. The amplitudes upstream are therefore on
# a perceptual scale and this is what turns them into linear ones.
SHARED_TABLES = {'amplitudeGain': (0x2CFC, 0x20)}

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


def durations(data):
    return [[data[DURATION + i], data[DURATION_UNSTRESSED + i]]
            for i in range(ATTR_COUNT)]


def params(data, tables):
    return {k: list(data[b:b + ATTR_COUNT]) for k, b in tables.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binary')
    ap.add_argument('-o', '--out')
    ap.add_argument('--tables', help='where to write the non-per-phoneme tables')
    args = ap.parse_args()

    data = read_hunk(args.binary)
    nm, at, du = names(data), attrs(data), durations(data)
    pa = params(data, PARAM_TABLES)
    pa.update(params(data, BLEND_TABLES))
    pa.update(params(data, MOUTH_TABLE))
    pa_alt = params(data, PARAM_TABLES_ALT)

    rows = []
    for i, n in enumerate(nm):
        a = at[i] if i < ATTR_COUNT else None
        rows.append({'index': i, 'name': n, 'attrs': a,
                     'duration': du[i] if i < ATTR_COUNT else None,
                     'params': {k: v[i] for k, v in pa.items()}
                     if i < ATTR_COUNT else None,
                     'paramsAlt': {k: v[i] for k, v in pa_alt.items()}
                     if i < ATTR_COUNT else None,
                     'bits': sorted(b for b in range(32) if a >> b & 1)
                     if a is not None else None})

    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1) + '\n')
        print(f'-> {args.out}')

    if args.tables:
        shared = {k: list(data[b:b + n]) for k, (b, n) in SHARED_TABLES.items()}
        Path(args.tables).write_text(json.dumps(shared, indent=1) + '\n')
        print(f'-> {args.tables}')

    print(f'{len(rows)} slots, {sum(1 for r in rows if r["name"])} named')
    for r in rows:
        label = r['name'] or '(continuation)'
        if r['attrs'] is None:
            print(f'  {r["index"]:3} {label:14} --------  (stress digit)')
            continue
        flags = ' '.join(BITS.get(b, str(b)) for b in r['bits'])
        d = r['duration']
        print(f'  {r["index"]:3} {label:14} {r["attrs"]:08x} '
              f'{d[0]:3}/{d[1]:<3} {flags}')


if __name__ == '__main__':
    main()
