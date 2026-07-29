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
# The bottom of `narrator_rb.pitch`, 65..320 Hz. The excitation has to last a
# period at the lowest pitch the device will accept -- see waveform().
MIN_PITCH = 65
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

# QX is a placeholder, not a sound. The pitch stage seeds a slot with it
# before every scan (hunk+0x14c2, research/02-narrator.md), so it turns up at
# the head of utterances that never asked for it -- it has to be silent or
# everything starts with a buzz. It keeps a vowel's attributes and duration,
# because that is the role it plays for the stages upstream, and loses only
# its amplitudes.
SILENT = {'QX'}

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
# Formant amplitudes.
#
# The stored value is five bits and hunk+0x2d1c puts it through the gain curve
# below before the renderer multiplies by it, so this scale is a *control*
# scale and the curve decides what it means. Making it decibels is forced by
# the arithmetic: the thing being controlled is a linear 5-bit multiplier, so
# the widest range expressible is 20.log10(31/1) = 30 dB, and 31 steps across
# it is 0.97 dB a step. Loudness is logarithmic anyway (Fechner), so an even
# decibel scale is also the one that spends its steps where the ear can hear
# the difference.
DB_PER_STEP = 30 / 31

# Klatt (1980) default formant bandwidths for a male voice, in Hz.
BANDWIDTH = (50, 70, 110)


# The tract's poles above F3. A uniform tube resonates at odd multiples of
# c/4L -- 500, 1500, 2500 for the 17.5 cm male tract already used for AX -- so
# the series carries on 3500, 4500, 5500 and up. They are fixed: articulation
# moves the first three and leaves the rest near neutral.
HIGHER_POLES = [500 + 1000 * k for k in range(3, 40)]


def formant_levels(f1_hz, f2_hz, f3_hz):
    """Peak level of each formant, in dB relative to the first.

    A parallel synthesiser drives each resonator separately and sums them, so
    these amplitudes have to carry the spectral shape a cascade produces on
    its own. That shape is the pole product of Fant's source-filter theory
    (1960), evaluated at each formant in turn:

      * the resonance's own peak is F/B, and bandwidth grows with frequency,
        so the higher formants are broader and lower for it (Klatt's 1980
        male defaults, 50, 70 and 110 Hz);
      * every other pole contributes |Fk^2 / (Fk^2 - Fn^2)| -- attenuation
        from the ones below, and a lift from the ones above. Formants that
        sit close together raise each other, which is why /IY/'s F2 is strong
        despite being three octaves up: F3 is right next to it.
      * the source falls about 12 dB/octave and radiation from the lips adds
        6, leaving a net 6 dB/octave tilt across the lot.

    NOTE: the poles above F3 are not optional. Truncating the product at
    three keeps all the attenuation from below and drops the lift from above,
    which costs 20 dB at F3 and puts /IY/'s F2 below the floor -- the vowel
    loses the formant that identifies it. Carried to convergence instead, the
    model lands 2.9 dB from 33.2's own table on average, against 3.7 dB for
    the uniform-tube approximation that says all peaks are equal.
    """
    fs = (f1_hz, f2_hz, f3_hz)
    poles = list(fs) + HIGHER_POLES
    out = []
    for n, fn in enumerate(fs):
        gain = fn / BANDWIDTH[n]
        for k, fk in enumerate(poles):
            if k != n:
                gain *= abs(fk * fk / (fk * fk - fn * fn))
        out.append(20 * math.log10(gain) - 6 * math.log2(fn / f1_hz))
    return [db - out[0] for db in out]


def amplitudes(f1_hz, f2_hz, f3_hz, top):
    """The three stored amplitudes for a formant triple.

    `top` is how far below full scale the loudest formant sits, in dB.

    A formant that exists is never given zero. The control scale runs out at
    30 dB and the model asks for more than that on the back vowels -- it puts
    /AH/'s third formant 26 dB under its first, and once the first is
    anywhere below full scale that rounds to nothing. Silence is not a quiet
    formant: this synthesiser has three oscillators and no cascade, so F3 is
    the *only* thing above F2, and switching it off empties the spectrum from
    2 kHz up. It is audible as a vowel you cannot place. 33.2 keeps its own
    third formant at 1 to 5 on exactly the vowels this model wants to zero.
    """
    if not f1_hz:
        return 0, 0, 0
    return tuple(max(1 if hz else 0, min(31, round(31 + (top + db) / DB_PER_STEP)))
                 for hz, db in zip((f1_hz, f2_hz, f3_hz),
                                   formant_levels(f1_hz, f2_hz, f3_hz)))


# How loud each class is, in dB below full scale.
#
# What this sets is the level of the *loudest formant*, and for anything
# voiced that is the glottal source arriving at F1 -- so every sonorant gets
# the same number. A nasal is not a quiet vowel: its murmur has a first
# formant as strong as any, and what the antiformant of the closed oral
# cavity takes away is everything above it (Fujimura 1962), which is applied
# separately. A liquid or a glide is a vowel with a different tongue. Rating
# them by Fletcher's *segment powers* -- which is what this table used to do
# -- confuses total energy over a short segment with the level of the source,
# and pulls F1 down by 6 to 11 dB across two thirds of running speech.
#
# The obstruents are genuinely quieter, because their source is turbulence at
# a constriction rather than the glottis. There the ordering is Fletcher's:
# *Speech and Hearing in Communication* (1953), after Sacia and Beck (1926).
LOUDNESS = {
    'vowel': -5, 'liquid': -5, 'glide': -5, 'nasal': -5,
    'fricative': -24, 'stop': -30, 'aspirate': -28, 'consonant': -18,
}

# The exception, and it is a big one. hunk+0x2ae0 does not render a nasal from
# the nasal's own row: it copies a *murmur* row over all six parameter bytes
# of every frame, /M/ taking UL's, /N/ UM's and /NX/ UN's. So those rows are
# what a nasal actually sounds like, and giving them a sonorant's level -- as
# their own attributes ask for, since a syllabic consonant is a vowel -- puts
# every nasal in the language at full vowel loudness.
#
# A murmur is not that. The oral cavity is shut, so all of it radiates through
# the nose, and the nasal tract is long, soft-walled and lossy: heavily damped
# and well below the vowels either side (Fujimura 1962).
MURMUR = -18

# The eight noise tables, by place of articulation. Bits 4-6 of the voicing
# byte pick one; bits 0-3 are how loud it is; bit 7 asks for a voiced formant
# to be summed on top, which is what makes /z/ different from /s/.
# Frication is quieter than voicing, and a voiced fricative quieter again --
# the glottis is doing half the work, so the turbulence carries less.
#
# Only the continuants are here. A stop or an affricate is silent where it is
# named -- see RELEASE.
NOISE = {
    'S': (1, 12), 'Z': (1, 6), 'SH': (2, 10), 'ZH': (2, 6),
    'F': (3, 6), 'V': (3, 4), 'TH': (4, 5), 'DH': (4, 4),
    '/H': (0, 5), '/M': (0, 4), '/B': (0, 4), '/R': (0, 4), '/C': (0, 4),
}

# What the slots of a multi-slot consonant are. The head is the *closure*, and
# a closure is silence -- that is the whole of what makes a stop a stop, and
# putting frication there turns /CH/ into /SH/ and takes the stop out of every
# stop. The sound is in the slots the frame rules append after it:
#
#   burst        the transient at release, at the closure's own place
#   aspiration   the puff of glottal noise after a voiceless release, which is
#                what /S/ deletes in "spin" (Lisker and Abramson 1964)
#   frication    an affricate's release is held rather than transient -- that
#                is the difference between /T SH/ and /CH/
#   voicing      a voiced release has no aspiration; the cords are already on
#
# The place table each burst uses is its own; aspiration is noise at the
# glottis shaped by an open tract, so it takes the diffuse table.
RELEASE = {
    'P':  ('closure', 'burst', 'aspiration'),
    'T':  ('closure', 'burst', 'aspiration'),
    'K':  ('closure', 'burst', 'aspiration'),
    'KX': ('closure', 'burst', 'aspiration'),
    'KH': ('closure', 'burst', 'aspiration'),
    'B':  ('closure', 'burst', 'voicing'),
    'D':  ('closure', 'burst', 'voicing'),
    'G':  ('closure', 'burst', 'voicing'),
    'GX': ('closure', 'burst', 'voicing'),
    'GH': ('closure', 'burst', 'voicing'),
    'CH': ('closure', 'frication', 'aspiration'),
    'J':  ('closure', 'frication'),
}

# Which of the eight tables each place bursts through.
BURST_TABLE = {'P': 5, 'B': 5, 'T': 6, 'D': 6, 'K': 7, 'G': 7,
               'KX': 7, 'GX': 7, 'KH': 7, 'GH': 7, 'CH': 2, 'J': 2}

# Level of each role, on the voicing byte's 4-bit linear scale. A voiced
# release is quieter than a voiceless one throughout: the glottis is doing
# half the work, so less of the airflow is left to go turbulent.
ROLE_LEVEL = {'closure': 0, 'burst': 7, 'aspiration': 4,
              'frication': 10, 'voicing': 0}

# How loud the tract is in each role, in dB below full scale. A voiceless
# closure is silent; everything after it is on its way back to a vowel. A
# voiced closure is not silent -- the cords keep going behind it, and the
# low-frequency voice bar that leaks through the walls is the cue that tells
# /b/ from /p/ when there is no release to hear.
ROLE_LOUDNESS = {'closure': LOUDNESS['stop'], 'burst': -16,
                 'aspiration': -14, 'frication': -20, 'voicing': -12}
VOICE_BAR = -23


def _head(i):
    """The named slot this one belongs to, and how far into it this is."""
    at = i
    while at >= 0 and not NAMES[at]:
        at -= 1
    return NAMES[at] if at >= 0 else '', i - at


def voice_and_amps(f1, f2, f3):
    """The three amplitude columns and the voicing byte, per phoneme."""
    a1 = [0] * COUNT
    a2 = [0] * COUNT
    a3 = [0] * COUNT
    voicing = [0] * COUNT
    for i, n in enumerate(NAMES[:COUNT]):
        head, which = _head(i)
        feats = set(F.get(head, '').split()) if head else set()
        top = LOUDNESS['consonant']
        for cls in ('vowel', 'liquid', 'glide', 'nasal', 'fricative',
                    'stop', 'aspirate', 'consonant'):
            if cls in feats:
                top = LOUDNESS[cls]
                break
        # A release is not a closure, so it is not as quiet as one. What the
        # amplitude does there is set the level the transition into the next
        # phoneme interpolates *from*; leave it at a stop's own level and the
        # vowel after every stop starts from silence.
        if head in RELEASE and which < len(RELEASE[head]):
            role = RELEASE[head][which]
            top = ROLE_LOUDNESS[role]
            if role == 'closure' and 'voiced' in feats:
                top = VOICE_BAR
        murmur = head in SYLLABIC
        if murmur:
            top = MURMUR
        if f1[i]:
            hz = (f1[i], f2[i], f3[i] * 2)
            back = tuple(v * RATE / 2048 for v in hz)
            a1[i], a2[i], a3[i] = amplitudes(*back, top=top)
        # A voiceless continuant has no glottal source, so there is nothing for
        # a formant amplitude to scale -- all of its sound is the noise table.
        # The renderer only silences the voiced branch on a frame that is
        # already fully unvoiced (0x558c), so leaving these set buzzes through
        # every transition into and out of the fricative. Stops keep theirs:
        # a release burst does excite the tract, and that is what the voicing
        # byte's bit 7 is for.
        if (feats & {'fricative', 'aspirate'} and 'voiced' not in feats
                and 'continuation' not in feats):
            a1[i] = a2[i] = a3[i] = 0
        if (n or NAMES[i - 1]) in SILENT:
            a1[i] = a2[i] = a3[i] = 0
        # A nasal's oral cavity is closed, so the antiformant flattens
        # everything above the murmur (Fujimura 1962).
        if 'nasal' in feats or murmur:
            a2[i] = max(0, a2[i] - round(8 / DB_PER_STEP))
            a3[i] = max(0, a3[i] - round(10 / DB_PER_STEP))

        head, which = _head(i)
        if head in RELEASE:
            roles = RELEASE[head]
            if which >= len(roles):
                continue
            role = roles[which]
            voiced = 'voiced' in set(F[head].split())
            level = ROLE_LEVEL[role]
            if voiced:
                level = max(0, level - 3)
            if level:
                table = 0 if role == 'aspiration' else BURST_TABLE[head]
                voicing[i] = (table << 4) | level
                if voiced:
                    voicing[i] |= 0x80
            if role == 'closure' and not voiced:
                a1[i] = a2[i] = a3[i] = 0
        elif (n or NAMES[i - 1]) in NOISE:
            table, level = NOISE[n or NAMES[i - 1]]
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
    """hunk+0x2cfc: 32 entries turning the control scale into a multiplier.

    The control scale is decibels -- see DB_PER_STEP -- so this is the
    antilog. Zero is silence rather than -30 dB, because the scale has to be
    able to switch a formant off; every other step is at least 1, because a
    multiplier of 0 is silence and there is nothing between them.
    """
    return [0] + [max(1, round(31 * 10 ** (-(31 - i) * DB_PER_STEP / 20)))
                  for i in range(1, 32)]


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
    """hunk+0x4aae: the excitation, as 64 windows of 64 entries.

    Each formant has its own phase accumulator, and the renderer reads this
    table at `base + phase` — so one 64-byte window is a single cycle of that
    formant's output. The base steps on by 0x40 every `waveStep` sample pairs
    and resets to zero at each glottal pulse (render.ts `pitchPulse`), which
    makes the window index time-within-the-pitch-period. The amplitude of the
    cycle in window n is therefore the formant's envelope n steps after
    closure.

    The pulse resets at the glottal *opening*, so a window holds both halves
    of what a formant is doing, and the envelope is their sum:

      * the ring-down of the previous pulse, exp(-pi.B.t) at Klatt's (1980)
        narrowest male bandwidth -- narrowest because one table serves all
        three formants, and an envelope that decays faster than the slowest
        of them cuts that one off early with nothing here to sustain it;
      * the flow of the open phase now underway, which Rosenberg (1971)
        models as a raised cosine rising to the instant of closure.

    Nothing here is a filter -- the oscillator is a table read -- so the
    envelope has to carry both. A decay alone leaves the second half of every
    period nearly silent, which is peaky enough to force the whole voice's
    level down to stay inside eight bits.

    How long the rise is falls out of the pitch range: `narrator_rb` accepts
    down to 65 Hz, and the excitation has to still be running at the closure
    that ends even that long a period, so the rise spans one period at the
    lowest pitch the device supports. Past that the glottis is shut and only
    the ring is left. (33.2 puts its own closure at window 16. So does this,
    which is the arithmetic agreeing rather than the table being copied.)

    Scale matters as much as shape. Entries are five bits, and a cycle that
    only swings a third of that is quantised to three, which is audible as
    broadband hiss riding on every vowel. The peak uses the full range.
    """
    # A window lasts `waveStep` sample pairs; the default voice is sex=0, so
    # waveStep is 11 (voice.ts) and a window is 22 samples.
    row_seconds = 2 * 11 / SAMPFREQ
    open_rows = round(1 / MIN_PITCH / row_seconds)

    def ring(row):
        return math.exp(-math.pi * min(BANDWIDTH) * row * row_seconds)

    env = []
    for row in range(64):
        if row <= open_rows:
            flow = 0.5 * (1 - math.cos(math.pi * row / open_rows))
            env.append(ring(row) + flow)
        else:                                   # shut: the ring is all there is
            env.append(env[open_rows] * ring(row - open_rows))
    peak = max(env)

    out = []
    for e in env:
        for ph in range(64):
            v = 15.5 * e / peak * math.sin(2 * math.pi * ph / 64)
            out.append(max(-16, min(15, round(v))) & 0x1F)
    return out


# The eight noise tables: where the turbulence resonates, and how loud it is.
#
# Frication is noise at a constriction, shaped by the cavity in front of it.
# The centre frequencies are the measured ones: Hughes and Halle, 'Spectral
# Properties of Fricative Consonants' (JASA 28, 1956) and Strevens, 'Spectra
# of Fricative Noise in Human Speech' (Language and Speech 3, 1960) for the
# fricatives; the burst spectra are the compact/diffuse pattern of Halle,
# Hughes and Radley (JASA 29, 1957) -- alveolar high, velar compact in the
# mid, bilabial diffuse and falling.
#
# The levels divide the same way the phonetics does: a sibilant has an
# obstacle downstream of the constriction -- the teeth -- to turn the jet into
# sound, and the non-sibilants have nothing, which is why /f/ and /th/ are the
# quietest sounds in the language (Fletcher 1953, again). One anchor is
# measured rather than derived: the sibilant level is set so /S/ comes out
# 16 dB under a vowel, which is Fletcher's ratio for /s/ against /aw/.
FRICATIVE = [
    (1000, 1.5),   # 0  neutral, diffuse -- the slot nothing selects
    (5500, 3.0),   # 1  alveolar sibilant, /S/ and /Z/
    (3000, 3.0),   # 2  postalveolar sibilant, /SH/, /ZH/, the affricates
    (1500, 1.5),   # 3  labiodental, /F/ and /V/
    (6000, 1.5),   # 4  dental, /TH/ and /DH/ -- diffuse and weaker still
    (800, 2.0),    # 5  bilabial burst, /P/ and /B/
    (4000, 2.0),   # 6  alveolar burst, /T/ and /D/
    (2000, 2.0),   # 7  velar burst, /K/ and /G/
]


# ---------------------------------------------------------------------------
# Rewrite rules. The driver runs the engine twice (speak.ts) over two tables:
# allophones first, then frame expansion.
#
# The second is not optional decoration. Several phonemes are stored as more
# than one slot -- a diphthong's nucleus and its offglide, a stop's closure and
# its release -- and only the first of each is in the inventory the parser
# matches. Without a rule to append the rest, /AY/ is its nucleus alone and
# every diphthong in the language loses its glide: "type" comes out "top".
# Which slot follows which is a fact about the table layout, not a choice.
#
# A rule is (match, left, right) with 0xff for "any", a replacement, two
# insertion points, and three groups of attribute tests -- on the phoneme, its
# left neighbour and its right. A test passes when its bit is *clear*, so
# 0xdf (bit 31, which nothing sets) is the idiom for "no test".
ANY = 0xFF
NO_TEST = 0xDF
RESCAN = 2          # keep matching further rules at this position
SKIP_RIGHT = 4      # look past a space to the right


def _test(bit, want=True, last=True):
    """One attribute test: the named bit of the subject's attribute word."""
    return (0x80 if last else 0) | 0x40 | (0x20 if want else 0) | BIT[bit]


def _rule(match, replace=ANY, after=ANY, left=ANY, right=ANY, flags=0,
          on_right=()):
    tests = [NO_TEST, NO_TEST]
    if on_right:
        tests += [_test(b, w, i == len(on_right) - 1)
                  for i, (b, w) in enumerate(on_right)]
    else:
        tests.append(NO_TEST)
    return {'at': 0, 'match': match, 'left': left, 'right': right,
            'flags': flags, 'replace': replace, 'insertBefore': ANY,
            'insertAfter': after, 'tests': tests}


def _index(name, occurrence=0):
    seen = -1
    for i, n in enumerate(NAMES):
        if n == name:
            seen += 1
            if seen == occurrence:
                return i
    raise KeyError(name)


def frame_rules():
    """The multi-slot phonemes, expanded into the slots they are made of."""
    out = []

    # A diphthong is a nucleus and an offglide, and DIPHTHONGS gave the slot
    # after each its glide target. UX is stored as a single vowel but ends in
    # the same /u/ offglide, so it borrows UW's.
    for name in DIPHTHONGS:
        out.append(_rule(_index(name), after=_index(name) + 1))
    out.append(_rule(_index('UX'), after=_index('UW') + 1))

    # A velar closure follows the vowel after it: further forward before a
    # front vowel, back and rounded before a rounded one. CONSONANTS holds the
    # three loci already, so the rule only has to choose between them.
    # Coarticulation is anticipatory here, which is why the test is on the
    # right neighbour (Ohman 1966).
    for plain, mid_v, back_v in (('G', 'GX', 'GH'), ('K', 'KX', 'KH')):
        out.append(_rule(_index(plain), replace=_index(mid_v), flags=RESCAN,
                         on_right=(('mid', True),)))
        out.append(_rule(_index(plain), replace=_index(mid_v), flags=RESCAN,
                         on_right=(('round', False), ('back', True))))
        out.append(_rule(_index(plain), replace=_index(back_v), flags=RESCAN,
                         on_right=(('back', True), ('round', True))))

    # /H is a voiceless version of the vowel it introduces, so it takes that
    # vowel's shape the same way.
    for slot, tests in (('/M', (('mid', True),)),
                        ('/B', (('round', False), ('back', True))),
                        ('/R', (('back', True), ('round', True)))):
        out.append(_rule(_index('/H'), replace=_index(slot), on_right=tests))

    # A stop is a closure and a release, and the release is two slots: the
    # burst, then what follows it. For a voiceless stop that is aspiration --
    # except after /S/, where English has none, which is the whole difference
    # between "pin" and "spin" (Lisker and Abramson 1964). The unaspirated
    # release is the one the voiced stops use, so /S P/ borrows /B/'s.
    # RESCAN on the inserting rule matters: the engine leaves the cursor on
    # what it just inserted, so without it the outer loop steps past the
    # release and the rule that appends its second half never sees it.
    stops = ('B', 'D', 'G', 'GX', 'GH', 'P', 'T', 'K', 'KX', 'KH')
    S = _index('S')
    for stop, voiced in (('P', 'B'), ('T', 'D'), ('K', 'G')):
        out.append(_rule(_index(stop), after=_index(voiced) + 1, left=S,
                         flags=RESCAN | SKIP_RIGHT))
    for stop in stops:
        out.append(_rule(_index(stop), after=_index(stop) + 1,
                         flags=RESCAN | SKIP_RIGHT))
    for stop in stops:
        out.append(_rule(_index(stop) + 1, after=_index(stop) + 2))

    # An affricate is a stop and the fricative it releases into. The table
    # gives /CH/ two slots for that and /J/ one, so they expand to match.
    out.append(_rule(_index('CH'), after=_index('CH') + 1, flags=RESCAN))
    out.append(_rule(_index('CH') + 1, after=_index('CH') + 2))
    out.append(_rule(_index('J'), after=_index('J') + 1))
    return out


def allophone_rules():
    """Context-dependent substitutions, run before the frame expansion."""
    out = []
    # The six syllabic consonants are a reduced vowel plus the consonant --
    # exactly what the translator's ULUMUNILIMIN set abbreviates. Expanding
    # them here is what lets the vowel take a syllable's worth of prosody.
    for name, vowel in (('UL', 'AX'), ('UM', 'AX'), ('UN', 'AX'),
                        ('IL', 'IX'), ('IM', 'IX'), ('IN', 'IX')):
        out.append(_rule(_index(name), replace=_index(vowel), flags=RESCAN,
                         after=_index(name[1])))
    # /l/ is velarised in the coda -- "dark l". The contrast is allophonic in
    # English and the two are far enough apart acoustically to matter: LX has
    # its own low F2 locus.
    out.append(_rule(_index('L'), replace=_index('LX'),
                     on_right=(('vowel', False),)))
    return out


def fricatives(seed=0x1F2E3D4C):
    """hunk+0x4c2e: eight 480-byte noise tables.

    The renderer takes *two* samples from every byte -- the low nibble then
    the high one, each doubled into the five-bit waveform scale (render.ts
    0x5648). So a byte is two consecutive samples at the full rate, not one:
    filtering a byte sequence and then splitting it into nibbles shapes
    nothing, because the two halves of one smooth value are unrelated as
    samples. 960 samples go in, packed two to a byte.

    Klatt's (1980) frication model is white noise through a resonator, which
    is what FRICATIVE parameterises. Amplitude is set by rms rather than by
    peak: peak-normalising noise makes the loudness depend on whichever
    excursion happened to be largest.

    A fixed generator rather than captured noise: reproducible, and nobody's.
    """
    tables = []
    state = seed

    def rnd():
        nonlocal state
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        return (state >> 16) / 32768.0 - 0.5

    for centre, level in FRICATIVE:
        # A two-pole resonator, bandwidth 1 kHz -- frication is a broad hump,
        # not a whistle.
        r = math.exp(-math.pi * 1000 / SAMPFREQ)
        c = 2 * r * math.cos(2 * math.pi * centre / SAMPFREQ)
        y1 = y2 = 0.0
        raw = []
        for _ in range(960):
            y = rnd() + c * y1 - r * r * y2
            y2, y1 = y1, y
            raw.append(y)
        rms = math.sqrt(sum(v * v for v in raw) / len(raw)) or 1.0
        # Quantise to the even values the doubling can reach, -16 to +14.
        q = [max(-16, min(14, 2 * round(level * v / rms / 2))) for v in raw]
        n = [(s >> 1) & 0x0F for s in q]
        tables.append([n[i] | (n[i + 1] << 4) for i in range(0, len(n), 2)])
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
    # A stop's burst radiates from the closure it just broke, so it has the
    # same place and the same loci. Aspiration is the glottis heard through a
    # tract already on its way to the next vowel, so it is neutral -- the
    # uniform tube again. Without these the release slots have no formants at
    # all, and the amplitude the transition into the vowel interpolates from
    # is zero.
    for n, roles in RELEASE.items():
        i = NAMES.index(n)
        for k, role in enumerate(roles[1:], start=1):
            put(n, VOWELS['AX'] if role == 'aspiration' else CONSONANTS[n],
                at=i + k)

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
        'rules': {'allophones': {'at': 0, 'bytes': 0,
                                 'rules': allophone_rules()},
                  'frames': {'at': 0, 'bytes': 0, 'rules': frame_rules()}},
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
