# Development

## The oracle

The reference implementation is the real thing: `tools/oracle/` loads the
Amiga binaries into a 68000 emulator and runs them, capturing their output as
fixtures the TypeScript is diffed against. The core is
[Musashi](https://github.com/kstenerud/Musashi), vendored rather than
hand-rolled.

`narrator.device` is a device, not a library — `CMD_WRITE` returns before the
audio does — so the oracle grew a cooperative scheduler and a fake
`audio.device`. `research/02-narrator.md` explains why.

```sh
npm run oracle:build
```

## Getting the binaries

Not in this repository. Extract from Workbench disk images you already own:

```sh
python3 tools/extract-devices.py /path/to/workbench-disks -o fixtures/amiga
```

Walks nested zips, reads OFS/FFS ADFs, deduplicates by sha256. Across 222
Workbench images it yields 12 distinct builds: five `narrator.device`, seven
`translator.library`, 1985 to 1991.

## Regenerating fixtures

Everything under `fixtures/golden/` and `data/` is a build product. Without
it most tests skip rather than fail, which is quiet enough to miss — a full
run should report upwards of 7,500 tests.

### Corpora

```sh
python3 tools/make-corpus.py
python3 tools/make-narrator-corpus.py -o fixtures/corpus/phonemes.txt
python3 tools/make-narrator-corpus.py --subset 300 -o fixtures/corpus/phonemes-subset.txt
```

The narrator's corpus is phonemes rather than text, built from the inventory
the device itself admits to when probed.

### Translator

```sh
for f in fixtures/amiga/translator_library-*.bin; do
  v=$(basename "$f" .bin | sed 's/translator_library-//')
  python3 tools/oracle/translate.py -l "$f" \
      -f fixtures/corpus/phrases.txt -o "fixtures/golden/translator-$v.jsonl"
done
python3 tools/gen-tables.py fixtures/amiga/translator_library-*.bin -o data
```

Just under 10,000 phrases take about six seconds per version.

### Narrator

```sh
python3 tools/gen-voice.py fixtures/amiga/narrator_device-33.2-*.bin -o data

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
python3 tools/capture-frames.py -f fixtures/corpus/frames.txt \
    --rate 300 --sampfreq 10000 --sex 1 --pitch 200 \
    -o fixtures/golden/frames-params.json
python3 tools/capture-frames.py -f fixtures/corpus/sentences.txt \
    -o fixtures/golden/frames-sentences.json

python3 tools/capture-stages.py --sub -f fixtures/corpus/frames.txt \
                                      -f fixtures/corpus/stages.txt \
    -o fixtures/golden/stages.json
python3 tools/capture-stages.py --sub --sex 1   -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-sex1.json
python3 tools/capture-stages.py --sub --mode 1  -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-mode1.json
python3 tools/capture-stages.py --sub --mouths 1 -f fixtures/corpus/frames.txt \
    -o fixtures/golden/stages-mouths.json
```

Synthesis runs about 80x realtime, so the full 4,865-phrase corpus is 45
seconds per build.

`--sub` breaks inside `hunk+0x1454` and `hunk+0x29d8` — drivers of seven and
nine sub-routines — and between the two halves of `hunk+0x19bc`, so each can
be checked on its own rather than only at the far end.

The four separate `capture-stages` runs are not redundant. `sex` swaps in a
second table of formant frequencies, `mode` replaces the pitch contour with a
flat one, and `mouths` is the only way to reach `hunk+0x2e80` at all. All
three are chosen by a *parameter*, so no corpus of phrases can reach them
however it is written.

## Branch coverage

A port can match every fixture and still be wrong down a branch the fixtures
never take — the stress spreader passed 27 of 30 captures with a real bug in
it. So a stage is not done until the device's own branch counts say the corpus
drives it.

```sh
python3 tools/branch-coverage.py -r durations \
    -f fixtures/corpus/frames.txt -f fixtures/corpus/stages.txt
```

`-r` takes `durations`, `frames`, `blend`, `contour`, `pitch`, `interpolate`,
`prosody`, `body`. `-a 0x1c34=name` watches an arbitrary address.

Two corpora feed the front half because they are chosen for different things:
`frames.txt` picks phrases that reach distinct paths through the *render*
loop, `stages.txt` picks them one per decision the rest of the corpus reaches
once or not at all.

## Listening

```sh
npm run say -- 'hello world' -o hello.wav

# the whole captured corpus, ours beside the device's
npx vite-node tools/render-wav.ts -- -o /tmp/out --speak --both

# the device itself, for comparison
python3 tools/oracle/narrator.py -t 'hello world' -o hello.wav
```

## Layout

| | |
|---|---|
| `src/translator/` | letter-to-sound |
| `src/narrator/` | parser, rewrite, stress, prosody, durations, frames, renderer |
| `tools/oracle/` | 68k emulator, hunk loader, exec/audio shims |
| `tools/extract-*`, `gen-*` | pull tables out of the binaries |
| `tools/capture-*` | record the device's own output as fixtures |
| `tools/make-*` | build the corpora |
| `fixtures/corpus/` | the phrase and phoneme lists, checked in |
| `fixtures/golden/` | what the device did with them, gitignored |
| `reference/` | public-domain source material, checked in |

Every tool takes `--help`.
