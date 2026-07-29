#!/usr/bin/env python3
"""Compare two renderings by texture rather than by sample.

A free voice cannot be diffed against the device byte for byte, so the
question "does it sound like it" needs numbers of a different kind. These
four separate a harsh voice from a warm one:

    centroid     where the energy sits, in Hz
    >4 kHz       how much of it is up in the hiss
    roughness    mean sample-to-sample step over mean level
    zero-x       crossings per second, which tracks the loudest formant

    npm run say -- 'hello world' -o /tmp/free.wav
    npm run say -- 'hello world' -o /tmp/amiga.wav -V 33.2
    python3 tools/voice-texture.py /tmp/amiga.wav /tmp/free.wav
"""
import sys
import wave

import numpy as np


def texture(path):
    w = wave.open(path)
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.uint8).astype(float) - 128
    sr = w.getframerate()
    X = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    f = np.fft.rfftfreq(len(x), 1 / sr)
    return {
        'centroid': (f * X).sum() / X.sum(),
        'hi': X[f > 4000].sum() / X.sum() * 100,
        'rough': np.abs(np.diff(x)).mean() / (np.abs(x).mean() + 1e-9),
        'zerox': ((x[:-1] * x[1:]) < 0).mean() * sr / 2,
        'rms': np.sqrt((x * x).mean()),
    }


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    print(f'  {"":24} {"centroid":>9} {">4kHz":>7} {"rough":>7} '
          f'{"zero-x":>8} {"rms":>6}')
    for path in sys.argv[1:]:
        t = texture(path)
        print(f'  {path:24} {t["centroid"]:8.0f}  {t["hi"]:6.1f}% '
              f'{t["rough"]:7.2f} {t["zerox"]:7.0f}  {t["rms"]:5.1f}')


if __name__ == '__main__':
    main()
