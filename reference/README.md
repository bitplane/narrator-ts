# reference/

Public-domain source material, checked in.

Everything in this directory is here because it can be redistributed. That is
the opposite of `fixtures/amiga/` and `data/`, which are Commodore and
SoftVoice's and are gitignored.

## `nrl-7948.json`

The 329 letter-to-sound rules of:

> H. S. Elovitz, R. W. Johnson, A. McHugh and J. E. Shore,
> *Automatic Translation of English Text to Phonetics by Means of
> Letter-to-Sound Rules*, NRL Report 7948 (AD/A021 929),
> Naval Research Laboratory, Washington DC, 21 January 1976.

A work of the United States Government, and so not subject to copyright in the
United States (17 U.S.C. 105). Scans are available from DTIC as `ADA021929`.

The rule strings are a transcription of the report's appendix. 320 of the 329
were confirmed verbatim against OCR of the scanned report; the other 9 are
present but OCR-damaged. The character-class and metacharacter definitions
alongside them are from the report's SNOBOL listing. See
`research/03-nrl-provenance.md` for the verification and for the diff against
the Amiga table.

Used by `tools/nrl-diff.py` and `tools/gen-nrl-table.py`.

## `nrl-table.json`

The same rules, built into the shape the library loads — a `TranslatorTables`,
interchangeable with the extracted Amiga ones. This is the free table: usable
without permission from anyone.

```sh
python3 tools/gen-nrl-table.py --check data/translator-33.2.json
```

Generated rather than hand-written, and checked in anyway, because everything
it derives from is in this directory. Its character-class table is rebuilt
from the report's SNOBOL class definitions, not lifted from a binary; `--check`
diffs it against a real build, and they agree on every bit the matcher reads.

It has no stress marks, no whole-word pronunciations and no letter-name rules,
because NRL has none of those. Ignoring stress, about two thirds of English
words come out identical to `translator.library` 33.2 —
`npx vite-node tools/nrl-divergence.ts` measures it.
