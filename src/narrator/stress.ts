/**
 * narrator.device's stress spreader — hunk+0x11bc of build 33.2.
 *
 * The parser leaves a stress digit sitting on the one phoneme it was written
 * after. This stage turns that into something the frame generator can use: it
 * walks the phoneme array vowel by vowel and spreads a descriptor across each
 * syllable, out to the midpoint between one vowel and the next, and marks
 * word and phrase boundaries in the flag array.
 *
 * It runs after the first rewrite pass, so it sees allophones rather than what
 * was typed. See research/02-narrator.md.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Attribute bits this stage tests. */
const ATTR = {
  /** Bit 0: a stress digit may follow — which is also "is a vowel". */
  VOWEL: 1 << 0,
  /** Bit 25: ends a phrase — `.`, `?`, `,` or `-`. */
  TERMINAL: 1 << 25,
} as const

/** Bits this stage writes into the stress array. */
export const STRESS = {
  /** 0x1274 and 0x124c: this phoneme carries a spread descriptor. */
  MARK: 0x80,
  /** 0x1230: set on every spread byte. */
  SPREAD: 0x40,
  /** 0x122e: the source vowel had a stress digit. */
  STRESSED: 0x20,
} as const

/** Bits this stage writes into the flag array. */
export const FLAG = {
  /** 0x1280: this phoneme is the vowel of its syllable. */
  VOWEL: 0x80,
  /** 0x12b4: everything from the last vowel to a phrase-final pause. */
  PHRASE_END: 0x40,
} as const

/** `LX` and `RX` are vowels by attribute but not by this stage's reckoning. */
const LX = 0x18
const RX = 0x17

export interface StressState {
  phonemes: Uint8Array
  stress: Uint8Array
  flags: Uint8Array
}

/**
 * 68k `dbra`: the body runs once, then repeats while the decremented *word*
 * is not -1.
 *
 * Written out rather than turned into a `for` because a count of -1 does not
 * mean "no iterations" here — it means 65536 of them, walking off the end of
 * the array. That is a real property of the routine, and a port that quietly
 * treats a negative count as zero is not reproducing it.
 */
function dbra(count: number, body: () => void): void {
  let d = count & 0xffff
  for (;;) {
    body()
    d = (d - 1) & 0xffff
    if (d === 0xffff) return
  }
}

/** Spread stress across syllables and mark boundaries, in place. */
export function spreadStress(state: StressState, attrs: Attrs): void {
  const { phonemes, stress, flags } = state

  let at = 1        // D0
  let spanStart = 2 // D2, where the current syllable's spread begins
  let vowel = 0     // D4, the last vowel's position; 0 for none
  let desc = 0      // D6, the descriptor being spread — persists across spans
  let lastAttrs = 0 // D3, the attributes of the last phoneme looked up

  for (;;) {
    at++
    const p = phonemes[at]

    // 0x11e4 and 0x11f6: a space or a phrase-final pause closes the span.
    // Note a space jumps here *without* looking the phoneme up, so `lastAttrs`
    // still describes whatever came before it — which 0x12a6 then tests.
    let boundary = p === 0
    if (!boundary) {
      if (p === TERMINATOR) return                       // 0x11ec
      lastAttrs = attrs[p] ?? 0
      boundary = (lastAttrs & ATTR.TERMINAL) !== 0
    }

    if (!boundary) {
      // 0x11fe: consonants are simply skipped.
      if (!(lastAttrs & ATTR.VOWEL)) continue
      // 0x1206: and these two are vowels by attribute only.
      if (p === LX || p === RX) continue

      if (vowel === 0) {
        // 0x1216: the first vowel of a span only records its position.
        vowel = at
        continue
      }

      // 0x121a: from the second vowel on, spread the *previous* vowel's
      // descriptor forward to the midpoint between the two.
      let n = at - vowel
      n = ((n - 1) >> 1) + vowel - spanStart
      desc = (((stress[vowel] & 0x10) << 1) | STRESS.SPREAD) & 0xff

      // 0x1234: a span starting on LX or RX gives it the descriptor without
      // the mark bit, and the spread proper starts one later.
      const first = phonemes[spanStart]
      if (first === LX || first === RX) {
        stress[spanStart] |= desc
        spanStart++
        n--
      }
      // 0x124c sits *outside* the loop — the `dbra` at 0x1258 branches to
      // 0x1252, not to it — so only the first byte of a spread is marked.
      // Putting it inside is the obvious reading and marks the whole span.
      stress[spanStart] |= STRESS.MARK
      dbra(n, () => {
        stress[spanStart] |= desc
        spanStart++
      })
      vowel = at
      continue
    }

    // ---------------------------------------------------------- 0x1262
    // A boundary. Close the span, then reset.
    const first = phonemes[spanStart]
    if (first === LX || first === RX) spanStart++
    stress[spanStart] |= STRESS.MARK

    if (vowel !== 0) {
      flags[vowel] |= FLAG.VOWEL
      // 0x1290: the descriptor keeps its SPREAD bit from the previous span
      // and only its STRESSED bit is recomputed. That carry-over is why this
      // reads as one running value rather than one per syllable.
      desc = ((desc & ~STRESS.STRESSED) | ((stress[vowel] & 0x10) << 1)) & 0xff
      dbra(at - spanStart - 1, () => {
        stress[spanStart] |= desc
        spanStart++
      })

      // 0x12a6: only a phrase-final pause marks back to the vowel. A plain
      // space does not, and `lastAttrs` being stale across a space is exactly
      // what makes that work.
      if (lastAttrs & ATTR.TERMINAL) {
        spanStart = vowel
        dbra(at - vowel - 1, () => {
          flags[spanStart] |= FLAG.PHRASE_END
          spanStart++
        })
      }
    }

    // 0x12c0: begin the next span after the boundary.
    spanStart = at + 1
    vowel = 0
    desc = 0
  }
}
