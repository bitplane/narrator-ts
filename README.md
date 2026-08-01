# narrator-ts

TypeScript reimplementation of the Amiga's speech pair: `translator.library`
(English to phonemes) and `narrator.device` 33.2 (phoneme formant synthesis).

Output is Paula-native — 8-bit signed samples and the period they were written
with. Verified against the real binaries running under a 68000 emulator:
byte-exact translation on 15,405 phrases, sample-exact synthesis end to end.

```sh
npm install narrator-ts
```

```ts
import { speak } from 'narrator-ts'
import { translate } from 'narrator-ts/translator'
import rules from 'narrator-ts/reference/nrl-table.json' with { type: 'json' }
import voice from 'narrator-ts/reference/voice-free.json' with { type: 'json' }

const { phonemes } = translate('hello world', rules)   // '/HEHLOW WERLD '
const { pcm, sampleRate } = speak(Buffer.from(phonemes, 'latin1'), voice)
// Int8Array(26112) at 22030 Hz
```

Both tables are the free ones, so that runs with nothing else installed. Swap
either for an extracted Amiga table to get the authentic voice — see below.

`pcm` is 8-bit signed. `speak` takes `narrator_rb`'s own parameters —
`pitch`, `rate`, `sex`, `mode`, `sampfreq`, `mouths` — and returns one entry
per sentence alongside the joined samples, because that is how the device
produces them.

## Voices

A voice is ~12 KB of tables: formant frequencies and amplitudes per phoneme,
durations, allophonic rewrite rules, the glottal waveform, fricative noise.
They are a *parameter*, not built in.

**The authentic Amiga voice** is Commodore and SoftVoice's, so it is not in
this repository. Extract it from Workbench disk images you already own:

```sh
python3 tools/extract-devices.py /path/to/workbench-disks -o fixtures/amiga
python3 tools/gen-voice.py   fixtures/amiga/narrator_device-33.2-*.bin     -o data
python3 tools/gen-tables.py  fixtures/amiga/translator_library-33.2-1*.bin -o data
```

**The free voice** is `reference/voice-free.json`, built from published
phonetics by `tools/gen-free-voice.py` and owing nothing to anyone. It is the
default, so a fresh clone speaks. It is not the Amiga's voice and does not
claim to be — `reference/README.md` says what is measured and what is still
provisional.

The letter-to-sound half has its free equivalent too, and is the default when
no Amiga table has been extracted:

```ts
import nrl from 'narrator-ts/reference/nrl-table.json' with { type: 'json' }
translate('hello world', nrl)   // '/HEHLOW WERLD '
```

That is the rule set of NRL Report 7948 (Elovitz et al., 1976 — a US
Government work), rebuilt from the report alone. It is not byte-compatible
with the Amiga and is not meant to be: 64.6% of distinct words match.
`research/03-nrl-provenance.md` has the measurements.

## Command line

```sh
npm run say -- 'hello world' -o hello.wav          # the free voice
npm run say -- 'hello world' -o hello.wav -V 33.2  # an extracted Amiga one
npm run say -- -p '/HEH4LOW WER4LD' -o hello.wav
npm run say -- 'is this a question' --pitch 200 --rate 100
```

`--pitch --rate --sex --mode --sampfreq --mouths` are `narrator_rb`'s own
fields. `npm run say` with no arguments prints them.

Every tool under `tools/` takes `--help`.

## AROS resource export

Create the versioned IFF resource consumed by AROS `translator.library`,
`narrator.device`, and `speech.device`:

```sh
npm run export:aros -- -o speech.iff
npm run export:aros -- -o speech.iff \
  --translator data/translator-33.2.json \
  --voice data/narrator-33.2.json
npm run export:aros -- -o speech-resource.c --format c
```

The first command uses the redistributable reference tables. The second uses
locally extracted authentic tables; the resulting file has the same legal
status as those inputs and should not be redistributed.
The C form contains the identical IFF payload as a byte array for ROM builds.

## Status

| | |
|---|---|
| translator | byte-exact against all 6 shipped builds |
| narrator 33.2 | byte-exact front half, sample-exact renderer, end to end |
| free letter-to-sound table | built, divergence measured |
| free voice | **speaks**; texture within a few percent of 33.2's, no allophonic rules yet |

`narrator.device` 37.7 is a rewrite and is **out of scope** — one voice done
properly. 1.6, 31.13, 33.2 and 36.9 are sample-identical over 4,865 phrases,
so 33.2 covers four of the five shipped builds anyway.

## Licence

Code is MIT.

The Amiga binaries and everything derived by running them are not
redistributable and are gitignored: `fixtures/amiga/*.bin`,
`fixtures/golden/`, `data/`. None has ever been committed.

`reference/` is the opposite — material that can be redistributed, with its
provenance recorded in `reference/README.md`.

`narrator.device`'s copyright line reads *Mark Barton / Joseph Katz*. It was
licensed in from SoftVoice, Inc.; Commodore never owned it.

## Documentation

| | |
|---|---|
| `docs/development.md` | building the oracle, regenerating fixtures, coverage |
| `research/00-findings.md` | what the binaries turned out to be |
| `research/01-translator.md` | the letter-to-sound engine |
| `research/02-narrator.md` | the synthesizer, stage by stage |
| `research/03-nrl-provenance.md` | which rules came from NRL and which SoftVoice added |
