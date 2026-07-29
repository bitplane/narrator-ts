/**
 * narrator.device's frame interpolator — hunk+0x2a6a, `0x2aba` and `0x2a92`
 * of build 33.2.
 *
 * By the time `hunk+0x29d8` runs, the frame array is mostly holes. Every
 * phoneme's block holds its own steady formants, and between them the earlier
 * stages left markers: zero in the frequency and pitch columns, `0xfe` in the
 * amplitude columns. This fills them in, one byte column at a time, with a
 * straight line from the value before the hole to the value after it.
 *
 * The line is walked in 1/32nds — the endpoints are shifted up five bits, the
 * step is `(to - from) * 32 / frames` computed once, and each frame shifts the
 * accumulator back down. So the rounding is a running one and the last frame
 * does not necessarily land exactly on the target.
 */

import type { Params } from './frames.js'

/** Bytes per frame. */
const FRAME = 8

/** Ends the frame array, in every column. */
const END = 0xff

/** "Interpolate across me" in an amplitude column. */
const HOLE = 0xfe

/**
 * hunk+0x2a6a. Fill the `count - 1` frames between `at` and `at + count`.
 *
 * `divs.w`, so the step is signed and truncates towards zero; a fall of one
 * unit over six frames steps by −5/32 and takes five frames to show.
 */
function line(frames: Uint8Array, at: number, column: number, count: number): void {
  const from = frames[at + column]
  const to = frames[at + count * FRAME + column]

  // 0x2a76: `asl.l #5` on the difference of two bytes, so this cannot
  // overflow; 0x2a7a divides it by the frame count.
  const step = (((to - from) << 5) / count) | 0

  // 0x2a7e: the accumulator, also in 1/32nds.
  let acc = ((from << 5) << 16) >> 16
  for (let k = 1; k < count; k++) {
    acc = (((acc + step) << 16) >> 16)
    frames[at + k * FRAME + column] = (acc >> 5) & 0xff
  }
}

/**
 * hunk+0x2aba. Fill runs of zero in one byte column — the three formant
 * frequencies and the pitch.
 *
 * Zero is the hole here because a frequency of zero is silence and a pitch of
 * zero is meaningless, so neither can be a value anyone meant.
 */
export function fillZeroRuns(frames: Uint8Array, column: number): void {
  let at = 0
  for (;;) {
    let span = 1
    while (frames[at + span * FRAME + column] === 0) span++
    if (frames[at + span * FRAME + column] === END) return
    // 0x2ad0: nothing between the two, so just step on.
    if (span === 1) at += FRAME
    else {
      line(frames, at, column, span)
      at += span * FRAME
    }
  }
}

/**
 * hunk+0x2a92. The same for the three amplitude columns, where the hole is
 * `0xfe` — the marker `hunk+0x17d6` left at each end of a phoneme's block.
 *
 * Zero cannot be the marker here because zero is a real amplitude: it is
 * silence, and a stop's closure is exactly that.
 */
export function fillMarkedRuns(frames: Uint8Array, column: number): void {
  let at = 0
  for (;;) {
    let span = 1
    for (;;) {
      const v = frames[at + span * FRAME + column]
      if (v === END) return
      if (v !== HOLE) break
      span++
    }
    if (span === 1) at += FRAME
    else {
      line(frames, at, column, span)
      at += span * FRAME
    }
  }
}

/**
 * hunk+0x2d54. A seven-tap box filter over one byte column, with the middle
 * tap counted twice and the sum divided by eight.
 *
 * Run over F2 and, later, over the pitch. The taps are seven consecutive
 * frames and the result is written to the *middle* of them, so the filter
 * reads three frames ahead — it stops as soon as any tap is the terminator,
 * which leaves the last six frames of the array unsmoothed.
 */
export function smooth7(frames: Uint8Array, column: number): void {
  let at = 0
  for (;;) {
    let sum = 0
    for (let k = 6; k >= 0; k--) {
      const v = frames[at + k * FRAME + column]
      if (v === END) return
      sum = (sum + v) & 0xffff
    }
    // 0x2d76: the middle tap again, so it carries twice the weight.
    sum = (sum + frames[at + 3 * FRAME + column]) & 0xffff
    frames[at + 3 * FRAME + column] = (sum >> 3) & 0xff
    at += FRAME
  }
}

/**
 * hunk+0x2d86. The same seven frames through a triangular kernel —
 * `1 2 2 6 2 2 1` over sixteen — written out as twice the sum, minus the two
 * end taps, plus four times the middle.
 *
 * Run over F3 only. F3 moves least between phonemes and shows a stepped
 * transition most, which is presumably why it gets the gentler filter.
 */
export function smooth7Weighted(frames: Uint8Array, column: number): void {
  let at = 0
  for (;;) {
    let sum = 0
    for (let k = 6; k >= 0; k--) {
      const v = frames[at + k * FRAME + column]
      if (v === END) return
      sum = (sum + (v << 1)) & 0xffff
    }
    sum = (sum - frames[at + column]) & 0xffff
    sum = (sum - frames[at + 6 * FRAME + column]) & 0xffff
    sum = (sum + (frames[at + 3 * FRAME + column] << 2)) & 0xffff
    frames[at + 3 * FRAME + column] = (sum >> 4) & 0xff
    at += FRAME
  }
}

/**
 * hunk+0x2d1c. Put every amplitude through the gain curve at `hunk+0x2cfc`.
 *
 * The curve rises 0, 1, 1, 1, 1, 2, 2, 2, ... 23, 25, 28, 31 over 32 entries,
 * so the amplitudes everything upstream works in are on a perceptual scale and
 * this is where they become linear ones the renderer can multiply with.
 *
 * The table has exactly 32 entries and nothing bounds the index. Stress adds 2
 * to each amplitude and only the first is clamped (`hunk+0x1658`), so a
 * table-max F2 or F3 in a stressed phoneme would index past the end and read
 * the routine's own instructions. No captured utterance does — the tables top
 * out well below 30 — but the gap is real.
 */
export function applyGain(frames: Uint8Array, gain: readonly number[]): void {
  for (let at = 0; ; at += FRAME) {
    const first = frames[at + 3]
    if (first === END) return
    // 0x2d36: a frame still marked is left alone rather than looked up. This
    // never fires: `fillMarkedRuns` runs first and clears every marker except
    // a trailing run with no value after it, and `hunk+0x17d6` gives the last
    // phoneme no tail, so there is never one. Measured at zero over 103
    // phrases as well.
    if (first === HOLE) continue
    frames[at + 3] = gain[first] ?? 0
    frames[at + 4] = gain[frames[at + 4]] ?? 0
    frames[at + 5] = gain[frames[at + 5]] ?? 0
  }
}

/**
 * hunk+0x2dca. Nudge the pitch of each phoneme's frames by what the phoneme
 * is — the microprosody, and the most linguistically literate thing in the
 * device.
 *
 * Two effects, both real and both well documented in phonetics:
 *
 * **Intrinsic consonant pitch.** A voiced stop lowers the pitch of its own
 * frames and a voiceless one, a nasal or a fricative raises it. Voicing during
 * a closure needs the larynx slack, and the pitch follows.
 *
 * **Intrinsic vowel pitch.** For vowels, liquids and glides the shift is
 * `(F1 - 0x2b) / 4`, so a high F1 lowers the pitch. High vowels have a low F1
 * and a high F0, low vowels the other way round — "beat" sits above "bat" on
 * the same intended note. Reading F1 straight out of the frame it has already
 * built is a neat way to get that for free.
 *
 * The frame byte is a *period*, so adding to it lowers the pitch.
 */
export function intrinsicPitch(
  phonemes: Uint8Array,
  durations: Uint8Array,
  attrs: readonly number[],
  frames: Uint8Array,
): void {
  /** `B` and `D`. The other voiced stops reach here as their own indices. */
  const VOICED_STOP = [0x42, 0x45]
  /** `Q`, the glottal stop, which is given one flat period of its own. */
  const GLOTTAL = 0x2f
  const GLOTTAL_PERIOD = 0xe6

  let at = 0
  for (let i = 0; ; i++) {
    const p = phonemes[i]
    if (p === END) return
    const n = durations[i] & 0x3f

    /** `subq.w #1` then `dbra`, so a duration of zero runs 65536 times. */
    const each = (f: (frame: number) => void): void => {
      const count = n === 0 ? 0x10000 : n
      for (let k = 0; k < count; k++, at += FRAME) f(at)
    }

    if (VOICED_STOP.includes(p)) {
      each((f) => { frames[f + 7] = (frames[f + 7] + 10) & 0xff })
      continue
    }
    if (p === GLOTTAL) {
      each((f) => { frames[f + 7] = GLOTTAL_PERIOD })
      continue
    }

    const a = attrs[p] ?? 0
    // 0x2e10: voiceless stops, nasals and fricatives, all by the same −6.
    if (a & ((1 << 11) | (1 << 16) | (1 << 12))) {
      each((f) => { frames[f + 7] = (frames[f + 7] - 6) & 0xff })
      continue
    }
    // 0x2e28: bit 0 is a vowel, bits 15 and 17 the liquids and glides.
    if (a & 0x28001) {
      each((f) => {
        const shift = ((((frames[f] - 0x2b) << 24) >> 24) >> 2) & 0xff
        frames[f + 7] = (frames[f + 7] + shift) & 0xff
      })
      continue
    }

    at += n * FRAME
  }
}

/**
 * hunk+0x2bc6. Two fixes to the frame array that only make sense once every
 * frame exists: hold the vocal tract still through a pause, and put a real
 * silence around a voiceless fricative.
 *
 * **A pause** (0x2c12) — `.` and `?` copy F1, F2 and F3 from the frame before
 * them into every frame of the pause. `hunk+0x15e0` already borrows the
 * previous phoneme's formants for the pause's *first* frame; this carries them
 * across the whole of it, so the tract holds its shape rather than gliding
 * anywhere while nothing is being said.
 *
 * **A voiceless fricative** (0x2c32) — `s`, `f`, `sh`, `th` and the rest, when
 * they last more than two frames. Two things happen:
 *
 * - The frication noise is ramped in and out, a quarter of full on the first
 *   frame and half on the second, and the same at the other end. Without it
 *   the noise switches on at full amplitude, which is the click a synthesiser
 *   makes when it does not do this.
 * - If a sonorant is next to it, a frame of that sonorant is silenced outright
 *   and the frames beyond marked as holes for the interpolator to fill. That
 *   is the closure — the moment of nothing between a vowel and the hiss — and
 *   it is dug out of the neighbour rather than out of the fricative.
 *
 * The gap is asymmetric: one silent frame and one marker before, one silent
 * frame and *two* markers after. So a fricative takes longer to let go of the
 * following vowel than it took to catch the preceding one.
 */
export function shapeFrication(
  phonemes: Uint8Array,
  flags: Uint8Array,
  attrs: readonly number[],
  frames: Uint8Array,
): void {
  /** Bit 2: a sonorant. Bit 9: voiced. Bits 12 and 13: frication. */
  const SONORANT = 1 << 2
  const VOICED = 1 << 9
  const FRICATION = 0x3000

  const FULL_STOP = 1
  const QUESTION = 2

  let at = 0
  let i = 0
  /** `bit 31 of D4`, set on the way round and never cleared. */
  let first = true

  for (;;) {
    const p = phonemes[i]
    if (p === END) return
    const n = flags[i] & 0x3f
    i++

    if (p === FULL_STOP || p === QUESTION) {
      // 0x2c16: `subq.w #1` then `dbra`, so a pause of no frames would copy
      // 65536 of them. The duration stage gives punctuation 24.
      const count = n === 0 ? 0x10000 : n
      for (let k = 0; k < count; k++, at += FRAME) {
        frames[at] = frames[at - FRAME]
        frames[at + 1] = frames[at - FRAME + 1]
        frames[at + 2] = frames[at - FRAME + 2]
      }
      first = false
      continue
    }

    const a = attrs[p] ?? 0
    // 0x2c38: voiced, or not a fricative, or too short to ramp.
    if (a & VOICED || !(a & FRICATION) || ((n << 24) >> 24) <= 2) {
      at += n * FRAME
      first = false
      continue
    }

    // 0x2c54: dig the closure out of the sonorant before it.
    if (!first && (attrs[phonemes[i - 2]] ?? 0) & SONORANT) {
      frames[at - FRAME + 3] = 0
      frames[at - FRAME + 4] = 0
      frames[at - FRAME + 5] = 0
      frames[at - 2 * FRAME + 3] = HOLE
      frames[at - 2 * FRAME + 4] = HOLE
      frames[at - 2 * FRAME + 5] = HOLE
    }

    // 0x2c7c: the noise ramp, on the low nibble of the voicing byte.
    const half = (frames[at + 6] & 0x0f) >>> 1
    const quarter = ((half + 1) & 0xff) >>> 1
    frames[at + 6] = (frames[at + 6] & 0xf0) | quarter
    frames[at + FRAME + 6] = (frames[at + FRAME + 6] & 0xf0) | half

    at += n * FRAME

    frames[at - FRAME + 6] = (frames[at - FRAME + 6] & 0xf0) | quarter
    frames[at - 2 * FRAME + 6] = (frames[at - 2 * FRAME + 6] & 0xf0) | half

    // 0x2cb0: and out of the sonorant after it.
    const next = phonemes[i]
    if (next !== END && (attrs[next] ?? 0) & SONORANT) {
      frames[at + 3] = 0
      frames[at + 4] = 0
      frames[at + 5] = 0
      frames[at + FRAME + 3] = HOLE
      frames[at + FRAME + 4] = HOLE
      frames[at + FRAME + 5] = HOLE
      frames[at + 2 * FRAME + 3] = HOLE
      frames[at + 2 * FRAME + 4] = HOLE
      frames[at + 2 * FRAME + 5] = HOLE
    }
    first = false
  }
}

/**
 * hunk+0x2ae0. Nasalise — put the nasal murmur in, and colour the vowel in
 * front of it.
 *
 * Two halves, both of them real phonetics.
 *
 * **A nasal** (0x2b70) gets its frames overwritten outright with a fixed
 * spectrum: F1, F2, F3 and the three amplitudes, straight out of the parameter
 * tables at a column no phoneme reaches by the normal route. `M` takes column
 * 96, `N` 97, `NX` 98 and anything else 99 — which are `UL`, `UM`, `UN` and
 * `IL`, the syllabic consonants. Those are rewritten away in the first pass,
 * so their rows in the table are free, and the device uses them to hold the
 * murmur. Every frame of the nasal is the same; the murmur does not move.
 *
 * "Anything else" is `NH`, the only other phoneme carrying the nasal bit, and
 * it cannot be heard: 33.2 gives it a duration of zero and six zero
 * parameters, an empty slot the parser will nonetheless accept. An utterance
 * containing one does not finish: `hunk+0x15e0`'s fill loop is `subq` then
 * `dbra`, so a duration of zero writes 65536 frames rather than none, and the
 * device is off the end of the array long before it reaches here. `LX` and
 * `RX` are fatal for the same reason. So the `IL` column is addressed,
 * reachable on paper and unreachable in fact. Ported as written.
 *
 * Note the table it reads is the *primary* one, addressed absolutely. The
 * second voice's higher formants at `hunk+0x50ae` are not consulted, so with
 * `sex` set the nasals keep the first voice's spectrum while everything around
 * them changes.
 *
 * **A vowel before a nasal** (0x2b40) is nasalised across its second half:
 * F1 rises by 4 on the middle frame and by 9 on every frame after it, and the
 * first formant's amplitude is cut to three quarters. Coupling the nasal
 * cavity in raises and damps F1 — the vowel starts to sound like the nasal
 * before the nasal arrives, which is what makes "man" not sound like "mad".
 *
 * The frame count for that second half is `n - n/2 - 2` computed in a *byte*,
 * so a vowel of one or two frames before a nasal underflows to 254 or 255 and
 * the device runs off the end of the frame array. No duration the corpus
 * produces is that short — a vowel gets at least four frames — but the
 * arithmetic is what it is, and it is left alone here rather than guarded.
 */
export function nasalise(
  phonemes: Uint8Array,
  flags: Uint8Array,
  attrs: readonly number[],
  table: Pick<Params, 'f1' | 'f2' | 'f3' | 'a1' | 'a2' | 'a3'>,
  frames: Uint8Array,
): void {
  /** Bit 0: a vowel. Bit 16: a nasal. */
  const VOWEL = 1 << 0
  const NASAL = 1 << 16

  /** The three nasals, and the murmur column each one borrows. */
  const MURMUR: Record<number, number> = { 0x2a: 0x60, 0x2b: 0x61, 0x2c: 0x62 }
  const rows = [table.f1, table.f2, table.f3, table.a1, table.a2, table.a3]

  let at = 0
  for (let i = 0; ; i++) {
    const p = phonemes[i]
    if (p === END) return
    const n = flags[i] & 0x3f
    const a = attrs[p] ?? 0

    if (a & NASAL) {
      // 0x2b70: the same six bytes into every frame of it.
      const column = MURMUR[p] ?? 0x63
      const count = n === 0 ? 0x10000 : n
      for (let k = 0; k < count; k++, at += FRAME) {
        for (let b = 0; b < 6; b++) frames[at + b] = rows[b][column] ?? 0
      }
      continue
    }

    // 0x2b26: a vowel, and only if a nasal comes next.
    if (!(a & VOWEL) || !((attrs[phonemes[i + 1]] ?? 0) & NASAL)) {
      at += n * FRAME
      continue
    }

    // 0x2b40: from the middle of the vowel on.
    const half = n >>> 1
    at += half * FRAME
    frames[at] = (frames[at] + 4) & 0xff
    at += FRAME

    // 0x2b50: `sub.b` then `subq.b`, so this is a byte and it can wrap.
    let left = (n - half - 2) & 0xff
    for (;;) {
      frames[at] = (frames[at] + 9) & 0xff
      frames[at + 3] = (frames[at + 3] - (frames[at + 3] >>> 2)) & 0xff
      at += FRAME
      if (left-- === 0) break
    }
  }
}

/**
 * hunk+0x2e80. Smooth the mouth-shape stream.
 *
 * Setting `narrator_rb.mouths` asks the device for a second output alongside
 * the audio: one byte per frame holding two 4-bit numbers, a width in the low
 * nibble and a height in the high one, for driving a face on screen.
 * `hunk+0x15e0` fills it in as it builds the frames, straight from the
 * phoneme's own shape, so it steps from one value to the next as abruptly as
 * the phonemes do. This rounds those steps off.
 *
 * The kernel is the same seven-tap box with the middle counted twice that
 * {@link smooth7} runs over F2 and the pitch — but over bytes with a stride of
 * one instead of frames with a stride of eight, and once for each nibble. It
 * is also run **in place with no bound**: each output lands in the middle of
 * the window it was computed from, and the six windows after it read it back.
 * So it is a recursive filter, not the finite one it looks like, and the
 * smoothing runs further than seven frames.
 *
 * Two details worth knowing. The last four bytes are never written, since the
 * loop stops when the window's *centre* reaches the fourth from last; and the
 * last few windows read up to six bytes past the end of the buffer, which the
 * device allocated at exactly `total` bytes. Reading them as zero is what a
 * freshly allocated, still-clear heap gives, and what the oracle gives; a
 * real Amiga with a dirty pool would smooth the tail differently.
 *
 * Nothing else in the device can reach this routine — `hunk+0x2a3e` calls it
 * only when `mouths` is set — so it needs `--mouths 1` to capture at all.
 */
export function smoothMouths(mouths: Uint8Array, total: number): void {
  /** 0x2e88: `subq.w #5` on the frame total, then `dbra`. */
  const count = (((total - 5) & 0xffff) + 1) & 0xffff

  // 0x2e8e: the low nibble.
  for (let k = 0; k < count; k++) {
    let sum = 0
    for (let j = 0; j < 3; j++) sum = (sum + (mouths[k + j] & 0x0f)) & 0xff
    sum = (sum + 2 * (mouths[k + 3] & 0x0f)) & 0xff
    for (let j = 4; j < 7; j++) sum = (sum + (mouths[k + j] & 0x0f)) & 0xff
    mouths[k + 3] = (mouths[k + 3] & 0xf0) | (sum >>> 3)
  }

  // 0x2ed0: the high one, and `add.b D2,D2` then a mask instead of a shift —
  // the same divide by eight, landing four bits further up.
  for (let k = 0; k < count; k++) {
    let sum = 0
    for (let j = 0; j < 3; j++) sum = (sum + (mouths[k + j] >>> 4)) & 0xff
    sum = (sum + 2 * (mouths[k + 3] >>> 4)) & 0xff
    for (let j = 4; j < 7; j++) sum = (sum + (mouths[k + j] >>> 4)) & 0xff
    mouths[k + 3] = (mouths[k + 3] & 0x0f) | (((sum << 1) & 0xf0))
  }
}
