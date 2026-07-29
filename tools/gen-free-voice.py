#!/usr/bin/env python3
"""Build a voice from published phonetics, owing nothing to Commodore.

The library takes its tables as an argument. This writes a set nobody needs
permission for, so the package can ship speaking. It is the narrator's
counterpart to gen-nrl-table.py, and it holds to the same rule:

    Measurements come from the literature, cited at the point of use.
    Structure comes from principle, with the reasoning written down.
    No number is ever copied out of an extracted table.

The result will not be byte-identical to 33.2 and is not trying to be.
Where it lands is measured by tools/voice-diff.py rather than asserted.

    gen-free-voice.py -o reference/voice-free.json

The phoneme *inventory* and the attribute bits are not free choices: they are
the interface, and the ported code reads them. Those are documented in the
narrator.device autodocs and in research/02-narrator.md.
"""
import argparse
import json
import math
from pathlib import Path

# ---------------------------------------------------------------------------
# The frame's frequency columns are phase increments. The renderer advances a
# 10-bit accumulator by the increment and emits two samples per advance, so a
# frequency in Hz converts as below. See tools/formants.py.
PERIOD_NUMERATOR = 0x369C78
PAL_CLOCK = 3546895
SAMPFREQ = 22200
RATE = PAL_CLOCK / (PERIOD_NUMERATOR // SAMPFREQ)


def inc(hz, third=False):
    """Hz to a phase increment, clamped to the byte the frame holds."""
    v = round(hz * (1024 if third else 2048) / RATE)
    return max(0, min(255, v))


# ---------------------------------------------------------------------------
# The inventory, in the order the device's tables are indexed. Names are the
# interface; two characters, blank for a continuation slot.
NAMES = [
    ' ', '.', '?', ',', '-', '(', ')', '', '',
    'IY', 'IH', 'EH', 'AE', 'AA', 'AH', 'AO', 'UH', 'AX', 'IX', 'ER', 'UX',
    'QX', 'OH', 'RX', 'LX',
    'EY', '', 'AY', '', 'OY', '', 'AW', '', 'OW', '', 'UW', '',
    'WH', 'R', 'L', 'W', 'Y',
    'M', 'N', 'NX', 'NH', 'DX', 'Q',
    'S', 'SH', 'F', 'TH', 'Z', 'ZH', 'V', 'DH',
    'CH', '', '', 'J', '',
    '/H', '/M', '/B', '/R', '/C',
    'B', '', '', 'D', '', '', 'G', '', '', 'GX', '', '', 'GH', '', '',
    'P', '', '', 'T', '', '', 'K', '', '', 'KX', '', '', 'KH', '', '',
    'UL', 'UM', 'UN', 'IL', 'IM', 'IN',
]
COUNT = 102          # entries with attributes and parameters
SLOTS = len(NAMES)   # 112, including the ten stress digits past the end

# ---------------------------------------------------------------------------
# Formant targets in Hz.
#
# The ten monophthongs are Peterson & Barney 1952 Table II, adult male means
# (reference/formants.json). The rest are the canonical values every
# phonetics text gives for the same speaker population:
#
#   AX  the neutral tract - a uniform tube resonates at odd multiples of
#       c/4L, which for a 17.5cm male tract is 500, 1500, 2500.
#   IX  a reduced /I/, half way from IH to AX.
#   UX  fronted /u/, F2 raised towards the palatal region.
#   OH  between AO and AA.
#   RX  syllabic /r/, which is ER.
#   LX  syllabic dark /l/ - velarised, so F2 low.
#   QX  the parser's silent lead-in. Neutral, and silent.
#
# A diphthong is two entries: the nucleus, then the continuation slot after it
# holding the offglide target. Their nuclei are the corresponding monophthongs
# and their glides run to /I/ or /U/ position.
VOWELS = {
    'IY': (270, 2290, 3010), 'IH': (390, 1990, 2550), 'EH': (530, 1840, 2480),
    'AE': (660, 1720, 2410), 'AA': (730, 1090, 2440), 'AH': (640, 1190, 2390),
    'AO': (570, 840, 2410), 'UH': (440, 1020, 2240), 'UW': (300, 870, 2240),
    'ER': (490, 1350, 1690),
    'AX': (500, 1500, 2500), 'IX': (440, 1750, 2500), 'UX': (300, 1600, 2200),
    'OH': (590, 920, 2410), 'RX': (490, 1350, 1690), 'LX': (360, 800, 2500),
    'QX': (500, 1500, 2500),
}

# Nucleus, then offglide, for the six two-slot vowels.
DIPHTHONGS = {
    'EY': ((530, 1840, 2480), (350, 2200, 2900)),
    'AY': ((730, 1090, 2440), (350, 2100, 2800)),
    'OY': ((570, 840, 2410), (350, 2100, 2800)),
    'AW': ((730, 1090, 2440), (330, 900, 2300)),
    'OW': ((570, 900, 2410), (330, 870, 2240)),
    'UW': ((320, 1000, 2240), (300, 870, 2240)),
}

# Syllabic consonants, which the first rewrite pass expands - but hunk+0x2ae0
# reads four of these rows for the nasal murmur, so they carry real values.
# A nasal murmur is a low first formant with the tract's zeros damping
# everything above it: Fujimura 1962.
SYLLABIC = {
    'UL': (360, 800, 2500), 'UM': (280, 900, 2200), 'UN': (280, 1300, 2500),
    'IL': (360, 850, 2500), 'IM': (280, 900, 2200), 'IN': (280, 1300, 2500),
}

# ---------------------------------------------------------------------------
# Consonants. Formant *loci* - the target the transitions point at, which is
# what a listener reads place of articulation from (Delattre, Liberman and
# Cooper 1955). F1 is low for every consonant because the tract is
# constricted; what varies is F2.
#
#   labial      F2 locus ~ 700-800    B P M F V /B
#   alveolar    F2 locus ~ 1700-1800  D T N S Z TH DH L /R
#   palatal     F2 locus ~ 2000-2200  SH ZH CH J Y
#   velar       F2 locus ~ 1200-3000  G K NX, pinned near F3 for front vowels
#   glottal     no oral constriction  /H Q
CONSONANTS = {
    # nasals: Fujimura 1962 - F1 ~ 250-300, and the antiformant kills F2/F3
    'M':  (280, 900, 2200), 'N':  (280, 1700, 2600), 'NX': (280, 2100, 2800),
    'NH': (280, 1700, 2600),
    # liquids and glides: Lehiste 1964, O'Connor et al. 1957
    'R':  (330, 1050, 1600), 'L':  (360, 800, 2500),
    'W':  (300, 610, 2150), 'WH': (300, 610, 2150), 'Y': (280, 2200, 3000),
    # voiced fricatives
    'V':  (300, 1000, 2400), 'DH': (300, 1400, 2500),
    'Z':  (300, 1700, 2600), 'ZH': (300, 2000, 2600),
    # voiceless fricatives: same places, no voice bar
    'F':  (300, 1000, 2400), 'TH': (300, 1400, 2500),
    'S':  (300, 1700, 2600), 'SH': (300, 2000, 2600),
    # stops, at the closure
    'B':  (280, 800, 2200), 'D':  (280, 1700, 2600), 'G':  (280, 2000, 2600),
    'P':  (280, 800, 2200), 'T':  (280, 1700, 2600), 'K':  (280, 2000, 2600),
    'GX': (280, 1400, 2400), 'KX': (280, 1400, 2400),
    'GH': (280, 1000, 2200), 'KH': (280, 1000, 2200),
    'DX': (280, 1700, 2600),
    # affricates take their stop's locus
    'CH': (280, 2000, 2600), 'J':  (280, 2000, 2600),
    # glottal: no oral constriction, so the tract stays neutral
    '/H': (500, 1500, 2500), 'Q': (0, 0, 0),
    # the five aspirated onsets, coloured by what follows
    '/M': (280, 900, 2200), '/B': (280, 800, 2200), '/R': (330, 1050, 1600),
    '/C': (280, 2000, 2600),
}


# ---------------------------------------------------------------------------
# Attribute bits. These are not a free choice - the ported code reads them by
# number, and research/02-narrator.md records which stage reads which. They
# are assembled here from phonetic features rather than listed per phoneme, so
# that each one is a consequence of something true about the sound.
BIT = {
    'vowel': 0, 'consonant': 1, 'sonorant': 2,
    'front': 3, 'mid': 4, 'back': 5, 'round': 6,
    'diphthong': 7, 'stop': 8, 'voiced': 9,
    'voiced_stop': 10, 'voiceless_stop': 11, 'fricative': 12,
    'aspirate': 13, 'affricate': 14, 'liquid': 15, 'nasal': 16, 'glide': 17,
    'alveolar': 18, 'phrase_break': 19, 'unspoken': 20, 'continuation': 21,
    'terminator': 22, 'labial': 23, 'velar': 24, 'ends_phrase': 25,
    'boundary': 26,
}

# One line per phoneme: the features that are true of it.
F = {
    ' ':  'unspoken boundary',
    '.':  'phrase_break terminator ends_phrase boundary',
    '?':  'phrase_break terminator ends_phrase boundary',
    ',':  'phrase_break terminator boundary',
    '-':  'terminator boundary',
    '(':  'unspoken', ')': 'unspoken',
    # vowels, by tongue position and rounding
    'IY': 'vowel sonorant voiced front',   'IH': 'vowel sonorant voiced front',
    'IX': 'vowel sonorant voiced front',
    'EH': 'vowel sonorant voiced mid',     'AE': 'vowel sonorant voiced mid',
    'AA': 'vowel sonorant voiced mid',     'ER': 'vowel sonorant voiced mid',
    'QX': 'vowel sonorant voiced mid',
    'AH': 'vowel sonorant voiced back',    'AO': 'vowel sonorant voiced back',
    'UH': 'vowel sonorant voiced back',    'AX': 'vowel sonorant voiced back',
    'OH': 'vowel sonorant voiced back round',
    'UX': 'vowel sonorant voiced back round diphthong',
    'UW': 'vowel sonorant voiced back round diphthong',
    'RX': 'vowel sonorant voiced mid liquid',
    'LX': 'vowel sonorant voiced mid liquid',
    'EY': 'vowel sonorant voiced front diphthong',
    'AY': 'vowel sonorant voiced mid diphthong',
    'AW': 'vowel sonorant voiced mid diphthong',
    'OY': 'vowel sonorant voiced back diphthong',
    'OW': 'vowel sonorant voiced back diphthong',
    # sonorant consonants
    'R':  'consonant sonorant voiced liquid',
    'L':  'consonant sonorant voiced liquid alveolar',
    'W':  'consonant sonorant voiced glide back round',
    'WH': 'consonant sonorant voiced glide back round',
    'Y':  'consonant sonorant voiced glide front',
    'M':  'consonant sonorant voiced nasal stop labial',
    'N':  'consonant sonorant voiced nasal stop alveolar',
    'NX': 'consonant sonorant voiced nasal stop front velar',
    'NH': 'consonant sonorant voiced nasal stop velar',
    # fricatives; the voiced ones are sonorant enough for hunk+0x2bc6
    'S':  'consonant fricative mid alveolar',
    'SH': 'consonant fricative velar',
    'F':  'consonant fricative labial',
    'TH': 'consonant fricative alveolar',
    'Z':  'consonant sonorant voiced fricative alveolar',
    'ZH': 'consonant sonorant voiced fricative velar',
    'V':  'consonant sonorant voiced fricative labial',
    'DH': 'consonant sonorant voiced fricative alveolar',
    # affricates
    'CH': 'consonant stop voiceless_stop affricate velar',
    'J':  'consonant stop voiced fricative affricate velar',
    # stops
    'B':  'consonant stop voiced voiced_stop labial',
    'D':  'consonant stop voiced voiced_stop alveolar',
    'G':  'consonant stop voiced voiced_stop velar',
    'GX': 'consonant stop voiced voiced_stop velar',
    'GH': 'consonant stop voiced voiced_stop velar',
    'P':  'consonant stop voiceless_stop labial',
    'T':  'consonant stop voiceless_stop alveolar',
    'K':  'consonant stop voiceless_stop velar',
    'KX': 'consonant stop voiceless_stop velar',
    'KH': 'consonant stop voiceless_stop velar',
    'DX': 'consonant voiced alveolar',
    'Q':  'consonant stop terminator',
    # aspirated onsets, which rewrite pass 1 turns into a stop plus a puff
    '/H': 'consonant aspirate front', '/M': 'consonant aspirate mid',
    '/B': 'consonant aspirate back',  '/R': 'consonant aspirate back round',
    '/C': 'consonant aspirate back',
    # syllabic consonants, expanded by rewrite pass 1
    'UL': 'vowel sonorant voiced mid', 'UM': 'vowel sonorant voiced mid',
    'UN': 'vowel sonorant voiced mid', 'IL': 'vowel sonorant voiced front',
    'IM': 'vowel sonorant voiced front', 'IN': 'vowel sonorant voiced front',
}


def attributes():
    """One longword per phoneme, assembled from the features above."""
    out = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        if not n:
            # A continuation slot inherits its head's features and adds its
            # own bit, which is what hunk+0x1492 tests to give it a duration.
            out[i] = out[i - 1] | (1 << BIT['continuation'])
            # It is not itself a diphthong head.
            out[i] &= ~(1 << BIT['diphthong'])
            continue
        for f in F[n].split():
            out[i] |= 1 << BIT[f]
    return out


# ---------------------------------------------------------------------------
# Formant amplitudes, 0-31, which hunk+0x2d1c then puts through a convex gain
# curve - so this scale is perceptual and roughly logarithmic already.
#
# In a parallel formant synthesiser each resonator is driven separately, so
# the amplitudes carry the spectral tilt that a cascade would get for free.
# The glottal source falls about 12 dB/octave and radiation from the lips adds
# 6, leaving a net 6 dB/octave: each doubling of frequency costs roughly a
# quarter of the scale. That is the model below, and it is the one number here
# most in need of an ear rather than an argument.
VOWEL_A1 = 26
TILT = 3.0


def amplitudes(f1_hz, f2_hz, f3_hz, top=VOWEL_A1):
    """Relative amplitudes for a formant triple, in the device's 0-31 units."""
    if not f1_hz:
        return 0, 0, 0
    a = [top, 0, 0]
    for k, hz in enumerate((f2_hz, f3_hz), start=1):
        a[k] = max(0, min(31, round(top - TILT * math.log2(hz / f1_hz))))
    return tuple(a)


# How loud each class is overall. A vowel is the reference; a nasal loses
# most of its energy to the antiformant of the closed oral cavity; a stop at
# closure is silence, and the burst is a separate slot.
LOUDNESS = {
    'vowel': 26, 'liquid': 24, 'glide': 22, 'nasal': 16,
    'fricative': 10, 'stop': 4, 'aspirate': 8,
}

# The eight noise tables, by place of articulation. Bits 4-6 of the voicing
# byte pick one; bits 0-3 are how loud it is; bit 7 asks for a voiced formant
# to be summed on top, which is what makes /z/ different from /s/.
NOISE = {
    'S': (1, 13), 'Z': (1, 11), 'SH': (2, 14), 'ZH': (2, 11),
    'F': (3, 8), 'V': (3, 7), 'TH': (4, 7), 'DH': (4, 6),
    'CH': (2, 14), 'J': (2, 11),
    'P': (5, 9), 'T': (6, 11), 'K': (7, 11),
    'B': (5, 5), 'D': (6, 6), 'G': (7, 6),
    'KX': (7, 11), 'GX': (7, 6), 'KH': (7, 11), 'GH': (7, 6),
    '/H': (4, 6), '/M': (3, 6), '/B': (5, 6), '/R': (5, 6), '/C': (7, 6),
}


def voice_and_amps(f1, f2, f3):
    """The three amplitude columns and the voicing byte, per phoneme."""
    a1 = [0] * COUNT
    a2 = [0] * COUNT
    a3 = [0] * COUNT
    voicing = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        feats = set(F.get(n, '').split()) if n else set()
        if not n and i:
            feats = set(F.get(NAMES[i - 1], '').split())
        top = 0
        for cls in ('vowel', 'liquid', 'glide', 'nasal', 'fricative',
                    'stop', 'aspirate'):
            if cls in feats:
                top = LOUDNESS[cls]
                break
        if f1[i]:
            hz = (f1[i], f2[i], f3[i] * 2)
            back = tuple(v * RATE / 2048 for v in hz)
            a1[i], a2[i], a3[i] = amplitudes(*back, top=top)
        # A nasal's oral cavity is closed, so the antiformant flattens
        # everything above the murmur.
        if 'nasal' in feats:
            a2[i] = max(0, a2[i] - 8)
            a3[i] = max(0, a3[i] - 10)

        key = n or NAMES[i - 1]
        if key in NOISE:
            table, level = NOISE[key]
            voicing[i] = (table << 4) | level
            if 'voiced' in feats:
                voicing[i] |= 0x80
    return a1, a2, a3, voicing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='reference/voice-free.json')
    args = ap.parse_args()

    f1 = [0] * COUNT
    f2 = [0] * COUNT
    f3 = [0] * COUNT

    def put(name, hz, at=None):
        i = NAMES.index(name) if at is None else at
        f1[i], f2[i], f3[i] = inc(hz[0]), inc(hz[1]), inc(hz[2], True)

    for n, hz in VOWELS.items():
        put(n, hz)
    for n, (nucleus, glide) in DIPHTHONGS.items():
        i = NAMES.index(n)
        put(n, nucleus)
        put(n, glide, at=i + 1)          # the continuation slot
    for n, hz in SYLLABIC.items():
        put(n, hz)
    for n, hz in CONSONANTS.items():
        put(n, hz)

    attrs = attributes()
    a1, a2, a3, voicing = voice_and_amps(f1, f2, f3)

    out = {
        'version': 'free',
        'source': 'tools/gen-free-voice.py',
        'names': NAMES,
        'attrs': attrs + [0] * (SLOTS - COUNT),
        'params': {'f1': f1, 'f2': f2, 'f3': f3,
                   'a1': a1, 'a2': a2, 'a3': a3, 'voicing': voicing},
    }
    Path(args.out).write_text(json.dumps(out, indent=1) + '\n')
    print(f'-> {args.out}')
    named = sum(1 for i, n in enumerate(NAMES[:COUNT]) if n and f1[i])
    print(f'   {named} phonemes given formants')
    blank = [n for i, n in enumerate(NAMES[:COUNT]) if n and not f1[i]]
    if blank:
        print(f'   still blank: {" ".join(blank)}')


if __name__ == '__main__':
    main()
