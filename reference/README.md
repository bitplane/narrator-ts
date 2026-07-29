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

Texture, against the same utterance — `tools/voice-texture.py` reproduces it:

| | 33.2 | free |
|---|---|---|
| spectral centroid | 2517 Hz | 2390 Hz |
| energy above 4 kHz | 22.9% | 20.6% |
| roughness | 0.18 | 0.19 |
| zero crossings | 390 Hz | 528 Hz |
| RMS / peak | 25.7 / 122 | 26.5 / 122 |

It was much harsher than that, and then it was clear but slurred — "please
top what you want me to se". Six things were wrong, and all six were
structural rather than a matter of taste:

- **The amplitude scale was linear where it should have been decibels.** The
  stored value controls a 5-bit multiplier, so the widest range it can express
  is 30 dB and the 31 steps across it are ~1 dB each. Once `gain_curve()`
  became the antilog of that, it came out within a step of 33.2's own curve at
  every point — the same agreement the vowel formants have, and for the same
  reason.
- **The formant levels came from a truncated pole product.** Three poles keep
  every skirt from below and lose every lift from above, which costs 20 dB at
  F3 and puts /IY/'s F2 under the floor — the vowel loses the formant that
  identifies it, and the diphthong glides go with it, which is what turned
  *type* into *top*. Carried to convergence with the tract's higher poles at
  their neutral positions, the model lands 2.9 dB from 33.2's own table on
  average.
- **The noise tables were filtered per byte, and the renderer reads two
  samples out of every byte.** Whatever shaping went in was destroyed by the
  split; every table measured the same, and all of them far too loud.
- **`QX` had a vowel's amplitudes.** It is the placeholder the pitch stage
  seeds a slot with, so every utterance began with a buzz.
- **The excitation used a third of the five bits available**, which quantises
  a vowel to three and puts broadband hash under all of it. It also decayed
  from the pitch pulse when the pulse is the glottal *opening*: the second
  half of every period came out nearly silent, peaky enough to force the whole
  voice's level down to stay inside eight bits. Modelling both halves — the
  ring-down of the last pulse plus Rosenberg's rising flow of the current one
  — put the crest factor within 0.1 dB of 33.2's.
- **There were no rewrite rules at all**, which I had written off as missing
  polish. It is not: the driver runs the engine twice, and the second pass is
  what expands a phoneme into the several slots it is really stored as. A
  diphthong's offglide and a stop's release live in the blank slots after
  their nucleus, and only the nucleus is in the inventory the parser matches.
  Without the rules, every diphthong in the language was its nucleus alone —
  *type* came out *top*, *say* came out *se*, and *five* was unrecognisable.
  Which slot follows which is a fact about the table layout rather than a
  choice, so the free set comes out much the same shape as 33.2's: 42 frame
  rules against its 46.

What is still missing is the *contextual* allophony — the flapped /t/ of
"butter", and the rest of 33.2's 33-rule first pass. The free set has seven:
the six syllabic consonants and dark /l/. It speaks; it is not finished.
