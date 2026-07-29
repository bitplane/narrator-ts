/**
 * narrator.device's duration assignment — hunk+0x1be8 of build 33.2.
 *
 * Every phoneme has two durations in the binary, in frames: one for when it
 * carries stress and one for when it does not (`hunk+0x3806` and `+0x3886`,
 * extracted into fixtures/golden/phonemes-33.2.json). This stage picks a point
 * between them.
 *
 * It does that by accumulating a scale factor in 1/32nds, starting at 32 —
 * exactly 1.0 — and multiplying in a factor for each thing it notices about
 * the phoneme's surroundings: a vowel that is not its syllable's nucleus is
 * shortened, a phrase-final one is stretched by nearly half, a liquid before a
 * vowel is cut to 3/32 of its length. The factors are integers over 32 and the
 * rounding is the device's, so the arithmetic here is deliberately not
 * floating point.
 *
 * The result is written into the *flags* array, under the two bits the stress
 * spreader put there — from here on `flags[i] & 0x3f` is a frame count. That
 * reuse is why the driver's later stages read durations out of what looks like
 * the wrong array.
 *
 * Runs between the pitch loop and the second rewrite pass. See
 * research/02-narrator.md.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Attribute bits this stage tests, by the name the pipeline knows them by. */
const ATTR = {
  /** Bit 0: a vowel. */
  VOWEL: 1 << 0,
  /** Bit 1: a consonant. */
  CONSONANT: 1 << 1,
  /** Bit 9: voiced. */
  VOICED: 1 << 9,
  /** Bit 10: a voiced stop. */
  VOICED_STOP: 1 << 10,
  /** Bit 11: a voiceless stop. */
  VOICELESS_STOP: 1 << 11,
  /** Bit 12: a fricative. */
  FRICATIVE: 1 << 12,
  /** Bit 16: a nasal. */
  NASAL: 1 << 16,
  /** Bit 20: not spoken — the space and the bracket markers. */
  SILENT: 1 << 20,
  /** Bit 25: ends a phrase. */
  TERMINAL: 1 << 25,
  /** Bits 15 and 16 — liquids and nasals. */
  LIQUID_OR_NASAL: 0x18000,
  /** Bits 15 and 17 — liquids and glides. */
  LIQUID_OR_GLIDE: 0x28000,
} as const

/** Bits of the stress byte this stage tests. */
const STRESS = {
  /** 0x40: the phoneme carries a spread descriptor. */
  SPREAD: 1 << 6,
  /** 0x10: part of a stressed syllable. */
  STRESSED: 1 << 4,
} as const

/** Bits of the flag byte this stage tests, before it overwrites the rest. */
const FLAG = {
  /** 0x80: this phoneme is its syllable's vowel. */
  VOWEL: 1 << 7,
  /** 0x40: between the last vowel and a phrase-final pause. */
  PHRASE_END: 1 << 6,
} as const

/** The low six bits of a flag byte are the duration once this has run. */
export const DURATION_MASK = 0x3f

/** What a terminal gets, flat, instead of a table lookup (0x1c34). */
const TERMINAL_FRAMES = 0x18

/**
 * Phonemes 0-8 are the space, the punctuation and the brackets. `0x1c58`
 * compares against this rather than testing an attribute.
 */
const LAST_PUNCTUATION = 8

export interface DurationState {
  phonemes: Uint8Array
  stress: Uint8Array
  flags: Uint8Array
}

/** Per-phoneme frame counts, stressed and unstressed. */
export interface Durations {
  stressed: readonly number[]
  unstressed: readonly number[]
}

/** Assign each phoneme a duration in frames, in place. */
export function assignDurations(
  state: DurationState,
  attrs: Attrs,
  table: Durations,
): void {
  const { phonemes, stress, flags } = state
  const attrOf = (p: number): number => attrs[p] ?? 0

  // 0x1c06: the first two slots are lead-in and are never given a duration,
  // but they are read as left context below.
  let i = 2

  for (;;) {
    // -------------------------------------------------------------- 0x1c0c
    const st = stress[i]
    const fl = flags[i]
    const p = phonemes[i]
    if (p === TERMINATOR) return

    // `scale` is D0: 1/32nds, and 0x1e12 is `D0 = (D0 * D1 + 16) >> 5`, so
    // each factor rounds to nearest on its own rather than at the end.
    let scale = 0x20
    const by = (f: number): void => {
      scale = ((scale * f + 0x10) >> 5) & 0xffff
    }

    const a = attrOf(p)
    if (a & ATTR.SILENT) {
      i++
      continue
    }
    if (a & ATTR.TERMINAL) {
      // 0x1c34: a full stop, comma or dash is 24 frames whatever the table
      // says. The table entries for phonemes 1-4 are therefore unreachable
      // from here, which is why `,` reads 36 in the binary and 24 in a trace.
      store(TERMINAL_FRAMES)
      continue
    }

    // -------------------------------------------------------------- 0x1c42
    if (fl & FLAG.PHRASE_END) by(0x2d)
    // 0x1c50: a liquid or nasal immediately before a pause is stretched too.
    if (a & ATTR.LIQUID_OR_NASAL) {
      if (phonemes[i + 1] <= LAST_PUNCTUATION) by(0x2d)
    }

    if (a & ATTR.VOWEL) {
      // ------------------------------------------------------------ 0x1c6e
      // A vowel that is not the nucleus of its syllable, one merely inside a
      // spread, and one outside any stressed syllable each lose length.
      if (!(fl & FLAG.VOWEL)) by(0x1b)
      if (st & STRESS.SPREAD) by(0x1a)
      if (!(st & STRESS.STRESSED)) by(0x16)

      // 0x1c92: and then the vowel is lengthened or not by what follows it.
      const right = attrOf(phonemes[i + 1])
      if (right & (ATTR.SILENT | ATTR.TERMINAL)) {
        // 0x1caa: before a pause, but only in a stressed syllable.
        if (st & STRESS.STRESSED) {
          by(0x26)
          neighbours()
          continue
        }
      }
      if (right & ATTR.FRICATIVE) {
        // 0x1cc0: voiced fricatives lengthen the vowel, voiceless ones do
        // not — "buzz" against "bus", the classic pre-voicing effect.
        if (right & ATTR.VOICED) { by(0x26); neighbours(); continue }
      } else if (right & ATTR.VOICED_STOP) {
        by(0x26)
        neighbours()
        continue
      } else if (right & ATTR.NASAL) {
        // 0x1ce8: unless the nasal is itself stressed.
        if (!(stress[i + 1] & STRESS.STRESSED)) { by(0x1b); neighbours(); continue }
      } else if (right & ATTR.VOICELESS_STOP) {
        by(0x16)
        neighbours()
        continue
      } else {
        consonantChecks()
        continue
      }
      // 0x1cc4 and 0x1cee both fall through to the stress test at 0x1d20.
      stressedOrLiquid()
      continue
    }

    consonantChecks()
    continue

    // ---------------------------------------------------------------------
    // The three shared tails, written as closures so the fall-through
    // structure of the original stays visible rather than being flattened.

    /** 0x1d0c: reached by consonants, and by vowels with plain right context. */
    function consonantChecks(): void {
      if (a & ATTR.CONSONANT) {
        // A consonant that does not follow a pause is shortened.
        if (phonemes[i - 1] > LAST_PUNCTUATION) { stressedOrLiquid(); return }
        by(0x1b)
      }
      stressedOrLiquid()
    }

    /** 0x1d20. */
    function stressedOrLiquid(): void {
      if (st & STRESS.STRESSED) { neighbours(); return }
      if (!(a & ATTR.LIQUID_OR_GLIDE)) { neighbours(); return }
      // 0x1d38: an unstressed liquid or glide running into a vowel is cut to
      // 3/32 — barely a frame. This is what makes /R/ and /L/ glide rather
      // than sit as segments of their own.
      if (attrOf(phonemes[i + 1]) & ATTR.VOWEL) by(0x03)
      neighbours()
    }

    /** 0x1d46: adjust for what is either side, skipping a space. */
    function neighbours(): void {
      const left = attrOf(phonemes[i - 1] !== 0 ? phonemes[i - 1] : phonemes[i - 2])
      const right = attrOf(phonemes[i + 1] !== 0 ? phonemes[i + 1] : phonemes[i + 2])

      if (a & ATTR.VOWEL) {
        // 0x1d70: vowel against vowel, in both directions.
        if (right & ATTR.VOWEL) by(0x26)
        if (left & ATTR.VOWEL) by(0x16)
      } else if (left & ATTR.CONSONANT) {
        // 0x1d90: a consonant in a cluster on both sides is halved.
        by(right & ATTR.CONSONANT ? 0x10 : 0x16)
      } else if (right & ATTR.CONSONANT) {
        by(0x16)
      }
      interpolate()
    }

    /** 0x1db2: turn the accumulated scale into a frame count and store it. */
    function interpolate(): void {
      const hi = table.stressed[p] ?? 0
      let lo = table.unstressed[p] ?? 0

      // 0x1dc2: an unstressed phoneme normally halves its floor as well,
      // except for the two attribute classes at bits 15 and 17.
      if (!(st & STRESS.STRESSED) && !(a & ATTR.LIQUID_OR_GLIDE)) lo >>= 1

      // 0x1dd6: `sub.b` then `mulu.w` then `add.b`, so the subtraction and
      // the addition wrap in a byte and the multiply does not.
      let d = (hi - lo) & 0xff
      d = ((d * scale) & 0xffff) >> 5
      d = (d + lo) & 0xff

      // 0x1de4: a stressed vowel after a voiceless stop gets three frames
      // back — the aspiration eats into it, so it is made up here.
      if ((a & ATTR.VOWEL) && (st & STRESS.STRESSED)) {
        if (attrOf(phonemes[i - 1]) & ATTR.VOICELESS_STOP) d = (d + 3) & 0xff
      }

      // 0x1dfe: `cmpi.b`/`ble`, so the clamp is signed, and a duration past
      // 0x7f would read as negative and be stored untouched — bits 6 and 7
      // and all, putting the spreader's flags back on.
      //
      // Neither case happens. Every factor above is at most 45/32 and no path
      // applies more than two of the large ones, so `scale` cannot exceed 63;
      // running the whole table at 63 gives at most 61 frames (`OY`, floor
      // halved). The clamp is dead code in this build. Kept because it is
      // what the routine says, and because 37.7 may retune the tables.
      store(((d << 24) >> 24) > DURATION_MASK ? DURATION_MASK : d)
    }

    /** 0x1e08: the low six bits only — the spreader's two flags survive. */
    function store(d: number): void {
      flags[i] = ((fl & 0xc0) | d) & 0xff
      i++
    }
  }
}
