/**
 * The device's own tables, and the two numbers the renderer derives from the
 * speech parameters.
 *
 * Everything here is Commodore's data rather than this project's, so it is
 * loaded rather than written down: `tools/gen-voice.py` pulls it out of a
 * `narrator.device` binary the user supplies, and {@link voiceFrom} turns that
 * JSON into the shapes {@link synthesize} and {@link render} want.
 */

import type { Params } from './frames.js'
import type { RenderTables } from './render.js'
import type { Rule } from './rewrite.js'
import type { Voice } from './speak.js'

/** One `narrator-<version>.json`, exactly as `gen-voice.py` writes it. */
export interface VoiceData {
  version: string
  source: string
  names: string[]
  attrs: number[]
  params: Record<string, number[]>
  paramsAlt: Record<string, number[]>
  stressed: number[]
  unstressed: number[]
  gain: number[]
  rules: Record<'allophones' | 'frames', { rules: Rule[] }>
  wave: number[]
  amp: number[]
  fricatives: number[][]
}

/** The front half's tables, as {@link synthesize} wants them. */
export function voiceFrom(data: VoiceData): Voice {
  const col = (k: string): readonly number[] => data.params[k] ?? []
  const params: Params = {
    f1: col('f1'), f2: col('f2'), f3: col('f3'),
    a1: col('a1'), a2: col('a2'), a3: col('a3'),
    voicing: col('voicing'),
    stressed: data.stressed,
    unstressed: data.unstressed,
    rank: col('rank'), weight: col('weight'),
    transitionIn: col('transitionIn'), transitionOut: col('transitionOut'),
    mouth: col('mouth'),
  }
  return {
    table: { names: data.names, attrs: data.attrs },
    attrs: data.attrs.slice(0, params.f1.length),
    params,
    altParams: {
      f1: data.paramsAlt.f1 ?? [],
      f2: data.paramsAlt.f2 ?? [],
      f3: data.paramsAlt.f3 ?? [],
    },
    gain: data.gain,
    rules: [data.rules.allophones.rules, data.rules.frames.rules],
  }
}

/** The parameters the back half is sensitive to. */
export interface RenderOptions {
  /** `narrator_rb.sampfreq`, 5000..28000. The device's default is 22200. */
  sampfreq?: number
  /** `narrator_rb.rate` in words per minute, 40..400. Default 150. */
  rate?: number
  /** `narrator_rb.sex`. Anything non-zero shortens the waveform step. */
  sex?: number
}

/**
 * hunk+0x53fa. How long a frame lasts, and how fast the waveform is walked.
 *
 * `periodCount` is `sampfreq x 75 / rate / 60 / 2` — samples per frame, so
 * `rate` is a speaking rate in the most direct sense available: it divides the
 * time every frame is given without touching any of the frame counts the front
 * half computed. Doubling it halves the length of the utterance and changes
 * nothing else.
 *
 * `waveStep` is how many samples pass between steps along the waveform table,
 * and it is 9 for the second voice and 11 for the first — the one place `sex`
 * reaches the renderer at all, and what makes the second voice brighter rather
 * than merely higher.
 */
export function renderTables(data: VoiceData, opts: RenderOptions = {}): RenderTables {
  const sampfreq = opts.sampfreq ?? 22200
  const rate = opts.rate ?? 150

  // `mulu.w`, `divu.w`, an `andi.l` that throws the remainder away, then a
  // second `divu.w` and a shift — all in word arithmetic.
  let n = (sampfreq * 0x4b) & 0xffffffff
  n = Math.floor(n / rate) & 0xffff
  n = Math.floor(n / 0x3c) >>> 1

  return {
    wave: Uint8Array.from(data.wave),
    ampTable: Uint8Array.from(data.amp),
    fricatives: data.fricatives.map((f) => Uint8Array.from(f)),
    periodCount: n,
    // 0x5420: `+2` when `sex` is zero, so the *first* voice is the slow one.
    waveStep: opts.sex ? 9 : 11,
  }
}

/**
 * hunk+0x52e2. The Paula period the device asks `audio.device` for, which is
 * what actually sets the sample rate.
 *
 * The numerator is the PAL colour clock over two, so playing the samples back
 * at `3546895 / period` Hz is what a real Amiga would have done.
 */
export function audioPeriod(sampfreq = 22200): number {
  return Math.floor(0x369c78 / sampfreq) & 0xffff
}

/** PAL Paula's clock, for turning that period into a sample rate. */
export const PAL_CLOCK = 3546895
