#!/usr/bin/env python3
"""Count how often the device reaches each decision point in a routine.

A port that matches the fixtures proves nothing about a branch the fixtures
never take -- the stress spreader passed 27 of 30 captures with a real bug in
it, because only multi-syllable words went down the affected path. So before
believing a stage is done, ask the device which paths the corpus actually
drives, and go and write corpus entries for the ones that read zero.

Addresses are hunk offsets, named on the command line or in ROUTINES below.

    branch-coverage.py -r durations -f fixtures/corpus/frames.txt
    branch-coverage.py -a 0x1c34=terminal -a 0x1c48=phrase-end -p '/HEH4LOW'
"""
import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools' / 'oracle'))
sys.path.insert(0, str(ROOT / 'tools'))

import narrator as N                                          # noqa: E402
from m68k import PC                                           # noqa: E402
from narrator import DEFAULT_DEV, Narrator                    # noqa: E402

from importlib import import_module                           # noqa: E402
capture_frames = import_module('capture-frames')
capture_parse = import_module('capture-parse')

# Every point in hunk+0x1be8 where the duration scale is multiplied, or the
# stored value is adjusted. The names are the ones in src/narrator/duration.ts.
DURATIONS = [
    (0x1C34, 'terminal 24 flat'),
    (0x1C48, 'phrase-end x45'),
    (0x1C60, 'liquid/nasal before pause x45'),
    (0x1C74, 'vowel not the nucleus x27'),
    (0x1C80, 'inside a spread x26'),
    (0x1C8C, 'unstressed x22'),
    (0x1CB0, 'stressed vowel before pause x38'),
    (0x1CC8, 'vowel before voiced fricative x38'),
    (0x1CD8, 'vowel before voiced stop x38'),
    (0x1CF2, 'vowel before unstressed nasal x27'),
    (0x1D02, 'vowel before voiceless stop x22'),
    (0x1D1A, 'consonant not after a pause x27'),
    (0x1D40, 'liquid/glide before a vowel x3'),
    (0x1D76, 'vowel before a vowel x38'),
    (0x1D82, 'vowel after a vowel x22'),
    (0x1D96, 'consonant in a cluster both sides x16'),
    (0x1DA4, 'consonant in a cluster one side x22'),
    (0x1DD4, 'halve the unstressed floor'),
    (0x1DFA, 'stressed vowel after a voiceless stop +3'),
    (0x1E04, 'clamp to 0x3f'),
]

# The ported sub-routines of the frame-array builder, hunk+0x1454.
FRAMES = [
    (0x19A8, '0x1970 keep a phoneme'),
    (0x19B0, '0x1970 done'),
    (0x14B8, '0x1492 RX averages with its predecessor'),
    (0x14F4, '0x1492 split a duration across two slots'),
    (0x1518, '0x1492 a continuation slot inherits stress'),
    (0x152E, '0x1492   from the unstressed table'),
    (0x1552, '0x1492   noise source 3'),
    (0x155E, '0x1492   noise source 6'),
    (0x156A, '0x1492   noise source 5'),
    (0x1572, '0x1492   noise source 4'),
    (0x15FE, '0x15e0 terminator'),
    (0x164E, '0x15e0 stressed, +2 on A1'),
    (0x1658, '0x15e0   A1 clamped at 0x1f'),
    (0x165E, '0x15e0   +2 on A2'),
    (0x1666, '0x15e0   +2 on A3'),
    (0x1686, '0x15e0 noise source from the stress byte'),
    (0x169A, '0x15e0 the second voice frequency table'),
    (0x16AC, '0x15e0 . and ? borrow the previous formants'),
    (0x16D4, '0x15e0 mouth shapes wanted'),
    (0x16EC, '0x15e0 unstressed noise halved'),
    (0x147E, '0x1472 mark frame 0'),
]

# The two coarticulation routines at the end of hunk+0x1454.
BLEND = [
    (0x1776, '0x172a skip a stop release'),
    (0x17A8, '0x172a the next phoneme ranks higher'),
    (0x17A0, '0x172a this phoneme ranks higher'),
    (0x17BC, '0x172a blend a byte'),
    (0x17D2, '0x172a leave a frequency alone, one end is silent'),
    (0x1840, '0x17d6 skip a stop'),
    (0x1856, '0x17d6 nothing follows, no tail'),
    (0x1864, '0x17d6 head from the previous phoneme'),
    (0x186E, '0x17d6 head from this one'),
    (0x1880, '0x17d6 tail from the next phoneme'),
    (0x1878, '0x17d6 tail from this one'),
    (0x18B2, '0x17d6 keep amplitudes, a stop before'),
    (0x18B8, '0x17d6 a voiceless fricative before'),
    (0x18D0, '0x17d6 a liquid or glide gets two frames'),
    (0x18E6, '0x17d6 keep amplitudes, a stop after'),
    (0x1900, '0x17d6 trim both transitions to fit'),
    (0x1966, '0x17d6 they still do not fit: all transition'),
    (0x1926, '0x17d6 mark a head frame with amplitudes'),
    (0x1952, '0x17d6 mark a tail frame with amplitudes'),
]

# hunk+0x19c4, the contour marker.
CONTOUR = [
    (0x19D4, '0x19c4 clear a low nibble'),
    (0x1A24, '0x19c4 a vowel, the peak'),
    (0x1A40, '0x19c4 fall on the next phoneme'),
    (0x1A48, '0x19c4 fall one further, split or LX/RX'),
    (0x1A6E, '0x19c4 extend the voiced run'),
    (0x1A72, '0x19c4 mark the end of it'),
    (0x1A78, '0x19c4 the span ran out before a vowel'),
]

# hunk+0x1a8e, the pitch pass that reads the contour flags.
PITCH = [
    (0x1AC2, '0x1a8e next phoneme'),
    (0x1ADA, '0x1a8e the last pitch of the utterance'),
    (0x1AFA, '0x1a8e skip, not a peak'),
    (0x1B00, '0x1a8e a peak'),
    (0x1B52, '0x1a8e squeeze the fall, a rise follows'),
    (0x1B7E, '0x1a8e place the middle'),
    (0x1B90, '0x1a8e nowhere to travel, no middle'),
    (0x1BB4, '0x1a8e the rise at the end of the voiced run'),
    (0x1BCA, '0x1a8e monotone'),
]

# The interpolation core of hunk+0x29d8.
INTERPOLATE = [
    (0x2ACE, '0x2aba column done'),
    (0x2AD8, '0x2aba nothing between, step on'),
    (0x2ADC, '0x2aba fill a run of zeroes'),
    (0x2AA2, '0x2a92 column done'),
    (0x2AB2, '0x2a92 nothing between, step on'),
    (0x2AB6, '0x2a92 fill a run of 0xfe'),
    (0x2A82, '0x2a6a one interpolated frame'),
    (0x2D6E, '0x2d54 box filter done'),
    (0x2D76, '0x2d54 one smoothed frame'),
    (0x2DA2, '0x2d86 triangular filter done'),
    (0x2DAC, '0x2d86 one smoothed frame'),
    (0x2D52, '0x2d1c gain curve done'),
    (0x2D3A, '0x2d1c a marked frame, left alone'),
    (0x2D3E, '0x2d1c three amplitudes through the curve'),
    (0x2DEA, '0x2dca intrinsic pitch done'),
    (0x2E38, '0x2dca voiced stop, +10'),
    (0x2E48, '0x2dca voiceless stop, -6'),
    (0x2E4C, '0x2dca nasal, -6'),
    (0x2E50, '0x2dca fricative, -6'),
    (0x2E54, '0x2dca glottal stop, flat'),
    (0x2E68, '0x2dca vowel or liquid, by F1'),
    (0x2E32, '0x2dca no adjustment'),
]

# The five routines hunk+0x1ee0 calls: the prosody pass.
PROSODY = [
    (0x1F42, '0x1f02 a boundary'),
    (0x1F56, '0x1f02   a space, carry on'),
    (0x1F5A, '0x1f02 unmarked, skip'),
    (0x1F68, '0x1f02 a stressed syllable'),
    (0x1F6E, '0x1f02   walk on for the digit'),
    (0x1F84, '0x1f02   +2 inside a spread'),
    (0x1F8C, '0x1f02   a primary stress'),
    (0x1F9C, '0x1f02   the first one'),
    (0x1FBA, '0x1f02 overflow, give up'),
    (0x1FC0, '0x1f02 end of phrase'),
    (0x1FCC, '0x1f02   with no stress in it'),
    (0x2008, '0x1fd8 a dash'),
    (0x205A, '0x1fd8 stop at a phrase break'),
    (0x2054, '0x1fd8 stop at the terminator'),
    (0x2022, '0x1fd8 a marked syllable'),
    (0x202A, '0x1fd8 flag bit 5'),
    (0x2038, '0x1fd8 flag bit 4'),
    (0x204C, '0x1fd8   mark it 0x0e'),
    (0x2082, '0x1fd8 0x0e: seek backwards'),
    (0x208E, '0x1fd8 2: seek forwards'),
    (0x20A2, '0x1fd8   found nothing, clear it'),
    (0x20A8, '0x1fd8   found one, move the marker'),
    (0x20E8, '0x20d0 ended on a full stop'),
    (0x20F2, '0x20d0 ended on a question mark'),
    (0x215E, '0x210a nothing to do'),
    (0x2136, '0x210a a question rises'),
    (0x213A, '0x210a the cadence'),
    (0x2152, '0x210a mark the last primary stress'),
]

# hunk+0x2160's body. A few of these are totals rather than one arm of a
# decision, because both arms of it converge on the same address; they are
# named so, and the other arm is the difference.
BODY = [
    (0x218A, '0x2160 total, the phrases mode does not skip'),
    (0x218E, '0x2160 a phrase with a primary stress in it'),
    (0x21AA, '0x2160 total, including the phrases that skip the body'),
    (0x21F8, '0x21b8 clamped to the 125 floor'),
    (0x2202, '0x21b8 clamped to the 165 ceiling'),
    (0x2226, '0x220c a question falls to 115'),
    (0x2232, '0x220c total, both step schemes'),
    (0x2238, '0x220c four or more stresses, two step sizes'),
    (0x2256, '0x220c total, syllables walked forwards'),
    (0x2264, '0x220c the last stress takes the big step'),
    (0x2266, '0x220c step a stressed syllable down'),
    (0x227A, '0x220c total, syllables walked backwards'),
    (0x2282, '0x220c a stressed syllable, backwards'),
    (0x22B6, '0x220c pull it away from the next'),
    (0x2296, '0x220c pull it towards the previous'),
    (0x22D0, '0x220c leave it alone'),
    (0x22D6, '0x220c total, and the early exit at the first stress'),
    (0x22EC, '0x220c scale by the stress level'),
    (0x231C, '0x230c total, one per syllable'),
    (0x2326, '0x230c a stressed syllable'),
    (0x2340, '0x230c a negative cadence nibble'),
    (0x236E, '0x230c the fall came out negative, clipped'),
    (0x2380, '0x230c the moved marker with no cadence of its own'),
    (0x23E0, '0x23ce total, one per syllable'),
    (0x23EA, '0x23ce a stressed syllable, and the one above it'),
    (0x23F8, '0x23ce   back to back'),
    (0x2486, '0x23ce     raise the later swing'),
    (0x248E, '0x23ce     deepen the earlier one'),
    (0x2496, '0x23ce   further apart'),
    (0x24AC, '0x23ce     total, the three-band ladder'),
    (0x24A0, '0x23ce     two or more between them'),
    (0x24A8, '0x23ce     three or more'),
    (0x254A, '0x23ce     the moved marker again'),
    (0x2562, '0x23ce     set the later swing outright'),
    (0x2578, '0x23ce total, the punctuation pass'),
    (0x2588, '0x23ce a stressed syllable a pause follows'),
    (0x259C, '0x23ce   a full stop, a flat 75'),
    (0x25AC, '0x23ce   a question, and the fall inverts'),
    (0x25DC, '0x23ce     a higher middle earlier in the phrase'),
    (0x2608, '0x25f8 total, one per syllable'),
    (0x2612, '0x25f8 a marked syllable'),
    (0x261C, '0x25f8   a phrase boundary, deepen the fall'),
    (0x2666, '0x2642 subtract, for a stressed syllable'),
    (0x2686, '0x2642 total, one per pair of stresses'),
    (0x26A6, '0x2642 a pair with syllables between them'),
    (0x26B0, '0x2642   the earlier ends below the later, meet halfway'),
    (0x26E4, '0x2642   the moved marker, spread the step evenly'),
    (0x2762, '0x2642   one syllable between'),
    (0x2770, '0x2642   two'),
    (0x2718, '0x2642   three or more'),
    (0x273A, '0x2642     hold the rest of the run flat'),
    (0x278A, '0x2642 flat 110 before the first stress'),
    (0x27B8, '0x2642 the phrase ends on a stress, no tail'),
    (0x27D4, '0x2642 no stress found at all'),
    (0x27EA, '0x2642 a full stop aims 35 lower'),
    (0x27F2, '0x2642 one syllable of the tail'),
    (0x2818, '0x2642 end on 75'),
    (0x2824, '0x2642 end on 110'),
    (0x282C, '0x2642 a question ends on the highest peak'),
    (0x285C, '0x2642   and starts where the syllable before it ended'),
    (0x2886, '0x2864 total, one per syllable'),
    (0x2890, '0x2864 a stressed syllable'),
    (0x28AE, '0x2864   a voiced consonant at the onset'),
    (0x28B8, '0x2864   a voiceless one'),
    (0x2914, '0x2864   total, including a vowel onset'),
    (0x295C, '0x2864 a pause or another stress follows'),
    (0x2964, '0x2864   and it is not the last syllable'),
    (0x292A, '0x2864 walk on to what the syllable runs into'),
    (0x2970, '0x2864   a vowel or the glottal stop'),
    (0x296A, '0x2864   a voiceless phoneme'),
    (0x2958, '0x2864   step over a voiced consonant'),
]

ROUTINES = {'durations': DURATIONS, 'frames': FRAMES, 'blend': BLEND,
            'contour': CONTOUR, 'pitch': PITCH, 'interpolate': INTERPOLATE,
            'prosody': PROSODY, 'body': BODY}


def run(device, phrase, opts, marks, steps, counts):
    n = Narrator(device)
    if n.open():
        raise SystemExit('narrator.device refused to open')
    h0 = n.hunks[0].addr
    cpu = n.m.cpu
    # Getting to the parser proves the phrase is legal and puts us on the
    # synthesis path; from there step and watch.
    if not capture_frames.run_to(n, phrase, h0 + 0x804, opts):
        return False
    watch = {h0 + off: name for off, name in marks}
    for _ in range(steps):
        name = watch.get(cpu.get(PC))
        if name is not None:
            counts[name] += 1
        cpu.execute(1)
        if n.m.sched.switch_pending:
            n.m.sched.switch_pending = False
            n.m.sched.switch()
        if n.m.finished:
            return True
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-r', '--routine', choices=sorted(ROUTINES))
    ap.add_argument('-a', '--at', action='append', default=[],
                    help='extra point as offset=name, e.g. 0x1c34=terminal')
    ap.add_argument('-p', '--phrase', action='append', default=[])
    ap.add_argument('-f', '--file', action='append', default=[])
    ap.add_argument('-n', '--steps', type=int, default=30_000_000)
    for name, default in N.DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, default=default)
    args = ap.parse_args()

    marks = list(ROUTINES.get(args.routine, []))
    for spec in args.at:
        off, _, name = spec.partition('=')
        marks.append((int(off, 0), name or off))
    if not marks:
        ap.error('nothing to watch: pass -r or -a')

    phrases = list(args.phrase)
    for path in args.file:
        phrases += capture_parse.read_corpus(Path(path))
    if not phrases:
        ap.error('nothing to run: pass -p or -f')

    opts = {k: getattr(args, k) for k in N.DEFAULTS}
    counts = Counter({name: 0 for _, name in marks})
    for p in phrases:
        run(args.device, p, opts, marks, args.steps, counts)

    width = max(len(name) for _, name in marks)
    cold = 0
    for _, name in marks:
        n = counts[name]
        cold += n == 0
        print(f'  {name:{width}}  {n:5}{"   <- never taken" if not n else ""}')
    print(f'{len(marks) - cold}/{len(marks)} reached over {len(phrases)} phrases')


if __name__ == '__main__':
    main()
