#!/usr/bin/env python3
"""Pull narrator.device's two allophonic rewrite-rule tables out of a build.

The front half runs the same table-driven engine (hunk+0x12d8) twice over the
phoneme array, with different rules. The first pass is allophony proper --
`T` between vowels becomes the flap `DX`, `D` before `R` becomes `J`, `UL`
becomes `AX L` -- and the second expands phonemes into the several frames they
are actually made of: diphthongs gain their second half, and `P`/`T`/`K` gain
a release whose identity depends on whether an `S` precedes, which is the
difference between "pin" and "spin".

A rule is variable length. Byte 3's low nibble is that length, and **a length
of zero is the terminator**, not `0xff` -- `0xff` in byte 0 means "any
phoneme". Reading it the other way stops table 1 six rules early, at a rule
that happens to start with `0xff`, and the rules it drops are the ones that
insert glottal stops.

    +0  phoneme to match, 0xff for any
    +1  left neighbour, 0xff for any
    +2  right neighbour, 0xff for any
    +3  bits 0-3 length; bit 4 unused here; bit 5 "keep scanning this
        position after applying"; bit 6 skip an unstressed right neighbour;
        bit 7 skip an unstressed left neighbour
    +4  replacement, 0xff to leave alone
    +5  phoneme to insert before, 0xff for none
    +6  phoneme to insert after, 0xff for none
    +7. attribute tests, in three groups (this phoneme, left, right):
        bits 0-4 the bit to test, bit 5 invert, bit 6 test the attribute
        longword rather than the stress byte, bit 7 last test of the group.
        A test passes when the bit is *clear*.

    extract-rewrite-rules.py fixtures/amiga/narrator_device-33.2-*.bin -o out.json
"""
import argparse
import json
from pathlib import Path

FILE_BIAS = 0x28
NAMES = 0xE88
TABLES = {'allophones': 0x968, 'frames': 0xAE3}
MAX_RULES = 512


def read_rules(data, base):
    rules, off = [], base
    for _ in range(MAX_RULES):
        length = data[off + 3] & 0x0F
        if length == 0:
            return rules, off + 4 - base
        rules.append({
            'at': off,
            'match': data[off],
            'left': data[off + 1],
            'right': data[off + 2],
            'flags': data[off + 3] >> 4,
            'replace': data[off + 4] if length > 4 else 0xFF,
            'insertBefore': data[off + 5] if length > 5 else 0xFF,
            'insertAfter': data[off + 6] if length > 6 else 0xFF,
            'tests': list(data[off + 7:off + length]),
        })
        off += length
    raise SystemExit(f'{base:#x}: no terminator within {MAX_RULES} rules')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binary')
    ap.add_argument('-o', '--out')
    args = ap.parse_args()

    data = Path(args.binary).read_bytes()[FILE_BIAS:]
    names = [data[NAMES + 2 * i:NAMES + 2 * i + 2].rstrip(b'\0').decode('latin-1')
             for i in range(112)]

    def nm(v):
        return 'any' if v == 0xFF else (names[v] or f'<{v}>')

    out = {}
    for label, base in TABLES.items():
        rules, size = read_rules(data, base)
        out[label] = {'at': base, 'bytes': size, 'rules': rules}
        print(f'{label}: {len(rules)} rules, {size} bytes at hunk+{base:#x}')
        for r in rules:
            act = []
            if r['replace'] != 0xFF:
                act.append(f'-> {nm(r["replace"])}')
            if r['insertBefore'] != 0xFF:
                act.append(f'+before {nm(r["insertBefore"])}')
            if r['insertAfter'] != 0xFF:
                act.append(f'+after {nm(r["insertAfter"])}')
            ctx = ''
            if r['left'] != 0xFF:
                ctx += f' after {nm(r["left"])}'
            if r['right'] != 0xFF:
                ctx += f' before {nm(r["right"])}'
            print(f'  {nm(r["match"]):6}{ctx:16} {" ".join(act) or "(tests only)"}')

    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1) + '\n')
        print(f'-> {args.out}')


if __name__ == '__main__':
    main()
