#!/usr/bin/env python3
"""Emit everything narrator-ts needs to speak, from a narrator.device binary.

The library takes its tables as an argument rather than shipping them: they
are Commodore's data, extracted from a binary this repository does not
redistribute. This is the build step that produces them, and it is the
narrator's counterpart to gen-tables.py. If the licence question is ever
settled in favour of shipping them, this same output becomes a checked-in
module with no change to any code that reads it.

Two groups. The front half's tables are per-phoneme columns and the two
rewrite rule sets, which extract-phonemes.py and extract-rewrite-rules.py
already know how to read. The back half's are three flat byte tables the
renderer indexes directly:

    hunk+0x3106  0x400   amplitude x waveform, the multiply done as a lookup
    hunk+0x4aae          the waveform itself, stepped 0x40 at a time
    hunk+0x3bae  8x0x1e0 the fricative noise tables, one per source

The waveform table has no length in the binary. The renderer's pointer only
resets on a pitch pulse and steps 0x40 per `waveStep` samples, so the furthest
it can reach is (255/9)*0x40; the rest of the hunk is taken to be safe.

Usage: gen-voice.py fixtures/amiga/narrator_device-33.2-*.bin -o data/
"""
import argparse
import importlib.util
import json
import re
from pathlib import Path


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


phonemes = _load('extract_phonemes', 'extract-phonemes.py')
rewrite_rules = _load('extract_rewrite_rules', 'extract-rewrite-rules.py')

# The renderer's three tables, as (offset, length). A length of None means
# "to the end of the hunk".
AMP_TABLE = (0x3106, 0x400)
WAVE_TABLE = (0x4AAE, None)
FRICATIVES = (0x3BAE, 0x1E0, 8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('binaries', nargs='+')
    ap.add_argument('-o', '--out', default='data')
    args = ap.parse_args()

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    for path in args.binaries:
        data = phonemes.read_hunk(path)
        m = re.search(r'-(\d+\.\d+)-', Path(path).name)
        version = m.group(1) if m else Path(path).stem

        nm = phonemes.names(data)
        at = phonemes.attrs(data)
        du = phonemes.durations(data)
        pa = phonemes.params(data, phonemes.PARAM_TABLES)
        pa.update(phonemes.params(data, phonemes.BLEND_TABLES))
        pa.update(phonemes.params(data, phonemes.MOUTH_TABLE))
        alt = phonemes.params(data, phonemes.PARAM_TABLES_ALT)
        shared = {k: list(data[b:b + n])
                  for k, (b, n) in phonemes.SHARED_TABLES.items()}

        n = phonemes.ATTR_COUNT
        off, ln = AMP_TABLE
        wave_off, _ = WAVE_TABLE
        fr_off, fr_len, fr_n = FRICATIVES
        payload = {
            'version': version,
            'source': Path(path).name,
            'names': nm,
            # `parse` indexes this by phoneme and the stress digits sit past
            # its end, so it is padded to the name count rather than truncated.
            'attrs': at + [0] * (len(nm) - len(at)),
            'params': {k: v[:n] for k, v in pa.items()},
            'paramsAlt': {k: v[:n] for k, v in alt.items()},
            'stressed': [d[0] for d in du],
            'unstressed': [d[1] for d in du],
            'gain': shared['amplitudeGain'],
            'rules': rewrite_rules.extract(data),
            'wave': list(data[wave_off:]),
            'amp': list(data[off:off + ln]),
            'fricatives': [list(data[fr_off + i * fr_len:fr_off + (i + 1) * fr_len])
                           for i in range(fr_n)],
        }
        out = outdir / f'narrator-{version}.json'
        out.write_text(json.dumps(payload) + '\n')
        print(f'-> {out}  {len(nm)} phonemes, '
              f'{len(payload["rules"]["allophones"]["rules"])}'
              f'+{len(payload["rules"]["frames"]["rules"])} rules, '
              f'{len(payload["wave"])} waveform bytes')


if __name__ == '__main__':
    main()
