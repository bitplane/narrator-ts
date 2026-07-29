/**
 * narrator.device's prosody pass — hunk+0x1ee0 of build 33.2, and the five
 * routines it calls.
 *
 * This is the last stage of the front half to be read, and it is what decides
 * the *tune*. Everything before it works phoneme by phoneme; this works
 * syllable by syllable, one phrase at a time, and it is called round a loop —
 * `hunk+0x832` runs it, then `hunk+0x2160`, until it reports no phrase left.
 *
 * The five build up three arrays indexed by syllable:
 *
 * | | | |
 * |---|---|---|
 * | `0x1f02` | {@link scanPhrase} | `arr4`: how stressed each syllable is |
 * | `0x1fd8` | {@link markBoundaries} | `arr3`: where the phrase breaks are |
 * | `0x20bc` | {@link markVoiced} | `arr5`: seed every syllable with 1 |
 * | `0x20d0` | {@link markPunctuation} | `arr5`: `.` is 4, `?` is 8 |
 * | `0x210a` | {@link markCadence} | `arr3`: the final fall, or the rise |
 *
 * They are five separate `bsr`s that **share `D4`**, the syllable count, in a
 * register — none of the last four sets it up. So they are one routine split
 * five ways rather than five routines, and the count is threaded here.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Attribute bits this stage tests. */
const ATTR = {
  /** Bit 19: `.`, `?` and `,` — the things that end a phrase outright. */
  PHRASE_BREAK: 1 << 19,
  /** Bit 26: not spoken, so a boundary between syllables. */
  BOUNDARY: 1 << 26,
} as const

/** Bits of the stress byte. */
const STRESS = {
  /** 0x80: the spreader marked this phoneme as a syllable's start. */
  MARK: 0x80,
  /** 0x20: it carries stress. */
  STRESSED: 0x20,
  /** 0x40: it is inside a spread. */
  SPREAD: 0x40,
} as const

/** Values written into `arr4`, the per-syllable descriptor. */
export const SYLLABLE = {
  /** Bits 0-3: the scaled stress digit. */
  LEVEL: 0x0f,
  /** 0x20: a primary stress. */
  PRIMARY: 0x20,
  /** 0x40: the last syllable of the utterance. */
  LAST: 0x40,
  /** 0x80: a pause follows this syllable. */
  PAUSE: 0x80,
} as const

/** Phoneme indices this stage names outright. */
const FULL_STOP = 1
const QUESTION = 2
const DASH = 4

/** `hunk+0x1f02` gives up at this many syllables — `arr4` is 0x80 bytes. */
export const MAX_SYLLABLES = 0x80

/** The workspace scalars this stage keeps, by their `A5` offsets. */
export interface ProsodyCounters {
  /** `A5+0x88`: which pass round the loop this is. */
  pass: number
  /** `A5+0x8a`: primary stresses in this phrase. */
  stresses: number
  /** `A5+0x8c`: syllables in this phrase. */
  syllables: number
  /** `A5+0x8e`: the first primary stress, or the syllable count if none. */
  first: number
  /** `A5+0x90`: boundaries seen. */
  boundaries: number
  /** `A5+0x9e`: the last primary stress. */
  last: number
  /** `A5+0xa0`: syllables across the whole utterance. */
  total: number
}

export interface ProsodyState {
  phonemes: Uint8Array
  stress: Uint8Array
  flags: Uint8Array
  /** `A5+0x7c`, `+0x84` and `+0x80` — cursors, which each pass moves on. */
  atPhoneme: number
  atStress: number
  atFlag: number
  /** The eight `0x80`-byte arrays at `A5+0x6e8`. */
  arr: Uint8Array[]
  /**
   * `A5+0x5c`..`+0x78` hold a cursor into each of the eight, and they all
   * advance together — `hunk+0x2160` moves them past each phrase once it has
   * consumed it. So a routine here indexes from this rather than from zero,
   * and phrase two of an utterance writes where phrase one left off.
   */
  arrAt: number
  counters: ProsodyCounters
}

/**
 * The arrays this stage touches, by the names it uses them under.
 *
 * `MIDDLE` is `arr1`, which `hunk+0x1a8e` reads as the middle of each
 * syllable's pitch contour — it walks `arr0`, `arr1`, `arr2`, `arr3` in turn
 * for the peak, the middle, the low and the tail. Everything in the pitch
 * loop's body builds `arr1` first and derives the other two from it, so it is
 * the line the contour is hung on rather than one of its ends.
 */
const MIDDLE = 1
const CADENCE = 3
const DESCRIPTOR = 4
const VOICING = 5
/** `arr6`: how far above its middle a syllable's peak goes. */
const RISE = 6
/** `arr7`: how far below it the low goes. */
const FALL = 7

/**
 * hunk+0x1f02. Walk the next phrase and write one descriptor per syllable.
 *
 * A syllable here is a phoneme the stress spreader marked. Its level comes
 * from the stress digit the writer typed, scaled by 199/128 — so a `4` becomes
 * 6 — and a further 2 if the phoneme is inside a spread. Anything above 4
 * counts as a primary stress and is remembered as such.
 *
 * That scaling is the one place the digits 0-9 stop being a rank and become a
 * number the synthesizer does arithmetic with.
 *
 * Returns the syllable count, which the four routines after this one read out
 * of `D4` rather than recomputing, or `null` if the array overflowed.
 */
export function scanPhrase(state: ProsodyState, attrs: Attrs): number | null {
  const { phonemes, stress, flags, counters } = state
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)

  let p = state.atPhoneme
  let s = state.atStress
  let f = state.atFlag
  let n = 0 // D4, the syllable being written
  let firstPrimary = -1 // D5
  counters.stresses = 0

  for (;;) {
    // ------------------------------------------------------------ 0x1f24
    const phoneme = phonemes[p++]
    let mark = stress[s++]
    f++
    let extra = 0 // D6

    if (phoneme === TERMINATOR) {
      // 0x1fc0: the utterance ends here.
      arr4[n - 1] |= SYLLABLE.LAST
      if (counters.stresses === 0) firstPrimary = n
      counters.first = firstPrimary & 0xffff
      counters.syllables = n
      return n
    }

    const a = attrs[phoneme] ?? 0
    if (a & ATTR.BOUNDARY) {
      // 0x1f42: a space or a pause. The syllable before it is flagged, and a
      // `.`, `?` or `,` ends the phrase outright.
      counters.boundaries = (counters.boundaries + 1) & 0xffff
      arr4[n - 1] |= SYLLABLE.PAUSE
      if (a & ATTR.PHRASE_BREAK) {
        arr4[n - 1] |= SYLLABLE.LAST
        if (counters.stresses === 0) firstPrimary = n
        counters.first = firstPrimary & 0xffff
        counters.syllables = n
        return n
      }
      continue
    }

    // 0x1f58: only a marked phoneme opens a syllable.
    if (!(mark & STRESS.MARK)) continue

    // `D1` is still the whole stress byte here, and 0x1f9e masks it to the
    // low nibble at the end — so an unstressed syllable keeps the digit as
    // typed and only a stressed one gets the scaled value below.
    let level = mark
    if (mark & STRESS.STRESSED) {
      // 0x1f68: the digit sits in the low nibble, but the spreader may have
      // put the mark on a phoneme in front of the one that carries it, so
      // walk forward to the first non-zero digit.
      level = mark & 0x0f
      while (level === 0) {
        f++
        p++
        mark = stress[s++]
        level = mark & 0x0f
      }

      // 0x1f76: x199/128, and +2 inside a spread.
      level = ((level * 0xc7) & 0xffff) >> 7
      if (stress[s - 1] & STRESS.SPREAD) level += 2

      if (((level << 24) >> 24) > 4) {
        counters.stresses = (counters.stresses + 1) & 0xffff
        counters.last = n
        extra = SYLLABLE.PRIMARY
        if (firstPrimary < 0) firstPrimary = n
      }
    }

    // 0x1f9e: only the low nibble of the scaled level survives.
    arr4[n] = ((level & 0x0f) | extra) & 0xff
    n++
    counters.total = (counters.total + 1) & 0xffff
    // 0x1fb0: `arr4` is 0x80 bytes and this is where it gives up.
    if (counters.total === MAX_SYLLABLES) return null
    // The cursors are deliberately not written back: 0x1f02 reads them and
    // leaves them alone, and `markBoundaries` is what moves them on.
  }
}

/**
 * hunk+0x1fd8. Walk the same phrase again and record where it breaks, then
 * move the cursors past it.
 *
 * `arr3` gets `0x90` at a dash, and that is all it gets in this build.
 *
 * The other two markers, `2` and `0x0e`, come from bits 4 and 5 of the flag
 * byte, and **nothing in 33.2 ever sets them**. The parser zeroes the array,
 * the rewrite engine zeroes what it inserts, and the stress spreader writes
 * only `0x80` and `0x40`; every flag byte reaching here across the whole
 * corpus is one of 0, 0x40, 0x80 or 0xc0. So the marker-shuffling pass at the
 * end of this routine — which walks to the nearest primary stress and moves a
 * marker onto it, backwards for `0x0e` and forwards for `2` — can never run.
 *
 * It is ported anyway. It is real code with a clear meaning, it is what the
 * routine says, and 37.7 is a rewrite that may well feed it.
 */
export function markBoundaries(state: ProsodyState, attrs: Attrs): number {
  const { phonemes, stress, flags } = state
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)

  let p = state.atPhoneme
  let s = state.atStress
  let f = state.atFlag
  let n = 0 // D4 again, counted the same way

  for (;;) {
    // ------------------------------------------------------------ 0x1ff6
    const phoneme = phonemes[p++]
    const mark = stress[s++]
    const flag = flags[f++]

    if (phoneme === TERMINATOR) {
      // 0x2054: back the cursors up over the terminator so the next pass
      // starts on it and stops immediately.
      p--
      s--
      f--
      break
    }
    if (phoneme === DASH) {
      arr3[n - 1] |= 0x90
    } else {
      const a = attrs[phoneme] ?? 0
      // 0x2018: a real phrase break leaves the cursors *past* it, so the next
      // pass round the loop begins after the punctuation.
      if (a & ATTR.PHRASE_BREAK) break
    }

    // 0x201e
    if (mark & STRESS.MARK) n++
    if (flag & 0x20) {
      arr3[n - 1] = 2
      continue
    }
    if (!(flag & 0x10)) continue

    // 0x2038: the low nibble as a signed nibble.
    const v = ((arr3[n - 1] & 0x0f) << 4) >> 4
    if (v === 0 || v <= -2) arr3[n - 1] |= 0x0e
  }

  state.atPhoneme = p
  state.atStress = s
  state.atFlag = f

  // ---------------------------------------------------------------- 0x2066
  let carry = 0 // D7
  for (let i = n - 1; i >= 0; i--) {
    arr4[i] |= carry
    let at = i
    let step: number
    if (arr3[i] === 2) {
      step = 1
      carry = 0
    } else if (arr3[i] === 0x0e) {
      step = -1
      carry = 0x10
      arr4[i] |= carry
    } else {
      continue
    }

    // 0x2092: walk until a primary stress, then move the marker onto it.
    for (;;) {
      if (arr4[at] & SYLLABLE.PRIMARY) {
        arr3[at] = arr3[i]
        if (at !== i) arr3[i] = 0
        break
      }
      at += step
      if (at < 0 || at > n) {
        arr3[i] = 0
        break
      }
    }
  }
  return n
}

/**
 * hunk+0x20bc. Set bit 0 on every syllable of the phrase.
 *
 * `D4` is not loaded here — it is still the count `scanPhrase` left behind.
 */
export function markVoiced(state: ProsodyState, syllables: number): void {
  const arr5 = state.arr[VOICING].subarray(state.arrAt)
  for (let i = syllables - 1; i >= 0; i--) arr5[i] |= 1
}

/**
 * hunk+0x20d0. Record what the phrase ended with — `.` is 4, `?` is 8 —
 * backwards from the end until a syllable that a pause follows.
 *
 * A comma is neither, so it leaves nothing; the difference between a statement
 * and a question is decided here and read by {@link markCadence}.
 */
export function markPunctuation(state: ProsodyState, syllables: number): void {
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)

  const ended = state.phonemes[state.atPhoneme - 1]
  let code = 0
  if (ended === FULL_STOP) code = 4
  if (ended === QUESTION) code = 8

  for (let i = syllables - 1; i >= 0; i--) {
    arr5[i] |= code
    // `dbne`: the syllable a pause follows is included, then it stops.
    if (arr4[i] & SYLLABLE.PAUSE) return
  }
}

/**
 * hunk+0x210a. Give the phrase its cadence: `0xb0` normally, `0x30` after a
 * question, and a `4` on the last primary stress.
 *
 * It does nothing at all when the phrase ended on the punctuation itself —
 * the cursors are past it by then, so `(-1,A0)` is the `.` or `?` and this
 * returns. Only a phrase that ran out some other way gets a cadence.
 *
 * Which means **this** rise never fires. It is chosen by `arr5[n - 1] == 8`,
 * and 8 is what {@link markPunctuation} writes for a `?`; but a phrase that
 * ended in `?` has already returned two lines above, and in any case
 * {@link markVoiced} has put bit 0 into every entry first, so the value is 9
 * and never 8. Two independent reasons, either enough on its own.
 *
 * That is not to say 33.2 cannot ask a question. It does — in
 * {@link linkSyllables}, which reads the same `arr5` byte and inverts the
 * final fall into a rise, and which the corpus drives. This particular rise is
 * the dead one. Ported as written rather than "fixed".
 */
export function markCadence(state: ProsodyState, syllables: number): void {
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)
  const { counters } = state

  const ended = state.phonemes[state.atPhoneme - 1]
  if (ended === FULL_STOP || ended === QUESTION) return

  // 0x212e: a question ends up rising instead of falling.
  arr3[syllables - 1] |= arr5[syllables - 1] === 8 ? 0x30 : 0xb0

  if (counters.stresses === 0) return

  // 0x2144: back to the last primary stress, and mark it. `dbne` can leave
  // the index at -1, and the device would then write the byte before `arr3`;
  // a phrase with `stresses` non-zero always has one, so it does not happen.
  let i = syllables - 1
  for (;;) {
    if (arr4[i] & SYLLABLE.PRIMARY) break
    if (--i < 0) break
  }
  arr3[i] = ((arr3[i] & 0xf0) | 4) & 0xff
}

/**
 * hunk+0x1ee0. One pass round the driver's loop: find the next phrase and
 * describe it, or report that there is none left.
 *
 * The driver at `hunk+0x832` calls this, then `hunk+0x2160` to turn the
 * description into pitch values, and goes round again until this returns
 * false. `false` is the device's `Z` exit and comes straight from the
 * `move.w D4,(A5+0x8c)` that ends {@link scanPhrase} — a syllable count of
 * zero sets it, which is why the routine ends by storing the count rather
 * than by testing anything.
 *
 * Note the count the last three routines see is {@link markBoundaries}'s, not
 * {@link scanPhrase}'s. Both count phonemes the spreader marked, but the scan
 * can walk past some of them looking for a stress digit, so they are not
 * guaranteed to agree, and the device leaves whichever ran last in `D4`.
 */
export function nextPhrase(state: ProsodyState, attrs: Attrs): boolean {
  state.counters.pass = (state.counters.pass + 1) & 0xffff

  const found = scanPhrase(state, attrs)
  // 0x1eea: the overflow exit. The driver treats it as an error and abandons
  // the utterance rather than truncating it.
  if (found === null) return false
  if (found === 0) return false

  const syllables = markBoundaries(state, attrs)
  markVoiced(state, syllables)
  markPunctuation(state, syllables)
  markCadence(state, syllables)
  return true
}

/**
 * hunk+0x21b8. The pitch the phrase's first stressed syllable starts on.
 *
 * This is **declination**: the value falls as the utterance goes on. It is
 * built from how many phrases have been spoken (`pass`) and how many
 * boundaries have been crossed, not from anything about the syllable itself,
 * so the sixth phrase of a paragraph starts lower than the first — which is
 * what a speaker running out of breath actually does.
 *
 * The result is clamped to 125..165, and returned because `hunk+0x220c` picks
 * it up out of `D0` rather than reading it back.
 */
export function phrasePitch(state: ProsodyState): number {
  const { counters } = state
  const arr1 = state.arr[MIDDLE].subarray(state.arrAt)

  // 0x21bc: `divu.w`, so this is (boundaries + 4) / 3, truncated.
  const spread = Math.floor(((counters.boundaries + 4) & 0xffff) / 3)

  // 0x21c2: `(6 - pass) * 2`, floored at zero once six phrases have gone by.
  let rise = ((6 - counters.pass) << 1) & 0xffff
  if (rise & 0x8000) rise = 0

  let peak = ((rise * spread) & 0xffff) + 0x7b
  peak = (peak - ((counters.pass << 3) & 0xffff)) & 0xffff

  // 0x21f2: a floor of 125 and a ceiling of 165, in that order.
  const signed = (peak << 16) >> 16
  if (signed <= 0x7d) peak = 0x7d
  if (((peak << 16) >> 16) >= 0xa5) peak = 0xa5

  arr1[counters.first] = peak & 0xff
  return peak
}

/** `ext.w` and `ext.l` — sign-extend the low byte, and the low word. */
const sb = (v: number): number => ((v & 0xff) << 24) >> 24
const sw = (v: number): number => ((v & 0xffff) << 16) >> 16

/** `muls.w`: both operands are low words, and the result is a longword. */
const muls = (a: number, b: number): number => sw(a) * sw(b)

/**
 * The rounding idiom the rest of the pitch loop's body is built out of:
 * `bpl` on the product, then `addi.w #$40` or `subi.w #$40`, then `asr.w #7`.
 *
 * It is a divide by 128 rounding to nearest and away from zero, and it is
 * written out longhand at every one of the eleven places it appears. The sign
 * test is on the whole longword the `muls.w` produced; the rounding and the
 * shift are on its low word only.
 */
const round7 = (v: number): number => sw(sw(v) + (v < 0 ? -0x40 : 0x40)) >> 7

/**
 * hunk+0x220c. Give every stressed syllable of the phrase its middle pitch.
 *
 * {@link phrasePitch} has put a value on the first one; this walks the rest and
 * steps down from it, landing on 110 at the last — 115 if the phrase ended in
 * a question mark, which is the only effect a `?` has on this build's contour
 * and the only place the question survives at all.
 *
 * Three passes, in one routine:
 *
 * 1. **0x224c** — share the whole fall out over the phrase's primary stresses,
 *    but give the first and the last 19/128 of a step extra and take it back
 *    evenly from the ones in between. So the pitch drops fastest at each end
 *    of the phrase and coasts through the middle, which is what declination
 *    actually looks like. Below four stresses there is no middle to take it
 *    from and every step is equal.
 * 2. **0x2274** — backwards, pulling each stressed syllable 51/128 of the way
 *    towards a neighbour. Dead in 33.2: the neighbour is chosen by the low two
 *    bits of `arr5`, {@link markVoiced} puts a 1 in every entry of it before
 *    this runs, and 1 is the "leave it alone" case.
 * 3. **0x22d6** — scale by how stressed each syllable is. A level above 8 is
 *    pushed further above 110 and one below 8 pulled back towards it, in
 *    proportion to how far above 110 it already sits, so the contrast between
 *    a strong and a weak stress opens up at the top of the phrase and closes
 *    at the bottom.
 *
 * `pitch` is {@link phrasePitch}'s result, which the device leaves in `D0`.
 */
export function syllablePitch(state: ProsodyState, pitch: number): void {
  const { counters } = state
  const arr1 = state.arr[MIDDLE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)

  // 0x2214: what the phrase falls to. `arr5` bits 2-3 are the punctuation
  // {@link markPunctuation} recorded, and 8 is a question mark.
  const floor = (arr5[counters.syllables - 1] & 0x0c) === 8 ? 0x73 : 0x6e

  // 0x222c: `sub.b` then `divu.w`. `hunk+0x2160` has already checked the
  // phrase has a primary stress in it, which is what stops the divide by zero.
  const drop = Math.floor(((pitch - floor) & 0xff) / counters.stresses) & 0xffff

  let big = drop
  let small = drop
  if (sw(counters.stresses) >= 4) {
    // 0x2238: `mulu.w` writes a longword and `lsr.w` shifts only half of it,
    // so this is the low word of the product, not the product.
    const extra = ((drop * 0x13) & 0xffff) >> 7
    big = (drop + extra) & 0xffff
    small = (drop - Math.floor(((extra << 1) & 0xffff) / (counters.stresses - 3))) & 0xffff
  }

  // ------------------------------------------------------------------ 0x224c
  // The device tests at the bottom, so this runs once even when the first
  // stress is the last syllable — it reads one descriptor past the phrase.
  // That byte belongs to a syllable not yet written, so it is zero and nothing
  // comes of it; in the device it is the first byte of `arr5`.
  let step = big & 0xff
  let level = arr1[counters.first]
  let i = (counters.first + 1) & 0xffff
  for (;;) {
    if (arr4[i] & SYLLABLE.PRIMARY) {
      // 0x225e: the last primary stress takes the big step too.
      if (i === counters.last) step = big & 0xff
      level = (level - step) & 0xff
      arr1[i] = level
      step = small & 0xff
    }
    i = (i + 1) & 0xffff
    if (sw(counters.syllables) <= sw(i)) break
  }

  // ------------------------------------------------------------------ 0x2274
  /** The last stressed syllable this pass looked at — `D2`, and it moves down. */
  let after = counters.last
  for (let j = counters.last; ; j--) {
    if (arr4[j] & SYLLABLE.PRIMARY) {
      const towards = arr5[j] & 3
      if (towards === 0) {
        // 0x22b6: away from the syllable after it, so the two spread apart.
        let d = sb(arr1[j] - arr1[after])
        if (d >= 0) d = -d
        arr1[j] = (arr1[j] + (((d * 0x33) >> 7) & 0xff)) & 0xff
      } else if (towards !== 1) {
        // 0x2290: towards the previous stressed syllable. Reaching the first
        // one ends the pass outright rather than skipping it.
        if (sw(j) <= sw(counters.first)) break
        // 0x229a: `dbne`, so a run with no stress in it leaves the index at
        // -1 and the device reads the byte before `arr1`. It cannot happen —
        // `first` is a primary stress by construction and `j` is past it.
        let k = (j - 1) & 0xffff
        while (!(arr4[k] & SYLLABLE.PRIMARY)) {
          k = (k - 1) & 0xffff
          if (k === 0xffff) break
        }
        let d = sb(arr1[j] - arr1[k])
        if (d < 0) d = -d
        arr1[j] = (arr1[j] + (((d * 0x33) >> 7) & 0xff)) & 0xff
      }
      after = j
    }
    if (j === 0) break
  }

  // ------------------------------------------------------------------ 0x22d6
  for (let k = counters.last; ; k--) {
    const descriptor = arr4[k]
    if (descriptor & SYLLABLE.PRIMARY) {
      const weight = sw((descriptor & SYLLABLE.LEVEL) - 8)
      // `mulu.w`, so a syllable that has already fallen below 110 wraps to a
      // large positive here instead of going negative — the routine assumes
      // the fall lands on the floor and never undershoots it.
      const above = ((((arr1[k] - 0x6e) & 0xffff) * 0x0d) & 0xffff) >>> 7
      arr1[k] = (arr1[k] + weight * sw(above)) & 0xff
    }
    if (k === 0) break
  }
}

/**
 * hunk+0x230c. How far each stressed syllable's contour swings above and below
 * the middle {@link syllablePitch} gave it.
 *
 * `arr6` is the rise and `arr7` the fall, and `hunk+0x2864` finally adds them
 * to `arr0` and `arr2` — the peak and the low that `hunk+0x1a8e` reads. Both
 * are proportional to how far the syllable's middle sits above 110, so a
 * syllable that has already fallen to the floor of the phrase gets no contour
 * at all and the utterance flattens out as it ends.
 *
 * The shape of the swing is set by the low nibble of the cadence byte, read as
 * a *signed* nibble: the rise is `(26·cadence + 128)/128` of the distance and
 * the fall is `(cadence − 1)·26/128` of it. A cadence of 4 — what
 * {@link markCadence} puts on the last primary stress of a phrase — gives a
 * rise nearly twice the default and a fall three times it, which is the
 * sentence-final drop.
 *
 * A negative nibble would invert the rise, and none is reachable: the only
 * values anything puts in that nibble are 0 and the 4 {@link markCadence}
 * writes, the 2 and the 0x0e of {@link markBoundaries} both coming from flag
 * bits nothing in 33.2 sets.
 *
 * The fall is clipped at zero rather than allowed to go negative, so it can
 * flatten but never turn into a second rise.
 */
export function syllableRange(state: ProsodyState): void {
  const { counters } = state
  const arr1 = state.arr[MIDDLE].subarray(state.arrAt)
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr6 = state.arr[RISE].subarray(state.arrAt)
  const arr7 = state.arr[FALL].subarray(state.arrAt)

  for (let i = counters.last; ; i--) {
    if (arr4[i] & SYLLABLE.PRIMARY) {
      // 0x232e: everything below is a fraction of this.
      const above = sw(arr1[i] - 0x6e)
      // 0x233a: the low nibble, sign-extended by hand.
      const nibble = arr3[i] & 0x0f
      const cadence = sw(nibble | (nibble & 0x08 ? 0xfff0 : 0))

      // 0x2346: two shifts of seven with a `muls.w` between them, so the
      // 51/128 is applied to a value already divided by 128.
      let rise = muls(cadence, 0x1a) + 0x80
      rise = muls(rise, above) >>> 7
      arr6[i] = (muls(rise, 0x33) >>> 7) & 0xff

      // 0x235e: `neg.b` and `bpl`, so the clip is on the byte.
      const fall = (-(muls(muls(cadence - 1, above), 0x1a) >>> 7)) & 0xff
      arr7[i] = fall & 0x80 ? 0 : fall

      // 0x2374: a further −38/128 on both, for a syllable carrying the marker
      // `hunk+0x1fd8` moves onto a primary stress and no cadence of its own.
      // Dead in 33.2 for the same reason that marker is: bit 4 of the flag
      // byte is what puts it there, and nothing ever sets it.
      if (arr4[i] & 0x10 && (cadence & 0xff) === 0) {
        arr6[i] = (arr6[i] + round7(muls(sb(arr6[i]), -38))) & 0xff
        arr7[i] = (arr7[i] + round7(muls(sb(arr7[i]), -38))) & 0xff
      }
    }
    if (i === 0) break
  }

  // 0x23c0: the phrase's first stressed syllable rises by the whole distance
  // rather than a fraction of it, so it is the one that reaches the peak the
  // declination picked.
  arr6[counters.first] = (arr1[counters.first] - 0x6e) & 0xff
}

/**
 * hunk+0x23ce. Reconcile each stressed syllable with the next one, and give
 * the phrase its final punctuation.
 *
 * Two halves. The first walks the primary stresses backwards in pairs and
 * adjusts both by how far apart they are:
 *
 * - **Back to back** (0x23f8) — both swings shrink to 77/128, the earlier
 *   middle drops 26/128 of its height and the later one rises by the same,
 *   and then whatever gap is left between the earlier syllable's low and the
 *   later one's is closed outright by deepening one or raising the other.
 *   Two stresses in a row have no room for two full contours, so they are
 *   flattened and butted together.
 * - **Anything further apart** (0x2496) — both swings *grow*, by 19, 32 or 38
 *   parts in 128 as the gap is one, two or more syllables, and the middles
 *   move apart rather than together. With room between them each stress gets
 *   its own excursion, and the more room the bigger.
 *
 * The second half (0x2574) is the punctuation, on any stressed syllable a
 * pause follows:
 *
 * - **A full stop** puts the low a flat 75 below the middle.
 * - **A question** raises the peak by 102/128 of the fall and then sets the
 *   fall from the *highest* middle anywhere earlier in the phrase, times
 *   154/128. That is bigger than the syllable's own middle, so the result
 *   goes negative and the low ends up above the middle rather than below it.
 *
 * So 33.2 does speak a question differently — here, in arithmetic, rather than
 * through the rise flag in {@link markCadence} that no input can select.
 */
export function linkSyllables(state: ProsodyState): void {
  const { counters } = state
  const arr1 = state.arr[MIDDLE].subarray(state.arrAt)
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)
  const arr6 = state.arr[RISE].subarray(state.arrAt)
  const arr7 = state.arr[FALL].subarray(state.arrAt)

  // ------------------------------------------------------------------ 0x23e0
  /** `D1`: the stressed syllable above this one, which only it moves on. */
  let next = counters.last
  for (let i = counters.last - 1; i >= 0; i--) {
    if (!(arr4[i] & SYLLABLE.PRIMARY)) continue
    // 0x23ea: `next - i - 2`, so zero means exactly one syllable between them
    // and there is nothing to reconcile.
    const gap = sw(next - i - 2)

    if (gap < 0) {
      arr6[i] = (arr6[i] + round7(muls(sb(arr6[i]), -0x33))) & 0xff
      arr6[next] = (arr6[next] + round7(muls(sb(arr6[next]), -0x33))) & 0xff
      arr1[i] = (arr1[i] + round7(muls(arr1[i] - 0x6e, -0x1a))) & 0xff
      arr1[next] = (arr1[next] + round7(muls(arr1[next] - 0x6e, 0x1a))) & 0xff

      // 0x2474: what is left between this syllable's low and the next one's,
      // all in bytes, and `bpl` on the byte.
      const d = (arr1[i] - arr7[i] - arr1[next] + arr6[next]) & 0xff
      if (sb(d) < 0) arr6[next] = (arr6[next] - d) & 0xff
      else arr7[i] = (arr7[i] + d) & 0xff
    } else if (gap > 0) {
      // 0x2498, 0x24e6 and 0x2512: three ladders of the same shape, each
      // reading the gap back off the stack.
      const widen = gap === 1 ? 0x13 : gap === 2 ? 0x20 : 0x26
      arr6[i] = (arr6[i] + round7(muls(sb(arr6[i]), widen))) & 0xff
      arr6[next] = (arr6[next] + round7(muls(sb(arr6[next]), widen))) & 0xff
      arr1[next] = (arr1[next] + round7(muls(arr1[next] - 0x6e, gap === 1 ? -0x13 : -0x20))) & 0xff
      arr1[i] = (arr1[i] + round7(muls(arr1[i] - 0x6e, gap === 1 ? 0x0d : 0x13))) & 0xff

      // 0x2542: bit 4 again, and dead for the same reason. When it is set a
      // cadence nibble of zero, or a negative one, skips what follows.
      const marked = arr4[next] & 0x10
      const nibble = arr3[next] & 0x0f
      if (!(marked && (nibble === 0 || nibble & 0x08)) && gap >= 2) {
        // 0x2562: far enough apart, and the later swing is set outright.
        arr6[next] = (arr1[next] - 0x69) & 0xff
      }
    }
    next = i
  }

  // ------------------------------------------------------------------ 0x2574
  for (let i = counters.last; ; i--) {
    const descriptor = arr4[i]
    if (descriptor & SYLLABLE.PRIMARY && descriptor & SYLLABLE.PAUSE) {
      const punctuation = arr5[i] & 0x0c
      if (punctuation === 8) {
        // 0x25ac: a question.
        let d1 = round7(muls(sb(arr7[i]), 0x66))
        arr6[i] = (arr6[i] + d1) & 0xff

        // 0x25ca: the highest middle from here back to the start of the
        // phrase — `cmp.w` with `bgt`, so this keeps the larger.
        //
        // `D1` is not cleared first: only its low byte is replaced each time
        // round, and its high byte is left over from the rounding above. When
        // that rounding came out negative the high byte is 0xff, every
        // comparison is against a negative word, and the highest stays this
        // syllable's own middle however low it is.
        let d7 = arr1[i]
        for (let k = i - 1; k >= 0; k--) {
          d1 = (d1 & 0xff00) | arr1[k]
          if (sw(d7) <= sw(d1)) d7 = (d7 & 0xff00) | (d1 & 0xff)
        }

        // 0x25e2: 154/128 of it, which is more than this syllable's own
        // middle — so the fall comes out negative and rises instead.
        arr7[i] = (arr1[i] - ((((d7 & 0xffff) * 0x9a) & 0xffff) >> 7)) & 0xff
      } else if (punctuation === 4) {
        // 0x259c: a full stop drops a flat 75.
        arr7[i] = (arr1[i] - 0x4b) & 0xff
      }
    }
    if (i === 0) break
  }
}
