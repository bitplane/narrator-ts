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
import { invalidVoice } from './error.js'

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
 * A syllable's pitch is three numbers: where it starts, how high it gets, and
 * where it ends. `hunk+0x1a8e` reads them out of `arr0`, `arr1` and `arr2` in
 * that order and pins the frames accordingly, so `arr1` is the *peak* despite
 * sitting between the other two in memory. All three are frequencies, and a
 * larger one is a higher note.
 *
 * The whole pitch loop's body builds `arr1` first and holds the other two as
 * distances below it — `arr6` how far the syllable climbs from its start,
 * `arr7` how far it drops to its end. `hunk+0x2642` finally subtracts them.
 * A negative distance is therefore a syllable that goes *up*, which is how a
 * question is spoken.
 */
/** `arr0`: the pitch the syllable starts on. */
const ONSET = 0
const PEAK = 1
/** `arr2`: the pitch it ends on. */
const END = 2
const CADENCE = 3
const DESCRIPTOR = 4
const VOICING = 5
/** `arr6`: how far the syllable climbs from its onset to its peak. */
const CLIMB = 6
/** `arr7`: how far it drops from its peak to its end. */
const DROP = 7

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
    if (p >= phonemes.length || s >= stress.length || f >= flags.length) invalidVoice()
    // ------------------------------------------------------------ 0x1f24
    const phoneme = phonemes[p++]
    let mark = stress[s++]
    f++
    let extra = 0 // D6

    if (phoneme === TERMINATOR) {
      // 0x1fc0: the utterance ends here.
      if (n === 0) {
        if (counters.stresses === 0) firstPrimary = n
        counters.first = firstPrimary & 0xffff
        counters.syllables = n
        return n
      }
      arr4[n - 1] |= SYLLABLE.LAST
      if (counters.stresses === 0) firstPrimary = n
      counters.first = firstPrimary & 0xffff
      counters.syllables = n
      return n
    }

    const a = attrs[phoneme] ?? 0
    if (a & ATTR.BOUNDARY) {
      if (n === 0) invalidVoice()
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
        if (p >= phonemes.length || s >= stress.length || f >= flags.length) invalidVoice()
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
    if (state.arrAt + n >= state.arr[DESCRIPTOR].length) invalidVoice()
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
    if (p >= phonemes.length || s >= stress.length || f >= flags.length) invalidVoice()
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
      if (n === 0) invalidVoice()
      arr3[n - 1] |= 0x90
    } else {
      const a = attrs[phoneme] ?? 0
      // 0x2018: a real phrase break leaves the cursors *past* it, so the next
      // pass round the loop begins after the punctuation.
      if (a & ATTR.PHRASE_BREAK) break
    }

    // 0x201e
    if (mark & STRESS.MARK) {
      if (state.arrAt + n >= state.arr[CADENCE].length) invalidVoice()
      n++
    }
    if (flag & 0x20) {
      if (n === 0) invalidVoice()
      arr3[n - 1] = 2
      continue
    }
    if (!(flag & 0x10)) continue

    // 0x2038: the low nibble as a signed nibble.
    if (n === 0) invalidVoice()
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
  if (syllables <= 0 || state.arrAt + syllables > state.arr[0].length) invalidVoice()
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
  const arr1 = state.arr[PEAK].subarray(state.arrAt)

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
 * hunk+0x220c. Give every stressed syllable of the phrase its peak pitch.
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
  const arr1 = state.arr[PEAK].subarray(state.arrAt)
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
 * hunk+0x230c. How far each stressed syllable climbs to the peak
 * {@link syllablePitch} gave it, and how far it drops away again.
 *
 * `arr6` is the climb and `arr7` the drop, both as distances *below* the peak,
 * and `hunk+0x2642` finally subtracts them to get the syllable's onset and its
 * end. Both are proportional to how far the peak sits above 110, so a syllable
 * that has already fallen to the floor of the phrase gets no contour at all
 * and the utterance flattens out as it ends.
 *
 * The shape is set by the low nibble of the cadence byte, read as a *signed*
 * nibble: the climb is `(26·cadence + 128)/128` of that distance and the drop
 * is `(cadence − 1)·26/128` of it. A cadence of 4 — what {@link markCadence}
 * puts on the last primary stress of a phrase — makes the climb nearly twice
 * the default and the drop three times it, which is the sentence-final fall.
 *
 * A negative nibble would invert the climb, and none is reachable: the only
 * values anything puts in that nibble are 0 and the 4 {@link markCadence}
 * writes, the 2 and the 0x0e of {@link markBoundaries} both coming from flag
 * bits nothing in 33.2 sets.
 *
 * The drop is clipped at zero rather than allowed to go negative here, so at
 * this stage a syllable can end level with its peak but never above it. Only
 * {@link linkSyllables} lifts it above, and only for a question.
 */
export function syllableRange(state: ProsodyState): void {
  const { counters } = state
  const arr1 = state.arr[PEAK].subarray(state.arrAt)
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr6 = state.arr[CLIMB].subarray(state.arrAt)
  const arr7 = state.arr[DROP].subarray(state.arrAt)

  for (let i = counters.last; ; i--) {
    if (arr4[i] & SYLLABLE.PRIMARY) {
      // 0x232e: everything below is a fraction of this.
      const above = sw(arr1[i] - 0x6e)
      // 0x233a: the low nibble, sign-extended by hand.
      const nibble = arr3[i] & 0x0f
      const cadence = sw(nibble | (nibble & 0x08 ? 0xfff0 : 0))

      // 0x2346: two shifts of seven with a `muls.w` between them, so the
      // 51/128 is applied to a value already divided by 128.
      let climb = muls(cadence, 0x1a) + 0x80
      climb = muls(climb, above) >>> 7
      arr6[i] = (muls(climb, 0x33) >>> 7) & 0xff

      // 0x235e: `neg.b` and `bpl`, so the clip is on the byte.
      const drop = (-(muls(muls(cadence - 1, above), 0x1a) >>> 7)) & 0xff
      arr7[i] = drop & 0x80 ? 0 : drop

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

  // 0x23c0: the phrase's first stressed syllable climbs the whole distance
  // rather than a fraction of it, so it is the one that starts down at 110 and
  // reaches the peak the declination picked.
  arr6[counters.first] = (arr1[counters.first] - 0x6e) & 0xff
}

/**
 * hunk+0x23ce. Reconcile each stressed syllable with the next one, and give
 * the phrase its final punctuation.
 *
 * Two halves. The first walks the primary stresses backwards in pairs and
 * adjusts both by how far apart they are:
 *
 * - **Back to back** (0x23f8) — both contours shrink to 77/128, the earlier
 *   peak drops 26/128 of its height and the later one rises by the same, and
 *   then whatever gap is left between where the earlier syllable ends and the
 *   later one starts is closed outright. Two stresses in a row have no room
 *   for two full contours, so they are flattened and butted together.
 * - **Anything further apart** (0x2496) — both contours *grow*, by 19, 32 or
 *   38 parts in 128 as the gap is one, two or more syllables, and the peaks
 *   move apart rather than together. With room between them each stress gets
 *   its own excursion, and the more room the bigger.
 *
 * The second half (0x2574) is the punctuation, on any stressed syllable a
 * pause follows:
 *
 * - **A full stop** ends the syllable a flat 75 below its peak.
 * - **A question** shortens the climb by 102/128 of the drop and then rebuilds
 *   the drop from the *highest* peak anywhere earlier in the phrase, times
 *   154/128. That is larger than this syllable's own peak, so the drop comes
 *   out negative and the syllable ends *above* where it peaked.
 *
 * So 33.2 does speak a question differently — here, in arithmetic, rather than
 * through the rise flag in {@link markCadence} that no input can select.
 */
export function linkSyllables(state: ProsodyState): void {
  const { counters } = state
  const arr1 = state.arr[PEAK].subarray(state.arrAt)
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)
  const arr6 = state.arr[CLIMB].subarray(state.arrAt)
  const arr7 = state.arr[DROP].subarray(state.arrAt)

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

        // 0x25ca: the highest peak from here back to the start of the
        // phrase — `cmp.w` with `bgt`, so this keeps the larger.
        //
        // `D1` is not cleared first: only its low byte is replaced each time
        // round, and its high byte is left over from the rounding above. When
        // that rounding came out negative the high byte is 0xff, every
        // comparison is against a negative word, and the highest stays this
        // syllable's own peak however low it is.
        let d7 = arr1[i]
        for (let k = i - 1; k >= 0; k--) {
          d1 = (d1 & 0xff00) | arr1[k]
          if (sw(d7) <= sw(d1)) d7 = (d7 & 0xff00) | (d1 & 0xff)
        }

        // 0x25e2: 154/128 of it, which is more than this syllable's own
        // peak — so the drop comes out negative and the syllable rises.
        arr7[i] = (arr1[i] - ((((d7 & 0xffff) * 0x9a) & 0xffff) >> 7)) & 0xff
      } else if (punctuation === 4) {
        // 0x259c: a full stop ends a flat 75 below the peak.
        arr7[i] = (arr1[i] - 0x4b) & 0xff
      }
    }
    if (i === 0) break
  }
}

/**
 * hunk+0x25f8. Deepen the drop at a phrase boundary.
 *
 * The high nibble of the cadence byte is what {@link markCadence} and
 * {@link markBoundaries} put there: `0xb0` on the phrase's last syllable and
 * `0x90` on the one before a dash. Either adds 38/128 to that syllable's drop,
 * so the pitch falls half again as far at the end of a phrase as it does
 * inside one. That, and not the cadence flag, is what a comma sounds like.
 *
 * The other arm takes 102/128 *off* the drop instead, and is unreachable: it
 * wants the high nibble non-zero with bit 7 clear, and the only two values
 * that can put anything in that nibble both set bit 7. Its two possible
 * sources — the `2` and the `0x0e` of {@link markBoundaries} — need flag bits
 * nothing in 33.2 sets.
 */
export function boundaryFall(state: ProsodyState): void {
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr7 = state.arr[DROP].subarray(state.arrAt)

  // `D4`, which hunk+0x2160 loaded from A5+0x8c at the top and none of the
  // seven reloads — so it is scanPhrase's count, not markBoundaries'.
  for (let i = state.counters.syllables - 1; i >= 0; i--) {
    const mark = arr3[i] & 0xf0
    if (mark === 0) continue
    const by = mark & 0x80 ? 0x26 : -0x66
    arr7[i] = (arr7[i] + round7(muls(sb(arr7[i]), by))) & 0xff
  }
}

/**
 * The step table at `hunk+0x29ca`, in 128ths, and the three windows into it.
 *
 * A run of unstressed syllables between two stresses glides from where the
 * first one ended down towards where the second one starts, and this is how
 * much of the step each syllable of the run takes. The factors *compound* —
 * each is applied to what the last one left — so a long run's glide is steep
 * at first and then flattens out.
 *
 * Whatever the run's length, only the first three syllables of it glide. The
 * device picks a shorter window for a shorter run rather than stretching one
 * window across it, so a single unstressed syllable takes the whole step in
 * one go and everything past the third sits flat.
 */
const GLIDE = [0x3a, 0x64, 0x49, 0x4d, 0x56, 0x80]
const GLIDE_WINDOW = [[5, 6], [3, 5], [0, 3]] as const

/**
 * hunk+0x29a2. Walk a run of syllables, each starting where the last one
 * ended and dropping a little further.
 *
 * `arr0` gets the previous syllable's end, so the pitch is continuous across
 * the run; `arr2` gets that minus the step; and `arr1` sits 5 above `arr2`, so
 * every one of these syllables has the same shallow contour rather than a flat
 * line. Returns the index it stopped on.
 */
function glide(
  arr0: Uint8Array,
  arr1: Uint8Array,
  arr2: Uint8Array,
  at: number,
  step: number,
  factors: readonly number[],
): number {
  for (const factor of factors) {
    arr0[at + 1] = arr2[at]
    // 0x29aa: `mulu.w` then `lsr.w #7`, so the step is scaled before it is
    // used and the next syllable inherits the smaller one.
    step = (((step & 0xffff) * factor) & 0xffff) >>> 7
    at++
    arr2[at] = (arr0[at] - step) & 0xff
    arr1[at] = (arr2[at] + 5) & 0xff
  }
  return at
}

/**
 * hunk+0x2642. Turn the peaks and their two distances into three real pitches
 * per syllable, and fill in every syllable that has not got one.
 *
 * Up to here only the primary stresses have been touched, and each is held as
 * a peak with a climb and a drop hanging off it. This is where that becomes
 * `arr0`, `arr1`, `arr2` — an onset, a peak and an end — for *every* syllable
 * of the phrase, which is what `hunk+0x1a8e` needs.
 *
 * Four passes:
 *
 * 1. **0x265e** — subtract: onset is peak minus climb, end is peak minus drop.
 * 2. **0x2680** — take the stresses in pairs and fill the gap between them.
 *    If the earlier syllable ends below where the later one starts, the two
 *    are moved half the distance towards each other first, so the line never
 *    has to climb backwards. Then the run between them glides down through
 *    {@link GLIDE}.
 * 3. **0x277e** — everything *before* the phrase's first stress sits flat at
 *    110, with its peak lifted by twice its own stress level. An unstressed
 *    lead-in is spoken at the bottom of the range.
 * 4. **0x27a8** — everything *after* the last stress. Here the step is not
 *    from a table: it is the whole remaining distance down to 110, divided
 *    evenly by however many syllables are left, so the tail always lands on
 *    the floor whatever its length. A full stop aims 35 lower still and ends
 *    on 75; a comma or nothing ends on 110; a question does something else
 *    entirely and ends on 154/128 of the phrase's highest peak.
 */
export function fillContours(state: ProsodyState): void {
  const { counters } = state
  const arr0 = state.arr[ONSET].subarray(state.arrAt)
  const arr1 = state.arr[PEAK].subarray(state.arrAt)
  const arr2 = state.arr[END].subarray(state.arrAt)
  const arr3 = state.arr[CADENCE].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr5 = state.arr[VOICING].subarray(state.arrAt)
  const arr6 = state.arr[CLIMB].subarray(state.arrAt)
  const arr7 = state.arr[DROP].subarray(state.arrAt)

  // ------------------------------------------------------------------ 0x265e
  for (let i = counters.last; ; i--) {
    if (arr4[i] & SYLLABLE.PRIMARY) {
      arr0[i] = (arr1[i] - arr6[i]) & 0xff
      arr2[i] = (arr1[i] - arr7[i]) & 0xff
    }
    if (i === 0) break
  }

  // ------------------------------------------------------------------ 0x2680
  let scan = counters.first
  let remaining = counters.stresses
  for (;;) {
    let at = scan
    let step = 0
    // 0x268a: one gap fewer than there are stresses.
    remaining = sw(remaining - 1)
    if (remaining <= 0) break

    // 0x2694: forward to the next primary stress.
    do {
      scan = (scan + 1) & 0xffff
    } while (!(arr4[scan] & SYLLABLE.PRIMARY))

    // 0x269e: syllables strictly between the two. None, and there is nothing
    // to fill in.
    const between = sw(scan - at - 1)
    if (between === 0) continue

    // 0x26a6: does the earlier one end below where the later one starts?
    step = (arr2[at] - arr0[scan]) & 0xff
    if (sb(step) < 0) {
      // 0x26b0: move both half way towards the other, adjusting the climb and
      // the drop to match so the peaks stay where they are.
      const half = ((-step) & 0xff) >>> 1
      arr0[scan] = (arr0[scan] - half) & 0xff
      arr6[scan] = (arr6[scan] + half) & 0xff
      arr2[at] = (arr2[at] + half) & 0xff
      arr7[at] = (arr7[at] - half) & 0xff
      step = 0
    }

    // 0x26ca: a cadence below 8 on a syllable carrying the moved marker
    // spreads the step evenly instead of using the table. Dead, as everywhere
    // else that marker is tested — nothing sets flag bit 4.
    if (sb(arr3[at] & 0x0f) < 8 && arr4[at] & 0x10) {
      // 0x26e4
      step = Math.floor(step / between)
      for (let k = 0; k < between; k++) {
        arr0[at + 1] = arr2[at]
        at++
        arr2[at] = (arr0[at] - step) & 0xff
        arr1[at] = (arr2[at] + 5) & 0xff
      }
      continue
    }

    // 0x270c: one of the three windows, by how long the run is.
    if (between >= 3) {
      // 0x2718: a long run does not glide towards the next stress at all —
      // it glides towards 105, and only for its first three syllables.
      step = (arr2[at] - 0x69) & 0xff
    }
    const [from, to] = GLIDE_WINDOW[Math.min(between, 3) - 1]
    at = glide(arr0, arr1, arr2, at, step, GLIDE.slice(from, to))

    // 0x273a: the rest of a long run holds the pitch the glide left off on,
    // its peak lifted by twice its own stress level.
    for (let k = 0; k < between - 3; k++) {
      const held = arr2[at]
      at++
      arr0[at] = held
      arr2[at] = held
      arr1[at] = (held + ((arr4[at] & 0x0f) << 1)) & 0xff
    }
  }

  // ------------------------------------------------------------------ 0x277e
  for (let i = counters.first - 1; i >= 0; i--) {
    arr1[i] = (0x6e + ((arr4[i] & 0x0f) << 1)) & 0xff
    arr0[i] = 0x6e
    arr2[i] = 0x6e
  }

  // ------------------------------------------------------------------ 0x27a8
  const last = counters.syllables - 1
  // 0x27b2: a phrase ending on a stress has no tail, and is already done.
  if (arr4[last] & SYLLABLE.PRIMARY) return
  const punctuation = arr5[last] & 0x0c

  // 0x27c8: back to the last stressed syllable, or to 0 if there is none.
  let at = 0
  for (let i = last - 1; i >= 0; i--) {
    if (arr4[i] & SYLLABLE.PRIMARY) {
      at = i
      break
    }
  }

  const count = sw(last - at)
  if (count !== 0) {
    // 0x27da: `moveq` then `subi.w`, so a syllable already below 110 wraps to
    // a large positive and the tail climbs instead of falling.
    let step = (arr2[at] - 0x6e) & 0xffff
    // 0x27e4: a full stop aims 35 further down than the others.
    if (punctuation === 4) step = (step + 35) & 0xffff
    step = Math.floor(step / count)

    for (let k = 0; k < count; k++) {
      arr0[at + 1] = arr2[at]
      at++
      arr2[at] = (arr0[at] - step) & 0xff
      arr1[at] = (arr2[at] + 5) & 0xff
    }
  }

  // ------------------------------------------------------------------ 0x2812
  if (punctuation === 8) {
    // A question. The last syllable ends on 154/128 of the phrase's highest
    // peak — above everything in it, so the utterance finishes going up.
    let highest = 0
    for (let i = counters.syllables - 1; i >= 0; i--) {
      if (sw(highest) <= arr1[i]) highest = arr1[i]
    }
    highest = (((highest & 0xffff) * 0x9a) & 0xffff) >>> 7
    arr2[last] = highest & 0xff
    arr1[last] = (highest + 5) & 0xff
    // 0x2852: and no drop, so nothing later pulls it back down.
    arr7[last] = 0
    // 0x2856: with more than one syllable it starts where the one before it
    // ended, so the rise is the whole of this syllable rather than a jump.
    if (sw(counters.syllables) > 1) arr0[last] = arr2[last - 1]
    return
  }

  // 0x2818: a full stop ends on 75, anything else on 110.
  arr2[at] = 0x4b
  if (punctuation === 4) return
  arr2[at] = 0x6e
}

/**
 * hunk+0x2864. Squeeze each stressed syllable's contour by the consonants
 * around it — the last thing the pitch loop does.
 *
 * This is **consonantal F0 perturbation**, and it is the most linguistically
 * literate thing in the device after {@link intrinsicPitch}. A consonant
 * disturbs the pitch of the vowel next to it, and how much depends on whether
 * it is voiced: a voiceless one perturbs far more, because the larynx has to
 * stop and restart. Both ends of the syllable are treated separately.
 *
 * At the **onset** (0x28a0), only if the syllable begins with a consonant: the
 * start of the contour is moved up towards the peak by 26/128 of the climb
 * after a voiced consonant and 102/128 after a voiceless one — so a syllable
 * beginning `p` or `t` has almost no room to rise and one beginning `m` or `b`
 * keeps nearly all of it. A voiceless onset also lifts the whole contour by
 * 26/128 of its height first, which is the well-attested raising of F0 after a
 * voiceless stop.
 *
 * At the **end** (0x291a), by what the syllable runs into. The device walks
 * forward past the stress digit to the first phoneme that settles it:
 *
 * | | |
 * |---|---|
 * | 26/128 | a vowel or the glottal stop — the fall carries on into it |
 * | 86/128 | a voiceless phoneme first — most of the fall is eaten |
 * | 64/128 | a pause follows, or the next syllable is stressed too |
 *
 * Voiced consonants in between are stepped over, since they do not interrupt
 * the pitch. And a phrase whose last syllable is stressed is left alone, there
 * being nothing after it to run into.
 *
 * Each adjustment moves the endpoint and shrinks the distance by the same
 * amount, so the peak never moves and the three stay consistent.
 */
export function coarticulatePitch(state: ProsodyState, attrs: Attrs): void {
  const { counters, phonemes, stress } = state
  const arr0 = state.arr[ONSET].subarray(state.arrAt)
  const arr1 = state.arr[PEAK].subarray(state.arrAt)
  const arr2 = state.arr[END].subarray(state.arrAt)
  const arr4 = state.arr[DESCRIPTOR].subarray(state.arrAt)
  const arr6 = state.arr[CLIMB].subarray(state.arrAt)
  const arr7 = state.arr[DROP].subarray(state.arrAt)

  /** Bit 1 of the attributes, and bit 9 — a consonant, and voiced. */
  const CONSONANT = 1 << 1
  const VOICED = 1 << 9
  const VOWEL = 1 << 0
  /** Phoneme 47, the glottal stop. */
  const GLOTTAL = 0x2f

  // The three cursors, which walk backwards together one syllable at a time.
  let p = state.atPhoneme - 1
  let s = state.atStress - 1

  for (let i = counters.syllables - 1; i >= 0; i--) {
    // 0x287e: back to the phoneme the spreader marked as this syllable's
    // start. `tst.b -(A2)` and `bpl`, so it is looking for bit 7.
    do {
      if (p <= 0 || s <= 0) invalidVoice()
      p--
      s--
    } while (!(stress[s] & STRESS.MARK))

    if (!(arr4[i] & SYLLABLE.PRIMARY)) continue

    // ---------------------------------------------------------------- 0x28a0
    const onset = attrs[phonemes[p]] ?? 0
    if (onset & CONSONANT) {
      let by = 0x1a
      if (!(onset & VOICED)) {
        // 0x28b8: a voiceless consonant lifts the whole syllable first, peak,
        // climb and drop alike, so its shape is kept as it rises.
        const lift = round7(muls(arr1[i] - 0x6e, 0x1a))
        arr1[i] = (arr1[i] + lift) & 0xff
        arr7[i] = (arr7[i] + lift) & 0xff
        arr6[i] = (arr6[i] + lift) & 0xff
        by = 0x66
      }
      const d = round7(muls(sb(arr6[i]), by))
      arr0[i] = (arr0[i] + d) & 0xff
      arr6[i] = (arr6[i] - d) & 0xff
    }

    // ---------------------------------------------------------------- 0x291a
    let by: number
    if (arr4[i] & SYLLABLE.PAUSE || arr4[i + 1] & SYLLABLE.PRIMARY) {
      // 0x295c: and the phrase's last syllable has nothing to run into.
      if (i === counters.syllables - 1) continue
      by = 0x40
    } else {
      // 0x292a: forward past the syllable's own stress digit first.
      let k = 0
      while (s + k < stress.length && (stress[s + k] & 0x0f) === 0) k++
      if (s + k >= stress.length) invalidVoice()
      k++

      // 0x293c: then on to the first phoneme that settles it, stepping over
      // voiced consonants on the way.
      for (;;) {
        if (p + k >= phonemes.length) invalidVoice()
        const next = phonemes[p + k]
        if (next === GLOTTAL) {
          by = 0x1a
          break
        }
        const a = attrs[next] ?? 0
        if (a & VOWEL) {
          by = 0x1a
          break
        }
        if (!(a & VOICED)) {
          by = 0x56
          break
        }
        k++
      }
    }

    // 0x2974
    const d = round7(muls(sb(arr7[i]), by))
    arr2[i] = (arr2[i] + d) & 0xff
    arr7[i] = (arr7[i] - d) & 0xff
  }
}

/**
 * hunk+0x2160. One phrase's worth of pitch, and then move the cursors past it.
 *
 * The driver at `hunk+0x832` alternates {@link nextPhrase} with this until
 * there is no phrase left, so between them they are the whole of the tune.
 *
 * Two things are skipped rather than guarded inside the routines themselves.
 * `mode` — the monotone robot voice — skips all seven, since
 * {@link assignPitch} is going to write one flat period over everything
 * anyway; and a phrase with no primary stress in it skips the first four,
 * which are the ones that need somewhere to hang a contour, leaving the last
 * three to fill it in flat.
 *
 * The seven pass registers between them and the device never reloads what one
 * of them clobbers, so they have to run in this order. `phrasePitch` is the
 * only one whose result is threaded by hand, in `D0`.
 *
 * Ends by adding the syllable count to all eight array cursors at once, which
 * is what makes the next phrase write where this one stopped.
 */
export function pitchLoopBody(state: ProsodyState, attrs: Attrs, mode: number): void {
  const { counters } = state

  // 0x2184
  if (mode === 0) {
    // 0x218a: nothing to hang a contour on.
    if (counters.stresses !== 0) {
      syllablePitch(state, phrasePitch(state))
      syllableRange(state)
      linkSyllables(state)
    }
    boundaryFall(state)
    fillContours(state)
    coarticulatePitch(state, attrs)
  }

  // 0x21aa: `add.l D4,(A0)+` eight times.
  state.arrAt += counters.syllables
}
