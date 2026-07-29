/**
 * narrator.device's contour marker — hunk+0x19c4 of build 33.2.
 *
 * The last thing that happens to the stress array. Everything the spreader and
 * the duration stage put in the low nibble is thrown away, and three flags go
 * back in their place marking where the pitch contour has to be pinned:
 *
 * | | |
 * |---|---|
 * | 1 | a vowel, the syllable's pitch peak |
 * | 2 | the phoneme just after it, where the fall begins |
 * | 4 | the last voiced phoneme before the fall runs out |
 *
 * `hunk+0x1a8e` then writes a pitch value into the frame array at each of
 * those, and the renderer's last stage interpolates between them — which is
 * why a captured frame array has a pitch byte at a handful of frames and
 * zeroes in between until `0x29d8` has run.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Flags this stage writes into the low nibble of the stress byte. */
export const CONTOUR = {
  /** The vowel. */
  PEAK: 1,
  /** The phoneme after it. */
  FALL: 2,
  /** The end of the voiced run. */
  END: 4,
} as const

/** Bits this stage reads. */
const ATTR = {
  /** Bit 0: a vowel. */
  VOWEL: 1 << 0,
  /** Bit 7: the duration is split across two slots. */
  SPLIT: 1 << 7,
  /** Bit 9: voiced. */
  VOICED: 1 << 9,
  /** Bit 25: ends a phrase. */
  TERMINAL: 1 << 25,
} as const

/** 0x80 in a stress byte: the spreader marked this phoneme. */
const MARK = 0x80

/** The two that are vowels by attribute but never syllable nuclei. */
const RX = 0x17
const LX = 0x18

export interface ContourState {
  phonemes: Uint8Array
  stress: Uint8Array
}

/** Mark where the pitch contour is pinned, in place. */
export function markContour(state: ContourState, attrs: Attrs): void {
  const { phonemes, stress } = state

  // 0x19c4: clear every low nibble first. Nothing downstream wants what the
  // earlier stages left there.
  for (let i = 0; stress[i] !== TERMINATOR; i++) stress[i] &= 0xf0

  // `i` is the index just read; the device's A0 and A1 are then one past it,
  // so `stress[i + 1]` is its `(A1)` and `stress[i - 1]` its `(-2,A1)`.
  let i = -1
  /**
   * A lookup past the attribute table's 102 entries reads unrelated bytes in
   * the device and zero here. Reachable only for the `0xff` terminator, whose
   * stress byte is tested before its attributes are, so no utterance gets
   * there — but the difference is real and is written down rather than
   * guarded against.
   */
  const attrOf = (p: number): number => attrs[p] ?? 0

  for (;;) {
    // ---------------------------------------------------------- 0x19e6
    i++
    if (phonemes[i] === TERMINATOR) return
    let a = attrOf(phonemes[i])
    let s = stress[i]

    // 0x19fa: only a phoneme the spreader marked starts a contour.
    marked: while (s & MARK) {
      // 0x1a00: walk forward to the syllable's vowel. Note this loop is
      // re-entered at the *vowel* test, not at the mark test above — a
      // consonant inside the span does not need marking again.
      while (!(a & ATTR.VOWEL)) {
        i++
        a = attrOf(phonemes[i])
        s = stress[i]
        if (s & MARK || a & ATTR.TERMINAL) {
          // 0x1a78: the span ran out before a vowel turned up — pin all three
          // flags across the last two slots and go back to the mark test.
          stress[i - 1] |= CONTOUR.PEAK
          stress[i] |= CONTOUR.FALL | CONTOUR.END
          continue marked
        }
      }

      // ---------------------------------------------------------- 0x1a24
      stress[i] |= CONTOUR.PEAK

      // 0x1a2a: the fall normally starts on the phoneme after the vowel, but
      // a split phoneme and the two non-nucleus vowels push it one further.
      const after = phonemes[i + 1]
      if (a & ATTR.SPLIT || after === LX || after === RX) stress[i + 2] |= CONTOUR.FALL
      else stress[i + 1] |= CONTOUR.FALL

      // 0x1a44: `end` tracks the last voiced phoneme seen, and starts on the
      // one holding the fall.
      let end = i + 1

      // ---------------------------------------------------------- 0x1a50
      for (;;) {
        i++
        a = attrOf(phonemes[i])
        s = stress[i]
        if (s & MARK || a & ATTR.TERMINAL) break
        if (a & ATTR.VOICED) end = i + 1
      }
      stress[end] |= CONTOUR.END
      // 0x1a76 re-enters at the mark test rather than the outer loop, so a
      // span that ends on another marked phoneme starts the next contour
      // without stepping over it.
    }
  }
}
