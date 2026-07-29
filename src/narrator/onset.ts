/**
 * narrator.device's syllable-onset marker — hunk+0x112c of build 33.2.
 *
 * The parser leaves a stress digit on the vowel it was written after. This
 * runs before the first rewrite pass and walks that stress *backwards* over
 * the consonants in front of the vowel, so the whole onset of the syllable is
 * marked rather than just its nucleus.
 *
 * It follows a cluster up to three deep: the consonant itself, then a stop or
 * fricative behind a liquid or glide, then an `S` behind that. Which is to
 * say it knows that the onset of "spring" is `S P R`, and marks all of it.
 *
 * The bit it sets is 0x10, the same bit every ASCII stress digit already has,
 * which is why `hunk+0x11bc` can later test one bit and not care whether the
 * stress was typed or inferred here.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Attribute groups this stage tests, exactly as the masks appear. */
const ATTR = {
  /** Bit 1: a consonant. */
  CONSONANT: 1 << 1,
  /** Bits 15 and 17 — the liquids `R`/`L`/`RX`/`LX` and glides `WH`/`W`/`Y`. */
  LIQUID_OR_GLIDE: 0x28000,
  /** Bit 11: a voiceless stop or affricate. */
  VOICELESS_STOP: 1 << 11,
  /** Bits 10, 12 and 14 — voiced stops, fricatives and affricates. */
  OBSTRUENT: 0x5400,
  /** Bits 10, 11 and 16 — stops and nasals. */
  STOP_OR_NASAL: 0x10c00,
} as const

/** Set on a stress byte to mean "part of a stressed syllable's onset". */
export const ONSET = 0x10

/** Phoneme 48. The one index this stage names outright. */
const S = 0x30

export interface OnsetState {
  phonemes: Uint8Array
  stress: Uint8Array
}

/** Mark stressed syllables' onsets, in place. */
export function markOnsets(state: OnsetState, attrs: Attrs): void {
  const { phonemes, stress } = state
  const attrOf = (p: number): number => attrs[p] ?? 0

  // 0x113c: the phoneme pointer starts one *behind* the stress pointer, so
  // each iteration pairs stress[i] with the phoneme in front of it. On the
  // first pass that reads phonemes[-1], which the device does too — stress[0]
  // is zero, so the value is discarded before it is used.
  for (let i = 0; i < stress.length; i++) {
    const s = stress[i]
    if (s === 0) continue                     // 0x1144
    if (s === TERMINATOR) return              // 0x114a

    // 0x1152: only a consonant in front of the stress starts a cluster.
    const one = attrOf(phonemes[i - 1])
    if (!(one & ATTR.CONSONANT)) continue
    stress[i - 1] |= ONSET

    if (one & ATTR.LIQUID_OR_GLIDE) {
      // 0x1166: behind a liquid or glide, look one further back.
      const two = attrOf(phonemes[i - 2])
      if (two & ATTR.VOICELESS_STOP) {
        stress[i - 2] |= ONSET
        // 0x117e: and an `S` behind *that* — "spring", "street".
        if (phonemes[i - 3] === S) stress[i - 3] |= ONSET
      } else if (two & ATTR.OBSTRUENT) {
        stress[i - 2] |= ONSET
      }
    } else if (one & ATTR.STOP_OR_NASAL) {
      // 0x119e: no liquid, but a stop or nasal can still take an `S`.
      if (phonemes[i - 2] === S) stress[i - 2] |= ONSET
    }
  }
}
