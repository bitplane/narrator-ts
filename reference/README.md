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

## `formants.json`

The measured formant frequencies of ten American English vowels:

> G. E. Peterson and H. L. Barney, *Control Methods Used in a Study of the
> Vowels*, Journal of the Acoustical Society of America 24(2), 175-184, 1952.
> Table II, adult male means.

Measurements are facts rather than expression, and these particular ones have
been reproduced in every phonetics textbook since. They are here because
33.2's own vowel table appears to have been built from them: read back through
`tools/formants.py --diff`, its `IY` lands within one Hz of the published
`270 / 2290 / 3010`, and `AO`'s third formant is exact. 25 of 30 values agree
within 10%.

That matters for the free voice. Rebuilding the vowels from this table is not
an approximation of what SoftVoice did — it is the same thing they did, from
the same source.

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

## `voice-free.json`

A complete narrator voice built by `tools/gen-free-voice.py` from published
phonetics and from what `research/02-narrator.md` established each table
column means. Nothing in it is Commodore's or SoftVoice's.

The rule the generator holds to:

> Measurements come from the literature, cited at the point of use.
> Structure comes from principle, with the reasoning written down.
> No number is ever copied out of an extracted table.

It is not byte-identical to 33.2 and is not trying to be. What it is checked
against is stated rather than assumed — the attribute words, derived from
phonetic features alone, agree with 33.2's on 98% of their bits, and an
utterance comes out within 7% of the same length.

**Provisional, and marked so in the generator:** the amplitude tilt, the
glottal waveform envelope, and the eight fricative spectra are the parts that
want an ear rather than an argument. There are also no allophonic rewrite
rules yet, so the contextual variation — flapped /t/, aspirated stops, the
syllabic consonants — is missing. It speaks; it is not finished.
