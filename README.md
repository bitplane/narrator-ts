# narrator-ts

TypeScript reimplementation of the Amiga's speech pair: `translator.library`
(English to phonemes) and `narrator.device` 33.2 (phoneme formant synthesis).

Output is Paula-native — 8-bit signed samples and the period they were written
with. Verified against the real binaries running under a 68000 emulator:
byte-exact translation on 15,405 phrases, sample-exact synthesis end to end.

```ts
import { speak } from 'narrator-ts'
import { translate } from 'narrator-ts/translator'

const { phonemes } = translate('hello world', rules)   // '/HEH4LOW WER4LD '
const { pcm, sampleRate } = speak(Buffer.from(phonemes, 'latin1'), voice)
```

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

**A free voice**, built from published phonetics rather than extracted, is the
open work item. Until it exists a fresh clone cannot make a sound.

The letter-to-sound half already has its free equivalent, checked in and
usable by anyone:

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
npm run say -- 'hello world' -o hello.wav
npm run say -- -p '/HEH4LOW WER4LD' -o hello.wav
npm run say -- 'is this a question' --pitch 200 --rate 100
```

`--pitch --rate --sex --mode --sampfreq --mouths` are `narrator_rb`'s own
fields. `npm run say` with no arguments prints them.

Every tool under `tools/` takes `--help`.

## Status

| | |
|---|---|
| translator | byte-exact against all 6 shipped builds |
| narrator 33.2 | byte-exact front half, sample-exact renderer, end to end |
| free letter-to-sound table | built, divergence measured |
| free voice | **not started** |

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
