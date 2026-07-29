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

/**
 * The numerator of every pitch period this device computes — `hunk+0x1a9e`.
 *
 * 1,221,000 is exactly 11,100 x the default pitch of 110, and the whole
 * routine below is `constant / pitch / contourValue`. It is a constant in the
 * binary, so it assumes the default sample rate; changing `sampfreq` does not
 * move it.
 */
export const PERIOD_NUMERATOR = 0x12a188

/** The `pitch` the monotone mode uses regardless of the parameter. */
const MONOTONE_PITCH = 0x6e

/** Frame stride, and the offset of the pitch byte within a frame. */
const FRAME = 8
const PITCH_BYTE = 7

/** The four per-syllable arrays `hunk+0x2160` fills, one entry per vowel. */
export interface PitchArrays {
  /** The pitch at the peak. */
  peak: Uint8Array
  /** The pitch partway down. */
  middle: Uint8Array
  /** The pitch where the fall lands. */
  low: Uint8Array
  /** Bits 4-6 are a rise added back after the fall; zero means no third leg. */
  tail: Uint8Array
}

export interface PitchOptions {
  /** `A5+0x1c` — the device's `pitch` parameter. */
  pitch: number
  /** `A5+0x30` — 1 selects the monotone robot voice. */
  mode: number
}

/**
 * narrator.device's pitch pass — hunk+0x1a8e of build 33.2.
 *
 * It writes a period into the pitch byte of a *handful* of frames — the ones
 * the contour marker pinned — and leaves the rest at zero for the renderer's
 * last stage to interpolate between. So a captured frame array at this point
 * has three or four pitch values in it and nothing in between.
 *
 * Every value is `1221000 / pitch / v`, so a larger `v` in the arrays is a
 * *lower* note: they hold frequencies and the frame holds a period.
 *
 * Per syllable it pins up to four points — the peak on the syllable's first
 * frame, the low on the last frame before the fall, the middle at a position
 * weighted by how far the pitch has to travel between them, and, when the
 * fourth array is non-zero, a rise back up at the end of the voiced run. That
 * last one is the question intonation.
 */
export function assignPitch(
  state: ContourState & { flags: Uint8Array },
  arrays: PitchArrays,
  frames: Uint8Array,
  opts: PitchOptions,
): void {
  const { stress, flags } = state

  // 0x1a9e. The immediate is loaded twice; the first is dead.
  const c = Math.floor(PERIOD_NUMERATOR / opts.pitch) & 0xffff
  /** `divu.w`: 32-bit over 16-bit, quotient in the low word. */
  const period = (v: number): number => (v === 0 ? 0xff : Math.floor(c / v) & 0xff)

  if (opts.mode === 1) {
    // 0x1bca: one period everywhere, and it ignores `pitch` for the contour
    // even though `pitch` is still in `c`. This is the robot voice.
    const flat = period(MONOTONE_PITCH)
    for (let at = PITCH_BYTE; frames[at] !== 0xff; at += FRAME) frames[at] = flat
    return
  }

  let i = 0 // A1 and A2, which move together
  let v = 0 // A3, one step per syllable
  let at = 0 // A6, a byte offset into the frame array

  for (;;) {
    // -------------------------------------------------------------- 0x1ad2
    if (flags[i] === TERMINATOR) {
      // 0x1ada: `(-1,A3,0x100)` is the *previous* syllable's low, and it goes
      // on the frame before the cursor — the utterance's last pitch.
      frames[at - 1] = period(arrays.low[v - 1])
      return
    }
    const duration = flags[i] & 0x3f
    const peak = stress[i] & CONTOUR.PEAK
    i++
    if (!peak) {
      at += duration * FRAME
      continue
    }

    // -------------------------------------------------------------- 0x1b00
    const hi = arrays.peak[v]
    const mid = arrays.middle[v]
    const lo = arrays.low[v]
    // 0x1b2a: only bits 4-6, halved. Zero here means the contour stops at the
    // fall instead of rising again.
    const rise = (arrays.tail[v] & 0x70) >> 1
    v++

    frames[at + PITCH_BYTE] = period(hi)

    // 0x1b32: the run to the fall starts with the peak phoneme's own length,
    // which is why the entry is into the middle of the loop.
    let span = duration * FRAME
    for (;;) {
      const d = flags[i] & 0x3f
      const fall = stress[i] & CONTOUR.FALL
      i++
      if (fall) break
      span = (span + d * FRAME) & 0xffff
    }

    // 0x1b4e: with a third leg to come, the fall is squeezed into the first
    // half of the run — `n - n/2`, so an odd number of frames rounds up.
    let off = span
    if (rise !== 0) {
      const f = off >> 3
      off = ((f - (f >> 1)) << 3) & 0xffff
    }
    frames[at + off - 1] = period(lo)

    // 0x1b66: the middle is placed by how far the pitch has to travel on each
    // leg, not at the halfway point in time — a big drop early puts it early.
    let travel = Math.abs(((hi - mid) << 16) >> 16) & 0xffff
    const scaled = (travel << 5) & 0xffff
    travel = (travel + (Math.abs(((mid - lo) << 16) >> 16) & 0xffff)) & 0xffff
    if (travel !== 0) {
      let atMid = Math.floor(scaled / travel) & 0xffff
      atMid = (atMid * off) & 0xffff
      atMid = ((atMid >> 8) << 3) & 0xffff
      frames[at + atMid - 1] = period(mid)
    }

    // 0x1b90: step back over the phoneme that carried the fall — it is the
    // start of the next span, not the end of this one.
    i--
    at += span
    if (rise === 0) continue

    // -------------------------------------------------------------- 0x1ba0
    for (;;) {
      const d = flags[i] & 0x3f
      const end = stress[i] & CONTOUR.END
      i++
      if (end) break
      at += d * FRAME
    }
    frames[at - 1] = period((lo + rise) & 0xffff)
    i--
  }
}
