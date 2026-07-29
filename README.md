# narrator-ts

A faithful TypeScript reimplementation of the Amiga's speech pair —
`translator.library` (English text to phonemes) and `narrator.device` (phoneme
formant synthesis).

Covers every shipped version, selectable at runtime. First target is **33.2**,
the Amiga 500 / Workbench 1.2-1.3 voice. `narrator.device` 37.7 (Kickstart
2.04, the Amiga 500 Plus) is a genuine rewrite and becomes a second backend
behind the same interface, not a parameterisation of the first.

This is a standalone, general-purpose library with no host-application
knowledge in it. It exposes the device's own interface — raw phoneme input as
well as English text, and the full parameter set (rate, pitch, sex, mode,
volume, sample rate) plus the mouth-shape output stream — so that the things
people actually built on the Amiga narrator, including the singing-voice
hacks that drive it phoneme-by-phoneme, are expressible.

## Why there is an emulator in here

"Sounds about right" is not a standard a formant synthesizer can be held to.
So the reference implementation is *the real thing*: `tools/oracle/` loads the
actual Amiga binaries into a 68000 emulator and runs them, capturing their
output as golden fixtures the TypeScript is diffed against.

That turns every question about behaviour into a byte-for-byte comparison
rather than an argument.

The 68k core is [Musashi](https://github.com/kstenerud/Musashi), vendored
rather than hand-rolled — a subtly wrong CPU would poison every fixture
without ever announcing itself.

## Layout

```
tools/
  extract-devices.py   harvest the Amiga binaries from Workbench disk images
  make-corpus.py       build the phrase corpus the translator is measured on
  extract-rules.py     pull the rule tables out of any translator build
  nrl-diff.py          measure the Amiga table against the published NRL rules
  gen-nrl-table.py     build the free NRL-only table from the report alone
  nrl-divergence.ts    measure what that free table costs, against 33.2
  probe-phonemes.py    discover a narrator build's phoneme set by asking it
  make-narrator-corpus.py  build the phoneme corpus from that inventory
  narrator-survey.py   how many distinct synthesizers are there really
  narrator-coverage.py attribute the device's code by watching which of it runs
  extract-phonemes.py  pull the phoneme table and attribute flags from a build
  extract-rewrite-rules.py  pull the two allophonic rule tables
  capture-frames.py    dump the renderer's input, to check the port against
  capture-parse.py     dump the phoneme parser's output, likewise
  capture-stages.py    dump the arrays after every front-half stage
  trace-stages.py      diff the workspace across stages, to attribute bytes
  branch-coverage.py   count the device's visits to each branch of a routine
  render-wav.ts        render captured frames to WAV with the TypeScript
  trace-render.py      single-step the device, logging pitch pulses and frames
  fetch-musashi.sh     vendor the 68000 core
  oracle/
    shim.c             flat memory + trap dispatch around Musashi
    m68k.py            ctypes binding
    amiga.py           hunk loader, allocator, trap plumbing
    execlib.py         a minimal exec.library
    tasks.py           cooperative tasks, signals and message ports
    audiodev.py        a fake audio.device that records instead of playing
    translate.py       drive the real translator.library
    narrator.py        drive the real narrator.device
    disasm.py          annotated disassembly
research/              findings, with offsets, so claims can be rechecked
reference/             public-domain source material, checked in
fixtures/
  amiga/               the Amiga binaries (not redistributable — see below)
  corpus/              input phrases (ours, checked in)
  golden/              reference output from the oracle (regenerated, not checked in)
src/                   the TypeScript library
```

## Getting set up

The Amiga binaries are Commodore's and are not in this repository. Extract
them from a tree of Workbench disk images you already have:

```sh
python3 tools/extract-devices.py /path/to/workbench-disks -o fixtures/amiga
```

This walks nested zips, reads OFS/FFS ADFs, and deduplicates by sha256, so it
finds one file per distinct build rather than one per disk. Across 222
Workbench images it yields 12: five `narrator.device` and seven
`translator.library`, spanning 1985 to 1991.

Then build the oracle and regenerate the golden fixtures:

```sh
npm run oracle:build
python3 tools/make-corpus.py
for f in fixtures/amiga/translator_library-*.bin; do
  v=$(basename "$f" .bin | sed 's/translator_library-//')
  python3 tools/oracle/translate.py -l "$f" \
      -f fixtures/corpus/phrases.txt -o "fixtures/golden/translator-$v.jsonl"
done
```

Just under 10,000 phrases take about six seconds per version through the
emulator, so regenerating every version is a matter of seconds.

The narrator's corpus is phonemes rather than text, and is built from the
inventory the device itself admits to:

```sh
python3 tools/make-narrator-corpus.py -o fixtures/corpus/phonemes.txt
python3 tools/make-narrator-corpus.py --subset 300 -o fixtures/corpus/phonemes-subset.txt
python3 tools/narrator-survey.py          # ~7 minutes, all five builds
```

Synthesis is slower than translation but not by much — about 80x realtime, so
the full 4,865-phrase corpus is 45 seconds per build.

The synthesis pipeline is checked stage by stage rather than only at the far
end, so it wants a few more fixtures — the tables lifted out of the binary,
and the device's own arrays either side of each stage:

```sh
python3 tools/extract-phonemes.py fixtures/amiga/narrator_device-33.2-*.bin \
    -o fixtures/golden/phonemes-33.2.json \
    --tables fixtures/golden/tables-33.2.json
python3 tools/extract-rewrite-rules.py fixtures/amiga/narrator_device-33.2-*.bin \
    -o fixtures/golden/rewrite-33.2.json
python3 tools/capture-parse.py -f fixtures/corpus/frames.txt \
    -o fixtures/golden/parse.json
python3 tools/capture-parse.py -f fixtures/corpus/parse.txt \
    -o fixtures/golden/parse-edge.json
python3 tools/capture-frames.py -f fixtures/corpus/frames.txt \
    -o fixtures/golden/frames.json
python3 tools/capture-stages.py --sub -f fixtures/corpus/frames.txt \
                                      -f fixtures/corpus/stages.txt \
    -o fixtures/golden/stages.json
python3 tools/capture-stages.py --sub --sex 1 -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-sex1.json
python3 tools/capture-stages.py --sub --mode 1 -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-mode1.json
python3 tools/capture-stages.py --sub --mouths 1 -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-mouths.json
```

`--sub` also breaks inside `hunk+0x1454` and `hunk+0x29d8`, which are drivers
of seven and nine sub-routines, and between the two halves of `hunk+0x19bc`,
so each of those can be checked on its own. The extra runs are not redundant: `sex` swaps in a whole second table
of formant frequencies and `mode` replaces the pitch contour with a flat one.
`mouths` asks for the lip-sync stream and is the only way to reach
`hunk+0x2e80` at all. All three are chosen by a *parameter*, so no corpus of
phrases can reach them however it is written.

Without those the front-half tests skip rather than fail, which is quiet
enough to miss — `npx vitest run` should report upwards of 4,700 tests.

Two corpora feed that last pair because they are chosen for different things.
`frames.txt` picks phrases that reach distinct paths through the *render*
loop; `stages.txt` picks them for the *front half*, one per decision the rest
of the corpus reaches once or not at all. Which branches those are is measured
rather than guessed:

```sh
python3 tools/branch-coverage.py -r durations \
    -f fixtures/corpus/frames.txt -f fixtures/corpus/stages.txt
```

`-r` also takes `frames` and `blend` for the two halves of the frame-array
builder, `contour` and `pitch` for the two halves of `hunk+0x19bc`, and
`interpolate`, and `prosody`.

That counts the device's own visits to each decision point in a routine. A
port can match every fixture and still be wrong down a branch the fixtures
never take — the stress spreader passed 27 of 30 captures with a real bug in
it — so a stage is not done until this says the corpus drives it.

## Status

| | |
|---|---|
| fixture extraction | working — 12 builds found, 1 identified as a corrupt dump |
| 68k oracle | working, both library conventions |
| `translator.library` under emulation | working for all 6 good builds, 1.3 through 37.1 |
| golden corpora | 9,804 training + 5,601 held-out phrases x 6 versions |
| **TypeScript translator** | **byte-exact against all 6 builds on both corpora** |
| free NRL-only table | built, checked in, 64.6% word agreement with 33.2 |
| `narrator.device` under emulation | **speaking, on all 5 builds** — 1.6 through 37.7 |
| narrator corpus | 4,865 phrases; **two synthesizers across 5 builds**, measured |
| narrator pipeline | mapped — dispatch, stages, renderer, frame format |
| **TypeScript renderer** | **sample-exact on all 30 captures**, voiced, unvoiced and mixed |
| **TypeScript phoneme parser** | **byte-exact**, 30 utterances + 50 edge cases |
| **TypeScript rewrite engine** | **byte-exact**, both allophonic passes, 30 utterances |
| **TypeScript stress spreader** | **byte-exact**, 30 utterances |
| TypeScript synthesizer | intonation and durations not started |

Only two distinct translator behaviours exist across 1985-1991: 1.3, and
31.7 onwards (which includes the V37 rewrite). The single difference is
whether `-ER`/`-ING` may take a trailing `S`; see `src/translator/engines.ts`.

The narrator splits two ways as well, and not where the version numbers
suggest: 1.6, 31.13, 33.2 and 36.9 are **sample-identical** over 4,865 phrases
and every parameter extreme, and 37.7 is the rewrite. So the synthesizer is
one implementation plus a second backend, not five.

A sample of what the real library, running here, actually produces:

```
'hello world'          -> '/HEH4LOW WER4LD '
'the quick brown fox'  -> 'DHAX KWIH4K BROW4N FAA4KS '
'1985'                 -> ' WAH4N  NAY4N  EY4T  FAY4V  '
'Dr. Smith'            -> 'DAA3KTER SMIH4TH '
'versatile'            -> 'VERSAETAY3L '
```

The last one is wrong, and is supposed to be — a faithful reimplementation has
to mispronounce it too. Blaming the NRL rules for that would be too easy,
though: they give `VERSAETIHL`, and it is a rule SoftVoice *added* that turns
it into "versa-tile". See `research/03-nrl-provenance.md`.

And the narrator, driven from the same rig:

```sh
python3 tools/oracle/narrator.py -t 'hello world' -o hello.wav
# 108 writes, 55296 samples, period 161 -> 22030 Hz, channels [1, 2]
```

Output is Paula-native — 8-bit signed samples plus the period they were written
with — because that is what the chip consumes and what the library will take as
its primitive. `research/02-narrator.md` has the device's side of it.

## Licence position

The code here is MIT. The Amiga binaries are not ours and are gitignored, as
is everything derived from them by running them — `fixtures/golden/` and
`data/`. `reference/` is the opposite: material that *can* be redistributed.

**The translator's rule table is mostly public domain, and this is measured
rather than assumed.** It is the rule set of NRL Report 7948 (Elovitz et al.,
Naval Research Laboratory, 1976 — a US Government work, not subject to
copyright in the US), extended by SoftVoice. `tools/nrl-diff.py` reports the
split; `research/03-nrl-provenance.md` shows the working:

```
 version  rules  ident  stress  edited  absent  moved  added  NRL-derived
    33.2    701    212      70      36      11      4    383        45.4%
```

318 of NRL's 329 rules survive into the Amiga table. What SoftVoice added is
383 rules — word pronunciations, letter names, degemination — plus stress
digits, which NRL has no notion of.

**That free table is built and checked in**, at `reference/nrl-table.json`.
Its class table is rebuilt from the report's own definitions rather than
lifted from a binary, and agrees with the binary's on every bit the matcher
reads. Nothing in it comes from Commodore or SoftVoice, and it drops into the
same engine:

```ts
import nrl from 'narrator-ts/reference/nrl-table.json' with { type: 'json' }
translate('hello world', nrl)   // '/HEHLOW WERLD '
```

It is not byte-compatible with the Amiga and is not meant to be — no stress
marks, no word rules. Ignoring stress marks, **64.6% of distinct words come
out phoneme-for-phoneme identical** to 33.2 (`tools/nrl-divergence.ts`); most
of the rest is two phonemes NRL does not use and doubled consonants it does
not silence.

**Still open:** `narrator.device`'s formant constants, which none of the above
touches. Note that the copyright line in every build reads *Mark Barton /
Joseph Katz* — this was licensed in from SoftVoice, Inc. and Commodore never
owned it, which is likely why the device vanished from AmigaOS 3.5 onward.
