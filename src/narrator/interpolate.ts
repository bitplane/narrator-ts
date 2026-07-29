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
