# Where the translator's rule table comes from

`translator.library` does not contain original letter-to-sound research. It
contains the rules of **NRL Report 7948**, *Automatic Translation of English
Text to Phonetics by Means of Letter-to-Sound Rules*, by H. S. Elovitz, R. W.
Johnson, A. McHugh and J. E. Shore, Naval Research Laboratory, 21 January
1976 (AD/A021 929) — extended by SoftVoice.

This matters because the report is **a work of the United States Government
and so not subject to copyright in the United States** (17 U.S.C. 105), while
the extension is not. Knowing which parts are which turns the question of what
may be shipped from a guess into a measurement.

Reproduce with:

```sh
python3 tools/nrl-diff.py data/translator-*.json          # the split
python3 tools/gen-nrl-table.py --check data/translator-33.2.json
npx vite-node tools/nrl-divergence.ts                     # what the free table costs
```

## The evidence that it is NRL

Three independent things line up, none of which I was looking for when I found
the first:

**The metacharacters.** The wildcard string at hunk `0x742` is `#*.$%&@^+:?_ `.
NRL defines `#*.$%&@^+:` and nothing else; `?` and `_` are SoftVoice's.

**The class definitions.** The class-bit meanings in `01-translator.md` were
derived from the wildcard jump table at `0x60e` before I had read the report.
They match its SNOBOL listing exactly — and `gen-nrl-table.py --check` now
rebuilds all 128 entries from the report's definitions and diffs them against
the binary's, which agree on **every bit the matcher reads**. The only
differences are the two metacharacters SoftVoice added and one bit nothing
reads.

| NRL | report | derived from the 68k |
|---|---|---|
| `VOWEL` | `AEIOUY` | bit 6 |
| `CONSONANT` | `BCDFGHJKLMNPQRSTVWXZ` | bit 5 |
| `VOICED` | `BDVGJLMNRWZ` | bit 3 |
| `FRONT` | `EIY` | bit 8 |
| `SIBILANT` | `SCGZXJ` | bit 4 |
| `NONPAL` | `TSRDLZNJ` | bit 2 |

`NONPAL` is the report's name for the consonants that palatalise a following
long U. I had written that bit down as "D J L N R S T Z — consonants that
change a following long U", from the `@` handler alone.

**The bucket structure.** NRL groups its rules into 28 buckets: `A`–`Z`,
`NUMBER`, `PUNCT`. The Amiga has 28 buckets, and bucket selection at `0x258`
folds digits into 26 and everything else into 27.

## Verifying the transcription

The rule text used here is a transcription of the report's appendix. It was
checked against OCR of the scanned report itself:

- **320 of 329** rule outputs appear verbatim in the OCR
- **9** do not, and every one is visibly OCR damage rather than a
  transcription error — `[DOING]=/D UNWIH NX/` for `/D UW IH NX/`,
  `'(41-/F OW RAV` for `[4]=/F OW R/`, `'(E8]=/EY TA'` for `[8]=/EY T/`

The scan is legible enough to confirm the transcription and not legible enough
to be the machine-readable source, which is why both are kept.

## The diff

All six good builds give the same answer:

| | 1.3 | 31.7–37.1 |
|---|---:|---:|
| rules in the Amiga table | 700 | 701 |
| NRL rules, output identical | 212 | 212 |
| NRL rules, differing only by inserted stress digits | 70 | 70 |
| NRL rules, output edited | 36 | 36 |
| NRL rules absent | 11 | 11 |
| NRL rules kept but moved | 4 | 4 |
| rules added by SoftVoice | 382 | 383 |
| **NRL-derived share of the table** | **45.4%** | **45.4%** |

**318 of NRL's 329 rules survive into the Amiga table** — 96.7% of the report's
rule set is still in there. The table is roughly NRL plus an equal weight of
SoftVoice additions.

## Notation differences that had to be undone first

The report writes phonemes as space-separated tokens between slashes. Four
mechanical respellings account for every systematic difference:

| | report | Amiga |
|---|---|---|
| tokens run together | `/AA R/` | `AAR` |
| `JH` | `/IH JH/` | `IHJ` |
| `HH` | `/HH UW/` | `/HUW` |
| syllabic consonants | `/S EH V AX N/` | `SEH4VUN` |

The last is `AX`/`IH` before `L`, `M` or `N` collapsing to one of six syllabic
phonemes. That is not a guess: `narrator.device` carries the string
`ULUMUNILIMIN` — `UL UM UN IL IM IN`, exactly this set.

Two structural differences also had to be handled:

**NRL inserts blanks around punctuation before matching** (its SNOBOL listing,
under "BLANKS ON EITHER SIDE OF ANY PUNCTUATION APPEARING"), so a possessive is
matched as `JOHN ' S` and the rule reads `. [' S]`. The Amiga dropped that pass
and closed the rules up to `.['S]`.

**`#^:` versus `#:^`.** The Amiga writes `#:^` where the report has `#^:`, in
all ten such rules and nowhere else. Both mean "vowels followed by one or more
consonants"; they differ only in which part is greedy.

This is a port, not an edit, and the reason is in the matcher. A left context
is applied outwards from the match, so its characters run in reverse, and `:`
steps back exactly one after over-consuming (`0x4c2`). The character `^` then
tests is therefore the one that *ended* `:`'s run — which is not a consonant,
by definition. **`^` immediately left of `:` in a left context cannot match,
ever.** SNOBOL backtracks and so can write the rule the natural way round; the
68k matcher does not, so SoftVoice had to move the greedy part away from the
anchor.

Building the free table both ways and running it settles it empirically:
those ten rules never fire as transcribed, and swapping them lifts word-level
agreement with the Amiga from 56.2% to 64.6% (below). This also closes what
was previously listed as an open question about the scan — the appendix can be
taken to print `#^:`, because that is the form that is correct for the
notation as the report defines it.

## What SoftVoice added

383 rules, of which:

- **165 whole-word pronunciations** — `BECAUSE`, `BEFORE`, `BETWEEN`, `SINCE`,
  and, less timelessly, `APPLE`, `AMIGA`, `ATARI`, `SONY` and `SOFTVOICE`
- **20 letter-name rules** of the form ` :[B]: = BIY4 `, so that isolated
  letters are spelled out
- **181 short contextual rules** in NRL's own idiom, extending its coverage
- **stress digits throughout** — 282 of the 701 rules carry one, and NRL has
  no notion of stress at all. This is the largest single functional addition:
  the stress pass at `0x59e`, its 15-vowel table, and the `` ` `` terminator
  that suppresses it are all outside NRL's design.

## What SoftVoice removed

Only 11 rules, and they look like considered deletions rather than losses:

```
 [DOING]=DUWIHNX     [DU]A=JUW      [I]T%=AY      [PEOP]=PIYP
 [DOW]=DAW           ' ^:[E] =      #:[OR] =ER    [THAT] =DHAET
 #[SN] '=ZUN         [ ]'=          [-]=-
```

`[PEOP]` and `[THAT] ` are superseded by fuller word rules; `[ ]'=` and `[-]=-`
belong to the punctuation-blanking pass that was dropped.

## The free table, and what it costs

`reference/nrl-table.json` is the rules above and nothing else, built by
`tools/gen-nrl-table.py` from `reference/nrl-7948.json`. It is checked in.
328 rules; the 329th is `[ ]'=/ /`, whose match literal empties once the
blanking pass is gone, and an empty literal would spin the matcher.

Three things it does not take from any binary:

- **the class table**, rebuilt from the report's SNOBOL definitions. `--check`
  diffs it against a real build: identical on every bit the matcher reads.
- **the metacharacters**, NRL's ten only. `?` and `_` stay ordinary literals.
- **stress**, which NRL has no notion of. Every rule carries the backtick
  terminator — the matcher's "not eligible for a stress mark" flag — so the
  stress pass never runs and the fifteen-vowel table it would consult is
  empty. That also keeps the one piece of narrator-side data out of the file.

Measured against 33.2 over both corpora (`tools/nrl-divergence.ts`):

| | exact | ignoring stress marks |
|---|---:|---:|
| training, 9,806 phrases | 2.5% | 61.8% |
| held-out, 5,602 phrases | 0.2% | 66.0% |
| distinct words, 14,641 | 0.7% | **64.6%** |

The exact column is near zero and says nothing: 282 Amiga rules carry a stress
digit, so almost every word differs by at least one. The second column is the
real measure — **about two thirds of English words come out phoneme-for-phoneme
identical**, and the word figure is the honest one because the matcher buffers
a word at a time, making words independent.

The 5,182 differing words reduce to 939 distinct causes, and the head of that
list is short:

```
 557  OH / AO    for, forget, or
 492  H  / X     a, around
 294  AY / IH    versatile, device
 237  -  / T     diskette, pitch
 127  -  / P     psalm, apple
 122  -  / N     anne, annexes
```

Three kinds of thing, none of them subtle:

- **Phoneme inventory.** `OH` and `AH` are narrator phonemes NRL does not use;
  it writes `AO` and `AX` in those positions. Both are speakable, and this is
  the single largest cause.
- **Degemination.** SoftVoice added rules silencing the second of a doubled
  consonant. NRL has only `L[L]`, so the free table says `AEPPUL` for *apple*
  where the Amiga says `AE3PUL`.
- **Added rules firing first.** *versatile* is the interesting one. The Amiga
  says `VERSAETAY3L`; the free table says `VERSAETIHL`, which is closer to
  correct. The culprit is `#:^[I]^%=AY3`, which NRL does not have — the
  mispronunciation is SoftVoice's, not NRL's.

## What this means for shipping tables

Factually, and not as legal advice:

- The **structure** — notation, metacharacters, class definitions, bucket
  layout, matching algorithm — is NRL's, and is public domain.
- **318 of 329 NRL rules** are present, 211 of them byte-identical after
  respelling. Those have public-domain provenance.
- The remaining **383 rules and the stress digits** are SoftVoice's work.
  Individually each is a fact about how an English word is pronounced;
  collectively they are a compilation.
- `narrator.device`'s formant data is a separate question entirely and none of
  the above touches it.

The practical consequence is that a **freely-licensed translator built on the
NRL rules alone is available today** and needs nothing from Commodore or
SoftVoice. It is not byte-compatible with the Amiga — no stress marks, no word
rules — so it is a second table, not a replacement, and two thirds of words
agree phoneme-for-phoneme.

## Still open

- Nothing on provenance. `narrator.device`'s formant constants are a separate
  question and this line of work does not touch them.
