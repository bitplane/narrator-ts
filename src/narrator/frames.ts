/**
 * narrator.device's frame-array builder — hunk+0x1454 of build 33.2.
 *
 * This is where a list of phonemes stops being a list of phonemes. Each one
 * has a duration in frames by now, so the total is known; this allocates one
 * eight-byte frame per frame of speech and writes each phoneme's formant
 * frequencies, amplitudes and voicing into every frame it occupies.
 *
 * The driver is seven sub-routines called in a row, and they are ported and
 * checked one at a time — `tools/capture-stages.py --sub` breaks inside it, so
 * each has the device's own arrays either side of it:
 *
 * | | | |
 * |---|---|---|
 * | `0x1970` | {@link compact} | drop the phonemes that are not spoken |
 * | `0x1492` | {@link continuationDurations} | lengths for the slots pass 2 made |
 * | `0x1586` | {@link allocate} | total the durations, size the array |
 * | `0x15e0` | {@link fill} | formants and voicing, per frame |
 * | `0x1472` | {@link markFirst} | clear the pitch bytes, mark frame 0 |
 * | `0x172a` | — | coarticulation, not yet ported |
 * | `0x17d6` | — | coarticulation, not yet ported |
 *
 * The frame layout is the renderer's, documented in research/02-narrator.md:
 * bytes 0-2 are the three formant phase increments, 3-5 their amplitudes, 6
 * the voicing byte, and 7 the pitch period, which a later stage fills in.
 */

import { TERMINATOR } from './parse.js'
import type { Attrs } from './rewrite.js'

/** Bytes per frame. */
export const FRAME = 8

/** Attribute bits this stage tests. */
const ATTR = {
  /** Bit 2: a sonorant — the vowels, liquids, glides, nasals and `Z`/`V`/`DH`. */
  SONORANT: 1 << 2,
  /** Bit 7: this phoneme's duration is split across it and the slot after. */
  SPLIT: 1 << 7,
  /** Bit 9: voiced. */
  VOICED: 1 << 9,
  /** Bits 10 and 11: a voiced or voiceless stop. */
  VOICED_STOP: 1 << 10,
  VOICELESS_STOP: 1 << 11,
  /** Bit 12: a fricative. */
  FRICATIVE: 1 << 12,
  /** Bit 13. With bit 21, the phoneme takes its noise source from stress. */
  FRICATIVE_SOURCE: 1 << 13,
  /** Bit 15: `R`, `L`, `RX`, `LX`. */
  LIQUID: 1 << 15,
  /** Bit 17: `WH`, `W`, `Y`. */
  GLIDE: 1 << 17,
  /** Bit 20: not spoken. The space and the two bracket markers. */
  SILENT: 1 << 20,
  /** Bit 21: a continuation slot, which rewrite pass 2 created. */
  CONTINUATION: 1 << 21,
} as const

/** 0x10 in a stress byte: part of a stressed syllable. */
const STRESSED = 0x10

/** The low six bits of a flag byte are a duration in frames. */
const DURATION = 0x3f

/** What {@link markFirst} writes into frame 0's pitch byte. */
const FIRST_FRAME = 0xa0

/** Amplitudes saturate here — five bits, as the renderer reads them. */
const MAX_AMPLITUDE = 0x1f

export interface FrameState {
  phonemes: Uint8Array
  stress: Uint8Array
  /** Durations in the low six bits, from {@link assignDurations}. */
  flags: Uint8Array
  count: number
}

/** The per-phoneme tables `tools/extract-phonemes.py` reads out of the binary. */
export interface Params {
  f1: readonly number[]
  f2: readonly number[]
  f3: readonly number[]
  a1: readonly number[]
  a2: readonly number[]
  a3: readonly number[]
  voicing: readonly number[]
  /** Stressed and unstressed frame counts, for {@link continuationDurations}. */
  stressed: readonly number[]
  unstressed: readonly number[]
  /** Which of two neighbours wins a boundary — `hunk+0x3a86`. */
  rank: readonly number[]
  /** How far the loser is pulled towards the winner, in 1/32nds. */
  weight: readonly number[]
  /** Frames spent transitioning in and out. */
  transitionIn: readonly number[]
  transitionOut: readonly number[]
}

/**
 * hunk+0x1970. Drop every phoneme the synthesizer will not speak — attribute
 * bit 20, which is the space and the two bracket markers — copying the
 * survivors down to index 0.
 *
 * So the lead-in the parser reserved is consumed here, and from this point the
 * arrays are dense and the word boundaries survive only as the flags the
 * spreader already set.
 */
export function compact(state: FrameState, attrs: Attrs): void {
  const { phonemes, stress, flags } = state
  let w = 0
  for (let r = 0; ; r++) {
    const p = phonemes[r]
    if (p === TERMINATOR) {
      phonemes[w] = TERMINATOR
      stress[w] = TERMINATOR
      flags[w] = TERMINATOR
      // `state.count` is deliberately *not* corrected. The device leaves
      // A5+0x9a holding the pre-compaction length and every stage after this
      // one walks to the 0xff instead, so a port that tidied it up would be
      // reproducing something the device does not do.
      return
    }
    if ((attrs[p] ?? 0) & ATTR.SILENT) continue
    phonemes[w] = p
    stress[w] = stress[r]
    flags[w] = flags[r]
    w++
  }
}

/**
 * hunk+0x1492. Give the continuation slots rewrite pass 2 created a duration
 * of their own, and a copy of the stress they continue.
 *
 * `RX` gets a special case: its duration and its predecessor's are averaged
 * and both are set to the result, so an r-coloured vowel and its `RX` share
 * one length rather than each taking a full one.
 */
export function continuationDurations(state: FrameState, attrs: Attrs, table: Params): void {
  const { phonemes, stress, flags } = state
  const RX = 0x17

  let i = 0
  for (;;) {
    const p = phonemes[i]
    if (p === TERMINATOR) return

    if (p === RX) {
      // 0x14b8: the mean, biased — `(a + b) - (a + b) / 4` then halved, which
      // is 3/8 of the sum rather than 1/2, so the pair comes out shorter than
      // either would have been alone.
      let sum = (flags[i] & DURATION) + (flags[i - 1] & DURATION)
      sum = (sum - (sum >> 2)) >> 1
      flags[i] = ((flags[i] & 0xc0) | sum) & 0xff
      flags[i - 1] = ((flags[i - 1] & 0xc0) | sum) & 0xff
      i++
      continue
    }

    const a = attrs[p] ?? 0
    if (a & ATTR.SPLIT) {
      // 0x14f4: halve this phoneme's duration and give the other half to the
      // slot after it, which is one frame longer to make the split exact.
      const half = (flags[i] & DURATION) >> 1
      flags[i + 1] |= half
      flags[i] = ((flags[i] & 0xc0) | ((half + 1) & 0xff)) & 0xff
      i += 2
      continue
    }

    if (!(a & ATTR.CONTINUATION)) {
      i++
      continue
    }

    // 0x1518: the slot inherits the stress it continues, without the mark.
    stress[i] = stress[i - 1] & 0x7f
    const dur = stress[i] & STRESSED ? table.stressed : table.unstressed
    flags[i] = dur[p] ?? 0
    i++

    // 0x1538: attribute bit 13 means the slot also picks a noise source, and
    // which one comes from the *next* phoneme's attributes, written into the
    // low nibble of the stress byte for hunk+0x15e0 to shift into place.
    if (a & ATTR.FRICATIVE_SOURCE) {
      const next = attrs[phonemes[i]] ?? 0
      let code = 4
      if (next & (1 << 3)) code = 3
      else if (next & (1 << 6)) code = 6
      else if (next & (1 << 5)) code = 5
      stress[i - 1] = ((stress[i - 1] & 0xf0) | code) & 0xff
    }
  }
}

/**
 * hunk+0x1586. Total the durations and hand back an array of that many frames,
 * plus one for the terminator.
 *
 * The device calls `AllocMem` here without `MEMF_CLEAR`, so on a real Amiga
 * the pitch bytes start as whatever was in the heap; `markFirst` writes every
 * one of them before anything reads one.
 */
export function allocate(state: FrameState): { frames: Uint8Array; total: number } {
  const { flags } = state
  let total = 0
  for (let i = 0; flags[i] !== TERMINATOR; i++) total += flags[i] & DURATION
  return { frames: new Uint8Array((total + 1) * FRAME), total }
}

/**
 * hunk+0x15e0. Write each phoneme's formants and voicing into every frame it
 * occupies, then eight `0xff` bytes to end the array.
 *
 * Nothing is interpolated here — each phoneme's frames are identical, and the
 * two coarticulation routines after this one are what bend them into each
 * other. `sex` swaps the frequency tables for a second set with higher
 * formants; the amplitudes and the voicing are shared between the voices.
 */
export function fill(
  state: FrameState,
  attrs: Attrs,
  table: Params,
  frames: Uint8Array,
  alt?: Pick<Params, 'f1' | 'f2' | 'f3'>,
): void {
  const { phonemes, stress, flags } = state
  const freq = alt ?? table

  let at = 0
  for (let i = 0; ; i++) {
    const p = phonemes[i]
    if (p === TERMINATOR) {
      // 0x15fe: eight 0xff, and the renderer stops on bit 7 of byte 0.
      frames.fill(0xff, at, at + FRAME)
      return
    }

    const duration = flags[i] & DURATION
    const a = attrs[p] ?? 0
    const st = stress[i]

    // 0x162a: amplitudes, with 2 added to each when the phoneme is stressed.
    // Only the first is clamped — a real asymmetry, not a transcription slip.
    let a1 = table.a1[p] ?? 0
    let a2 = table.a2[p] ?? 0
    let a3 = table.a3[p] ?? 0
    if (st & STRESSED) {
      if (a1 !== 0) a1 = a1 + 2 > MAX_AMPLITUDE ? MAX_AMPLITUDE : a1 + 2
      if (a2 !== 0) a2 = (a2 + 2) & 0xff
      if (a3 !== 0) a3 = (a3 + 2) & 0xff
    }

    let voicing = table.voicing[p] ?? 0

    // 0x167a: a continuation slot that also carries bit 13 takes its noise
    // source from the low three bits of its stress byte — which is the burst
    // a stop's release makes, chosen by `continuationDurations` above.
    if (a & ATTR.CONTINUATION && a & ATTR.FRICATIVE_SOURCE) {
      voicing |= ((st & 7) << 4) & 0xff
    }

    // 0x16a0: `.` and `?` take their formants from the phoneme *before* them,
    // so the silence keeps the mouth where the speech left it.
    const src = p === 1 || p === 2 ? phonemes[i - 1] : p

    // 0x16e2: an unstressed noise source is halved — quieter fricatives off
    // the beat. The top nibble, which selects the table, is left alone.
    if (voicing !== 0 && !(st & STRESSED)) {
      voicing = (voicing & 0xf0) | ((voicing & 0x0f) >> 1)
    }

    // 0x16fa: `subq` then `dbra`, so a duration of zero writes 65536 frames
    // rather than none. That is not defensive programming missing — it is why
    // `NH`, whose duration is 0 in both tables, crashes the device when it is
    // the only phoneme in an utterance.
    const n = duration === 0 ? 0x10000 : duration
    for (let k = 0; k < n; k++) {
      frames[at] = freq.f1[src] ?? 0
      frames[at + 1] = freq.f2[src] ?? 0
      frames[at + 2] = freq.f3[src] ?? 0
      frames[at + 3] = a1
      frames[at + 4] = a2
      frames[at + 5] = a3
      frames[at + 6] = voicing
      // Byte 7 is stepped over, not written.
      at += FRAME
    }
  }
}

/**
 * hunk+0x172a. Blend the first frame of each phoneme towards its predecessor.
 *
 * Which way the blend runs is decided by a **rank**: whichever of the two
 * phonemes ranks higher keeps its own shape and the other is pulled towards
 * it, by the winner's weight in 1/32nds. Punctuation ranks 31 and beats
 * everything; the vowels rank 2 and lose to nearly everything, which is why a
 * vowel next to a consonant takes the consonant's shape at the join rather
 * than the other way round.
 *
 * The three frequency bytes are only blended when *both* sides are non-zero —
 * silence has no formant position to move towards, and interpolating into it
 * would sweep the formants down to nothing. The amplitudes have no such guard,
 * so they always cross-fade.
 */
export function blendTransitions(state: FrameState, attrs: Attrs, table: Params, frames: Uint8Array): void {
  const { phonemes, flags } = state
  let at = 0

  for (let i = 0; ; i++) {
    at += (flags[i] & DURATION) * FRAME
    const next = phonemes[i + 1]
    if (next === TERMINATOR) return

    // 0x1768: no transition into a stop's own release — the burst is supposed
    // to arrive abruptly, and blending it would file the edge off.
    const a = attrs[next] ?? 0
    if (a & ATTR.CONTINUATION && a & 0x2c00) continue

    const here = phonemes[i]
    const mine = table.rank[here] ?? 0
    const theirs = table.rank[next] ?? 0
    // 0x1792: the weight belongs to whichever of the two ranks higher.
    const w = table.weight[theirs >= mine ? next : here] ?? 0

    for (let k = 0; k < 6; k++) {
      // `(A6)` is the next phoneme's first frame; `(-8,A6)` is this one's
      // last. Which is the base and which the target swaps with the rank, but
      // the write always lands on the next phoneme's first frame.
      const from = frames[at + k]
      const to = frames[at - FRAME + k]
      const base = theirs >= mine ? to : from
      const other = theirs >= mine ? from : to

      // 0x17ae: bytes 0-2 are frequencies and need both ends real.
      if (k < 3 && (base === 0 || other === 0)) continue

      const d = ((other - base) << 16) >> 16
      frames[at + k] = ((d * w >> 5) + base) & 0xff
    }
  }
}

/**
 * hunk+0x17d6. Mark the head and tail of each phoneme's block as frames for
 * the renderer's last stage to interpolate across.
 *
 * The marker is `0xfe` in the three amplitude bytes with the three frequency
 * bytes zeroed. `hunk+0x29d8` is what resolves them into the ramps you can see
 * at the start of any captured frame array.
 *
 * How many frames each end gets comes from the two transition tables, and
 * again the higher-ranked neighbour decides. If the two transitions would not
 * both fit inside the phoneme they are trimmed a frame at a time, at most
 * twice, and if they still do not fit the whole phoneme becomes one long
 * transition instead.
 */
export function markTransitions(state: FrameState, attrs: Attrs, table: Params, frames: Uint8Array): void {
  const { phonemes, flags } = state

  // 0x17fc: phoneme 0's frames are skipped outright — it is the lead-in the
  // parser seeded and there is nothing before it to transition from.
  let at = (flags[0] & DURATION) * FRAME

  for (let i = 1; ; i++) {
    const here = phonemes[i]
    if (here === TERMINATOR) return

    const prev = phonemes[i - 1]
    const next = phonemes[i + 1]
    const duration = flags[i] & DURATION
    const a = attrs[here] ?? 0

    // 0x1838: stops are left alone. Their frames are the closure and the
    // burst, and neither is something to ease into.
    if (a & (ATTR.VOICED_STOP | ATTR.VOICELESS_STOP)) {
      at += duration * FRAME
      continue
    }

    const mine = table.rank[here] ?? 0
    let head = (table.rank[prev] ?? 0) > mine
      ? table.transitionIn[prev] ?? 0
      : table.transitionOut[here] ?? 0
    let tail = (table.rank[next] ?? 0) >= mine
      ? table.transitionIn[next] ?? 0
      : table.transitionOut[here] ?? 0

    // 0x1888: nothing follows the last phoneme, so it has no tail.
    if (next === TERMINATOR) tail = 0

    // 0x1890: a sonorant keeps its amplitudes through a transition whose other
    // end is a stop — the marker only blanks the formants there, so the sound
    // carries across the join instead of dipping to nothing.
    let keepHead = false
    let keepTail = false
    if (a & ATTR.SONORANT) {
      const pa = attrs[prev] ?? 0
      let check = false
      if (pa & (ATTR.VOICED_STOP | ATTR.VOICELESS_STOP)) {
        keepHead = true
        check = true
      } else if (pa & ATTR.FRICATIVE && !(pa & ATTR.VOICED)) {
        check = true
      }
      // 0x18c4: after one of those, a liquid or a glide gets a two-frame head
      // whatever the table said — the /l/ of "play" and the /r/ of "price".
      if (check && a & (ATTR.LIQUID | ATTR.GLIDE)) head = 2
      if ((attrs[next] ?? 0) & (ATTR.VOICED_STOP | ATTR.VOICELESS_STOP)) keepTail = true
    }

    // 0x18ea onwards. One frame at the head belongs to `blendTransitions` and
    // is stepped over rather than marked.
    let span = (duration - 1) & 0xffff
    head = (head - 1) & 0xff
    if (head > 0x7f) head = 0

    let middle = 0
    let shrink = 2
    for (;;) {
      if ((((head + tail) & 0xff) << 24) >> 24 < ((span << 24) >> 24)) {
        middle = (span - head - tail) & 0xff
        break
      }
      head = (head - 1) & 0xff
      if (head > 0x7f) { head = span; tail = 0; middle = 0; break }
      tail = (tail - 1) & 0xff
      if (tail > 0x7f) { head = span; tail = 0; middle = 0; break }
      if (--shrink === 0) { head = span; tail = 0; middle = 0; break }
    }

    const mark = (keep: boolean): void => {
      frames[at] = 0
      frames[at + 1] = 0
      frames[at + 2] = 0
      if (!keep) {
        frames[at + 3] = 0xfe
        frames[at + 4] = 0xfe
        frames[at + 5] = 0xfe
      }
    }

    at += FRAME
    for (let k = 0; k < head; k++) { mark(keepHead); at += FRAME }
    at += middle * FRAME
    for (let k = 0; k < tail; k++) { mark(keepTail); at += FRAME }
  }
}

/**
 * hunk+0x1472. Clear every frame's pitch byte, then put `0xa0` in the first.
 *
 * It scans forward to the terminator clearing as it goes and then goes back to
 * the start, so the marker survives its own loop.
 */
export function markFirst(frames: Uint8Array): void {
  for (let at = 0; frames[at] !== TERMINATOR; at += FRAME) frames[at + 7] = 0
  frames[7] = FIRST_FRAME
}
