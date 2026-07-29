#!/usr/bin/env python3
"""Score a voice by asking a speech recogniser what it heard.

Texture measurements say whether a voice sounds like 33.2. They do not say
whether it can be understood, and those turned out to be very different
questions -- the free voice matched 33.2 to within a few percent on every
axis tools/voice-texture.py measures while scoring a fifth of its words.

Each word goes inside a carrier phrase, as every intelligibility test since
Egan (1948) does: the listener knows where the word is, has context either
side of it, and the clip is long enough not to be dismissed as a blank. Only
the target counts.

Needs a local Whisper server -- whisper.cpp's `whisper-server`, or anything
answering the same OpenAI transcription endpoint:

    tools/intelligibility.py --render        # rebuild the clips first
    tools/intelligibility.py --diff          # which words 33.2 gets and this does not

The absolute number is a property of the recogniser as much as the voice, so
compare voices rather than reading it alone. 33.2 sets the bar.
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARRIER = 'now say the word {} again'
CARRIER_WORDS = set(CARRIER.format('').split())
URL = 'http://127.0.0.1:8000/v1/audio/transcriptions'


def heard(path, tag):
    tmp = f'/tmp/_intel_{tag}.wav'
    subprocess.run(['sox', str(path), '-r', '16000', '-c', '1', '-b', '16', tmp],
                   check=True, capture_output=True)
    r = subprocess.run(['curl', '-s', '--max-time', '180', '-X', 'POST',
                        '-F', f'file=@{tmp}', URL], capture_output=True, text=True)
    os.unlink(tmp)
    try:
        return re.sub(r'[^a-z ]', ' ', json.loads(r.stdout)['text'].lower()).split()
    except Exception:
        return []


def score(d):
    rows = [l.split('\t') for l in (d / 'index.tsv').read_text().splitlines()]
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        got = list(ex.map(lambda a: heard(d / f'{a[1][0]}.wav', f'{d.name}{a[0]}'),
                          enumerate(rows)))
    return {w: (w in g, ' '.join(x for x in g if x not in CARRIER_WORDS) or '-')
            for (_, w, _), g in zip(rows, got)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dirs', nargs='*', default=['/tmp/wl-amiga', '/tmp/wl-free'])
    ap.add_argument('--diff', action='store_true',
                    help='list what the first gets and the second does not')
    args = ap.parse_args()
    res = {d: score(Path(d)) for d in args.dirs}
    for d, r in res.items():
        hit = sum(1 for v in r.values() if v[0])
        print(f'{d:24} {hit:3}/{len(r)} = {100 * hit / len(r):3.0f}%')
    if args.diff and len(args.dirs) > 1:
        a, b = res[args.dirs[0]], res[args.dirs[1]]
        lost = [w for w in a if a[w][0] and not b[w][0]]
        print(f'\n{len(lost)} words the first gets and the second does not:')
        for w in lost:
            print(f'   {w:10} heard as {b[w][1]}')


if __name__ == '__main__':
    main()
