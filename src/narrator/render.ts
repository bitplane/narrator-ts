/**
 * narrator.device's sample renderer — the back half of the synthesizer.
 *
 * The device splits cleanly: phonemes become an array of 8-byte frames, and
 * frames become samples. This is the second half, ported from the loop at hunk
 * offsets 0x548a-0x55e4 of build 33.2. See research/02-narrator.md.
 *
 * It is written as a transcription of the 68k rather than as a tidy synthesis
 * routine, because it has to be sample-exact and the registers carry two
 * things at once in places the tidy version would separate. In particular D0
 * holds *two* counters, one per half-word: the samples left in this frame and
 * the samples left in this pitch period. The 68k swaps between them, so this
 * does too.
 */

/** One 8-byte frame, as the device lays it out. */
export const FRAME = {
  /** Phase increment for the first formant. */
  F1_FREQ: 0,
  /** Phase increment for the second. */
  F2_FREQ: 1,
  /** Phase increment for the third — doubled into a word (0x5558). */
  F3_FREQ: 2,
  F1_AMP: 3,
  F2_AMP: 4,
  F3_AMP: 5,
  /**
   * Voicing. Zero is fully voiced. Otherwise bit 7 means "sum a voiced
   * formant as well" (a voiced fricative), bits 4-6 pick one of eight
   * fricative tables and bits 0-3 are the noise amplitude.
   */
  VOICING: 6,
  /** The pitch period, in samples. Amplitudes reload when it expires. */
  PITCH: 7,
} as const

export const FRAME_BYTES = 8

/**
 * The audio buffer, in bytes. The renderer fills these and hands them to
 * audio.device, so only *whole* buffers are ever heard: whatever the frames
 * had left over at the end is still in the half-filled buffer when the
 * utterance stops, and never gets written. Output is truncated to match.
 */
export const BUFFER_BYTES = 0x200

/** Everything the loop reads that is not in a frame. */
export interface RenderTables {
  /** The waveform table at hunk+0x4aae, stepped 0x40 at a time. */
  wave: Uint8Array
  /** Indexed by `(amplitude << 5) | waveform`; does the multiply. */
  ampTable: Uint8Array
  /** The eight fricative tables, selected by bits 4-6 of the voicing byte. */
  fricatives?: Uint8Array[]
  /** Samples per frame — `A5+0x24`, from `sampfreq` (hunk+0x53fa). */
  periodCount: number
  /** How often the waveform pointer steps — `A5+0x32`, 9 or 11. */
  waveStep: number
}

const WORD = 0xffff
const lo = (v: number): number => v & WORD
const hi = (v: number): number => (v >>> 16) & WORD
const swap = (v: number): number => ((v << 16) | (v >>> 16)) >>> 0
/** 68k `subq.w #1,Dn` then `bpl`: the *word* is signed for the test. */
const dec = (v: number): number => (v & ~WORD) | lo(v - 1)
const sword = (v: number): number => (lo(v) << 16) >> 16

/**
 * Render frames to 8-bit signed samples.
 *
 * Voiced output is computed at half rate and each sample written twice
 * (0x54c0-0x54c2); unvoiced is computed per sample (0x5648). That is not a
 * detail — it is why the voice sounds the way it does, and a renderer that
 * computes every sample at the output rate is neither exact nor right.
 */
export function render(frames: Uint8Array, t: RenderTables): Int8Array {
  const out: number[] = []
  const wave = t.wave
  const amp = t.ampTable

  let d0 = (t.periodCount << 16) >>> 0     // 0x5480: high = frame counter
  let d1 = 0                               // F1 phase
  let d2 = 0                               // F2 (low) and F3 (high) phases
  let d3 = 0                               // F1 amplitude, pre-shifted
  let d4 = 0                               // F2 (low) and F3 (high) amplitudes
  let a0 = 0                               // offset into `wave`
  let waveCount = t.waveStep

  let fp = 0                               // the frame pointer, A6
  let cur = frames.subarray(0, FRAME_BYTES)  // the frame the loop is on
  let f1inc = 0
  let f2f3inc = 0
  let voicing = 0
  let noise: Uint8Array | undefined
  let noiseIndex = 0
  let noiseAmp = 0
  let mixed = false
  let done = false

  /**
   * 0x55b6: a pitch pulse. The waveform restarts and the *current* frame's
   * amplitudes are taken — they are sampled here and only here, so a frame
   * whose pitch period has not expired keeps the previous pulse's levels.
   */
  const pitchPulse = (f: Uint8Array): void => {
    d1 = 0
    d2 = 0
    a0 = 0
    waveCount = t.waveStep
    d0 = (d0 & ~WORD) | f[FRAME.PITCH]
    d3 = (f[FRAME.F1_AMP] << 5) & WORD
    d4 = (((f[FRAME.F3_AMP] << 5) & WORD) << 16 |
          ((f[FRAME.F2_AMP] << 5) & WORD)) >>> 0
  }

  /** 0x5544: decode a frame's fields. Returns false at the end marker. */
  const decode = (): boolean => {
    if (fp + FRAME_BYTES > frames.length) return false
    cur = frames.subarray(fp, fp + FRAME_BYTES)
    if (cur[FRAME.F1_FREQ] & 0x80) return false      // 0x5548 bmi
    f1inc = cur[FRAME.F1_FREQ]
    // 0x5550-0x5558. The increments are added as one longword read from
    // A5+2, so F2's word is the *high* half and F3's (doubled) the low —
    // and the add is bracketed by swaps, which lands each on its own
    // accumulator. Assembling it the other way round is silently plausible
    // and completely wrong.
    f2f3inc = ((cur[FRAME.F2_FREQ] << 16) | ((cur[FRAME.F3_FREQ] << 1) & WORD)) >>> 0
    voicing = cur[FRAME.VOICING]

    // 0x5574: unvoiced setup.
    mixed = false
    noise = undefined
    if (voicing !== 0) {
      mixed = (voicing & 0x80) !== 0
      noiseAmp = (voicing & 0x0f) << 5
      noise = t.fricatives?.[(voicing >> 4) & 7]
    }
    fp += FRAME_BYTES
    return true
  }

  /** 0x55ac: the per-frame counter dance, for every frame after the first. */
  const nextFrame = (): boolean => {
    if (!decode()) return false
    d0 = (d0 & ~WORD) | t.periodCount
    d0 = swap(d0)
    d0 = dec(d0)
    if (sword(d0) < 0) pitchPulse(cur)
    d0 = swap(d0)
    return true
  }

  // 0x5486: the first frame skips all of that and goes straight to the pulse,
  // with the frame counter already sitting in the high half from 0x5480.
  if (!decode()) return Int8Array.from(out)
  pitchPulse(cur)
  d0 = swap(d0)

  for (;;) {
    if (voicing === 0) {
      // ------------------------------------------------ 0x548a, voiced
      let d7 = wave[a0 + ((lo(d1) >>> 4) & 0x3f)] | d3
      let acc = amp[d7 & (amp.length - 1)]
      // 0x54a2: the shift is on the whole longword, *then* the halves are
      // swapped apart — so F3's low nibbles pass through F2's word and are
      // masked off there. Shifting after the swap gets a different number.
      const ph = (d2 >>> 4) >>> 0
      d7 = wave[a0 + (ph & 0xfff)] | lo(d4)
      acc = (acc + amp[d7 & (amp.length - 1)]) & 0xff
      d7 = wave[a0 + (hi(ph) & 0xfff)] | hi(d4)
      acc = (acc + amp[d7 & (amp.length - 1)]) & 0xff
      out.push(acc, acc)                    // 0x54c0-0x54c2: twice
    } else {
      // ------------------------------------------------ 0x5610, unvoiced
      // One noise byte yields *two* samples, from its low nibble then its
      // high one — not a duplicated pair. That is why unvoiced output looks
      // undoubled while voiced output is exactly doubled.
      let voiced = 0
      if (mixed) {                          // 0x561a: bit 31 of the amplitudes
        const w = wave[a0 + ((lo(d1) >>> 4) & 0x3f)] & 0x1f
        voiced = amp[(w | d3) & (amp.length - 1)]
      }
      const b = noise ? noise[noiseIndex % noise.length] : 0
      const s1 = (voiced + amp[(((b & 0x0f) << 1) | noiseAmp) & (amp.length - 1)]) & 0xff
      const s2 = (amp[(((b & 0xf0) >>> 3) | noiseAmp) & (amp.length - 1)] + voiced) & 0xff
      noiseIndex++
      out.push(s1, s2)                      // 0x5648 and 0x565a
    }

    // ------------------------------------------------------------ 0x5518
    d1 = lo(d1 + f1inc) & 0x3ff
    d2 = (((swap(d2) >>> 0) + f2f3inc) >>> 0)
    d2 = swap(d2) & 0x03ff03ff

    if (--waveCount === 0) {
      a0 += 0x40
      waveCount = t.waveStep
    }

    d0 = dec(d0)
    if (sword(d0) < 0) {
      if (!nextFrame()) done = true
    } else {
      // 0x55b0: the frame is not over, but the pitch counter still ticks —
      // and a pulse mid-frame reloads the amplitudes just the same.
      d0 = swap(d0)
      d0 = dec(d0)
      if (sword(d0) < 0) pitchPulse(cur)
      d0 = swap(d0)
    }
    if (done) break
  }
  const whole = out.length - (out.length % BUFFER_BYTES)
  return Int8Array.from(out.slice(0, whole).map((v) => (v << 24) >> 24))
}
