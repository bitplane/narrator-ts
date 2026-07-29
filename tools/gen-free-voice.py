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
    # The stress digits sit past the attribute table: the parser matches them
    # by name and peels them off before any attribute lookup.
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
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
    # Every mark that can end a phrase carries bit 25, and several loops in
    # the contour and prosody stages use it as their only stopping condition.
    # The parser appends a dash to every utterance, so this is what terminates
    # them on an input with no punctuation at all.
    ',':  'phrase_break terminator ends_phrase boundary',
    '-':  'terminator ends_phrase boundary',
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


# Where each diphthong's offglide is heading. The continuation slot is a
# segment in its own right, and its quality is the *target's*, not the
# nucleus's -- /aI/ ends in an /I/ however it started.
OFFGLIDE = {'EY': 'front', 'AY': 'front', 'OY': 'front',
            'AW': 'back round', 'OW': 'back round', 'UW': 'back round'}


def continuation(i):
    """The features of an unnamed slot, from what its head is."""
    head = i - 1
    while not NAMES[head]:
        head -= 1
    hf = set(F[NAMES[head]].split())
    which = i - head
    if 'vowel' in hf:
        # An offglide: a vowel of its own, aimed where the diphthong lands.
        return words(f'vowel sonorant voiced {OFFGLIDE.get(NAMES[head], "back")}')
    if 'affricate' in hf:
        # The frication, then its release.
        base = 'consonant fricative velar continuation' if which == 1 else \
               'consonant aspirate continuation'
        if 'voiced' in hf:
            base += ' voiced'
        return words(base)
    # A stop's burst and aspiration. Neither is a closure, so neither is a
    # stop: what they are is a puff of air at the release.
    base = 'consonant aspirate continuation'
    if 'voiced' in hf:
        base += ' voiced voiced_stop'
    return words(base)


def words(spec):
    v = 0
    for f in spec.split():
        v |= 1 << BIT[f]
    return v


def attributes():
    """One longword per phoneme, assembled from the features above."""
    out = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        if not n:
            out[i] = continuation(i)
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
# The first formant carries a vowel. A 6 dB/octave source tilt is what the
# physics gives, but a parallel synthesiser summing three oscillators at equal
# weight is not a vocal tract: the higher resonators have no cascade above
# them to roll off, so they arrive far louder than the same tilt would put
# them in a real spectrum. Doubling the slope is the correction, and the
# result is what the ear expects -- F1 dominant, F2 and F3 colouring it.
#
# Measured rather than argued: at 3.0 the output had 2.7x the zero-crossing
# rate of 33.2's and a spectral centroid 1200 Hz higher, which is what
# "harsh" sounds like.
VOWEL_A1 = 26
TILT = 6.0


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
    'vowel': 26, 'liquid': 25, 'glide': 24, 'nasal': 22,
    'fricative': 14, 'stop': 8, 'aspirate': 12, 'consonant': 20,
}

# The eight noise tables, by place of articulation. Bits 4-6 of the voicing
# byte pick one; bits 0-3 are how loud it is; bit 7 asks for a voiced formant
# to be summed on top, which is what makes /z/ different from /s/.
# Frication is quieter than voicing, and a voiced fricative quieter again --
# the glottis is doing half the work, so the turbulence carries less.
NOISE = {
    'S': (1, 12), 'Z': (1, 6), 'SH': (2, 10), 'ZH': (2, 6),
    'F': (3, 6), 'V': (3, 4), 'TH': (4, 5), 'DH': (4, 4),
    'CH': (2, 10), 'J': (2, 6),
    'P': (5, 7), 'T': (6, 8), 'K': (7, 8),
    'B': (5, 4), 'D': (6, 4), 'G': (7, 4),
    'KX': (7, 8), 'GX': (7, 4), 'KH': (7, 8), 'GH': (7, 4),
    '/H': (4, 5), '/M': (3, 4), '/B': (5, 4), '/R': (5, 4), '/C': (7, 4),
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
                    'stop', 'aspirate', 'consonant'):
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


# ---------------------------------------------------------------------------
# Durations, in frames, stressed and unstressed. A frame is sampfreq x 75 /
# rate / 60 / 2 samples - about 4 ms at the defaults - and hunk+0x1be8 scales
# these by sixteen context rules before anything is spoken, so these are
# intrinsic durations only.
#
# The ordering is Klatt 1976 ("Linguistic uses of segmental duration"): vowels
# longest and low vowels longer than high ones, fricatives next, voiceless
# longer than voiced, stops shortest. Unstressed is roughly a third.
DURATION = {
    'vowel': 22, 'liquid': 11, 'glide': 10, 'nasal': 9,
    'fricative': 14, 'stop': 9, 'aspirate': 10,
    # A flap is the shortest segment in the language: one ballistic tongue
    # contact, 20-30 ms.
    'consonant': 6,
}
LOW_VOWELS = {'AA', 'AE', 'AO', 'AH', 'OH'}
HIGH_VOWELS = {'IY', 'IH', 'IX', 'UW', 'UX'}


def durations():
    st = [0] * COUNT
    un = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        if not n:
            # A continuation slot is a real segment with a real length, and
            # hunk+0x1492 reads it straight out of this table. A zero here is
            # not "no frames" -- hunk+0x15e0's fill loop is `subq` then
            # `dbra`, so it is 65536 of them.
            head = i - 1
            while not NAMES[head]:
                head -= 1
            which = i - head
            hf = set(F[NAMES[head]].split())
            if 'affricate' in hf:
                # The frication that follows the closure, then its release.
                st[i], un[i] = (9, 6) if which == 1 else (5, 2)
            elif 'stop' in hf:
                # Burst and aspiration: one frame each, and hunk+0x1492
                # splits a duration across the pair where it needs more.
                st[i] = un[i] = 1
            else:
                # A diphthong's offglide, shorter than its nucleus.
                st[i] = max(1, round(st[head] * 0.55))
                un[i] = max(1, round(un[head] * 0.55))
            continue
        feats = set(F[n].split())
        base = 0
        for cls in ('vowel', 'liquid', 'glide', 'nasal', 'fricative',
                    'stop', 'aspirate', 'consonant'):
            if cls in feats:
                base = DURATION[cls]
                break
        if n in LOW_VOWELS:
            base += 3
        if n in HIGH_VOWELS:
            base -= 3
        if 'voiced' in feats and 'fricative' in feats:
            base -= 3         # voiced fricatives are shorter
        st[i] = base
        un[i] = max(1, round(base * 0.38))
    # Punctuation is a pause, not a sound. A full stop and a question are the
    # long ones, a comma shorter, a dash shorter still.
    for n, d in (('.', 24), ('?', 24), (',', 36), ('-', 24), ('Q', 10)):
        st[NAMES.index(n)] = un[NAMES.index(n)] = d
    blank = [NAMES[i] or f'<{i}>' for i in range(COUNT)
             if not st[i] and not (F.get(NAMES[i], '') or '').count('unspoken')
             and NAMES[i] not in ('(', ')', ' ')]
    assert not blank, f'zero duration would mean 65536 frames: {blank}'
    return st, un


# ---------------------------------------------------------------------------
# Coarticulation. hunk+0x172a blends the join between two phonemes towards
# whichever *ranks* higher, by the winner's weight in 1/32nds, over the number
# of frames the transition columns allow.
#
# Rank is how much a sound imposes its own shape on its neighbours. A stop or
# a fricative has a definite constriction and holds it; a vowel is the most
# yielding thing in the inventory, which is why a vowel next to a consonant
# takes the consonant's shape at the join and not the other way round.
RANK = {
    'phrase_break': 31, 'stop': 10, 'fricative': 9, 'nasal': 8,
    'liquid': 6, 'glide': 5, 'consonant': 4, 'vowel': 2,
}
WEIGHT = {
    'phrase_break': 16, 'stop': 12, 'fricative': 14, 'nasal': 20,
    'liquid': 18, 'glide': 22, 'consonant': 20, 'vowel': 24,
}


def blending():
    rank = [0] * COUNT
    weight = [0] * COUNT
    tin = [0] * COUNT
    tout = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        key = n or NAMES[i - 1]
        feats = set(F.get(key, '').split())
        for cls, r in RANK.items():
            if cls in feats:
                rank[i], weight[i] = r, WEIGHT[cls]
                break
        # A glide is nothing but transition; a stop is nothing but hold.
        if 'glide' in feats or 'liquid' in feats:
            tin[i], tout[i] = 5, 3
        elif 'vowel' in feats:
            tin[i], tout[i] = 4, 2
        elif 'nasal' in feats:
            tin[i], tout[i] = 4, 1
        elif 'fricative' in feats:
            tin[i], tout[i] = 2, 1
        elif 'stop' in feats:
            tin[i], tout[i] = 2, 0
    return rank, weight, tin, tout


# ---------------------------------------------------------------------------
# Mouth shapes for the lip-sync stream: a width in the low nibble and a height
# in the high one, straight off the articulation.
def mouths():
    out = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        key = n or NAMES[i - 1]
        feats = set(F.get(key, '').split())
        if 'vowel' in feats:
            height = 9 if key in LOW_VOWELS else (3 if key in HIGH_VOWELS else 6)
            width = 3 if 'round' in feats else (9 if 'front' in feats else 6)
        elif 'labial' in feats:
            height, width = 1, 4
        elif 'round' in feats:
            height, width = 3, 3
        elif 'velar' in feats:
            height, width = 4, 6
        else:
            height, width = 3, 7
        out[i] = ((height & 0xf) << 4) | (width & 0xf)
    return out


# ---------------------------------------------------------------------------
# The renderer's own tables.
def gain_curve():
    """32 entries mapping the perceptual amplitude scale onto a linear one.

    Loudness goes roughly as intensity to the 0.3, so the inverse is a power
    curve. Anchored at both ends: silence is silence and full scale is full.
    """
    return [round(31 * (i / 31) ** 2.4) for i in range(32)]


def amp_table():
    """hunk+0x3106: amplitude x waveform, done as a lookup.

    Indexed by (amplitude << 5) | waveform with the waveform read as a signed
    five-bit value. Pure arithmetic - there is only one way to express a
    multiplication table, so this is regenerated rather than reproduced.
    """
    out = []
    for a in range(32):
        for w in range(32):
            sw = w - 32 if w >= 16 else w
            out.append(((a * sw) >> 2) & 0xFF)
    return out


def waveform():
    """hunk+0x4aae: the excitation, as a lookup indexed by phase.

    The renderer holds a phase accumulator per formant and reads this table
    through it, stepping the base pointer once per `waveStep` samples as the
    pitch period runs on. So the table is a resonator's impulse response laid
    out in time: one cycle across each 64-byte window, decaying as the window
    advances, which is what a formant excited by a glottal pulse does.

    The envelope is Rosenberg's (1971) glottal pulse: a rising quarter-cosine
    to the instant of closure, then a faster fall. Values are unsigned five
    bits, which the amplitude table above reads back as signed.
    """
    out = []
    rows = 64
    for row in range(rows):
        t = row / rows
        # Rosenberg: open phase rises, closure is abrupt, then it decays.
        env = math.sin(math.pi * t) ** 1.6 * math.exp(-2.6 * t)
        for ph in range(64):
            v = math.sin(2 * math.pi * ph / 64) * env
            out.append(round(15.5 + 15.5 * v) & 0x1F)
    return out


def fricatives(seed=0x1F2E3D4C):
    """Eight noise tables, one per place of articulation.

    Frication is turbulence at a constriction, so the spectrum is broadband
    but shaped by the cavity in front of it: a short front cavity (alveolar,
    /s/) resonates high, a long one (labial, /f/) is flatter and quieter.
    Modelled as white noise through a one-pole filter, the pole moving from
    low to high across the eight, then quantised the way the device's own are.

    A fixed generator rather than captured noise: reproducible, and nobody's.
    """
    tables = []
    state = seed
    def rnd():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        return (state >> 16) / 32768.0 - 0.5
    for k in range(8):
        # k=0 flat, rising to a high-passed hiss at k=7
        pole = -0.85 + 0.24 * k
        y = 0.0
        raw = []
        for _ in range(480):
            y = pole * y + rnd()
            raw.append(y)
        peak = max(abs(v) for v in raw) or 1.0
        tables.append([max(0, min(255, round(128 + 127 * v / peak)))
                       for v in raw])
    return tables


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
    st, un = durations()
    rank, weight, tin, tout = blending()

    # The second voice. A female tract is about 15% shorter, and formants
    # scale inversely with length (Fant 1966) -- F3 least, since it depends
    # most on the fixed pharyngeal cavity.
    alt = {'f1': [min(255, round(v * 1.17)) for v in f1],
           'f2': [min(255, round(v * 1.17)) for v in f2],
           'f3': [min(255, round(v * 1.10)) for v in f3]}

    out = {
        'version': 'free',
        'source': 'tools/gen-free-voice.py',
        'names': NAMES,
        'attrs': attrs + [0] * (SLOTS - COUNT),
        'params': {'f1': f1, 'f2': f2, 'f3': f3,
                   'a1': a1, 'a2': a2, 'a3': a3, 'voicing': voicing,
                   'rank': rank, 'weight': weight,
                   'transitionIn': tin, 'transitionOut': tout,
                   'mouth': mouths()},
        'paramsAlt': alt,
        'stressed': st,
        'unstressed': un,
        'gain': gain_curve(),
        # No allophonic rules yet. The engine runs without them; what is lost
        # is the contextual variation -- flapped /t/, aspirated stops, the
        # syllabic consonants -- not the ability to speak.
        'rules': {'allophones': {'at': 0, 'bytes': 0, 'rules': []},
                  'frames': {'at': 0, 'bytes': 0, 'rules': []}},
        'wave': waveform(),
        'amp': amp_table(),
        'fricatives': fricatives(),
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
