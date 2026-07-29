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
