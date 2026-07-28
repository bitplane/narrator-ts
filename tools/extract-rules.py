#!/usr/bin/env python3
"""Extract the letter-to-sound rule table from any translator.library build.

Layout, established from the disassembly of 33.2 (offsets are hunk-relative;
hunk 0 begins at file 0x24):

  0x642  character class table, 128 entries of one big-endian word, indexed by
         `char * 2`. The matcher tests individual bits of it — see
         research/01-translator-matcher.md.
  0x742  the wildcard characters, `#*.$%&@^+:?_ `, NUL-terminated
  0x750  fifteen two-character vowel phonemes, used by the stress pass
  0x76e  28 big-endian longword bucket offsets, relative to the start of this
         table itself
  0x802  the rule text

A rule reads `left[match]right=output` and is terminated by either `\\` (0x5c)
or `` ` `` (0x60). Both end the rule — the scan at 0x2f8 treats them
identically — but the choice is *not* cosmetic: the code at 0x334 sets a flag
when the output's last character has class bit 7, then clears it again if the
terminator is `` ` ``. That flag gates the stress-assignment pass.

Rather than hardcode the layout, the offsets are located by signature so the
same extractor works across builds whose tables have shifted.
"""
import argparse
import json
import re
import struct
from pathlib import Path

HUNK_DELTA = 0x24          # file offset of hunk 0 for these builds
WILDCARDS = b'#*.$%&@^+:?_ \x00'
TERMINATORS = b'\\`'


class RuleTable:
    def __init__(self, path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self._locate()
        self._parse()

    # -------------------------------------------------------------- layout
    def _locate(self):
        d = self.data
        w = d.find(WILDCARDS)
        if w < 0:
            raise ValueError(f'{self.path.name}: wildcard string not found')
        self.wildcards_at = w
        self.classes_at = w - 0x100      # 128 entries * 2 bytes, ends at wildcards
        self.vowels_at = w + len(WILDCARDS)
        # The bucket table follows the vowel list. Its first entry is its own
        # length, since bucket 0 begins immediately after it.
        t = self.vowels_at + 30
        first = struct.unpack('>I', d[t:t + 4])[0]
        if first % 4 or not (0x40 <= first <= 0x200):
            raise ValueError(f'{self.path.name}: bucket table not where expected '
                             f'(first entry {first:#x} at {t:#x})')
        self.buckets_at = t
        self.n_buckets = first // 4
        self.offsets = [struct.unpack('>I', d[t + 4 * i:t + 4 * i + 4])[0]
                        for i in range(self.n_buckets)]

    # --------------------------------------------------------------- data
    def _parse(self):
        d = self.data
        # 128 entries is the whole table. Bucket selection indexes it with
        # `lsl.w`, which would read past the end for a byte >= 0x80, but the
        # buffer filler has already folded every such byte to a space with a
        # signed compare (0x526), so no high byte ever reaches the lookup.
        self.classes = [struct.unpack('>H', d[self.classes_at + 2 * i:
                                              self.classes_at + 2 * i + 2])[0]
                        for i in range(128)]
        self.vowels = [d[self.vowels_at + 2 * i:self.vowels_at + 2 * i + 2].decode('latin-1')
                       for i in range(15)]

        self.buckets = []
        for i, off in enumerate(self.offsets):
            start = self.buckets_at + off
            end = (self.buckets_at + self.offsets[i + 1]
                   if i + 1 < len(self.offsets) else self._bucket_end(start))
            self.buckets.append(self._parse_bucket(d[start:end], start))

    def _bucket_end(self, start):
        """The last bucket ends at the NUL that closes the rule text."""
        end = self.data.find(b'\x00', start)
        return end if end > 0 else len(self.data)

    @staticmethod
    def _parse_bucket(blob, base):
        r"""Parse `left[match]right=output<term>` structurally.

        Scanning for the terminator first does not work: the table contains
        rules *for the terminator characters*, so `[\]= \` and ``[`]= \`` would
        be shredded. Locating the brackets first makes the matched literal
        opaque, which is also how the matcher itself reads the table.

        A rule may also omit `=` entirely — `U[U]\` and `V[V]\` do — which
        means an empty output, i.e. a silent letter.
        """
        rules, p = [], 0
        n = len(blob)
        while p < n:
            lb = blob.find(b'[', p)
            if lb < 0:
                break
            rb = blob.find(b']', lb + 1)
            if rb < 0:
                break
            q = rb + 1
            eq = -1
            while q < n:
                c = blob[q]
                if c in TERMINATORS:
                    break
                if c == 0x3D and eq < 0:      # '='
                    eq = q
                q += 1
            if q >= n:
                break
            if eq < 0:
                right, out = blob[rb + 1:q], b''
            else:
                right, out = blob[rb + 1:eq], blob[eq + 1:q]
            rules.append({
                'left': blob[p:lb].decode('latin-1'),
                'match': blob[lb + 1:rb].decode('latin-1'),
                'right': right.decode('latin-1'),
                'out': out.decode('latin-1'),
                'term': chr(blob[q]),
                'no_equals': eq < 0,
                'at': base + p,
            })
            p = q + 1
        return rules

    # -------------------------------------------------------------- output
    def summary(self):
        bad = sum(1 for b in self.buckets for r in b if 'raw' in r)
        total = sum(len(b) for b in self.buckets)
        return (f'{self.path.name}\n'
                f'  classes  hunk {self.classes_at - HUNK_DELTA:#x}\n'
                f'  wildcard hunk {self.wildcards_at - HUNK_DELTA:#x}\n'
                f'  vowels   hunk {self.vowels_at - HUNK_DELTA:#x}  {" ".join(self.vowels)}\n'
                f'  buckets  hunk {self.buckets_at - HUNK_DELTA:#x}  '
                f'{self.n_buckets} buckets, {total} rules'
                + (f'  ** {bad} unparsed **' if bad else ''))

    def to_dict(self):
        return {
            'source': self.path.name,
            'classes': self.classes,
            'wildcards': WILDCARDS[:-1].decode('latin-1'),
            'vowels': self.vowels,
            'buckets': self.buckets,
        }

    def words(self):
        """Every bracketed literal, as a probe that reaches its rule."""
        out = []
        for b in self.buckets:
            for r in b:
                lit = r.get('match', '')
                if lit and all(c.isalpha() or c in "'." for c in lit):
                    out.append(lit)
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binaries', nargs='+')
    ap.add_argument('-o', '--out', help='write JSON here')
    ap.add_argument('--words', action='store_true', help='print bracketed literals')
    args = ap.parse_args()

    tables = []
    for b in args.binaries:
        t = RuleTable(b)
        tables.append(t)
        print(t.summary())
    if args.words:
        seen = dict.fromkeys(w for t in tables for w in t.words())
        print('\n'.join(seen))
    if args.out:
        Path(args.out).write_text(json.dumps(
            [t.to_dict() for t in tables], indent=1) + '\n')
        print(f'\nwrote {args.out}')


if __name__ == '__main__':
    main()
