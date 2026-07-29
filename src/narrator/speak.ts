/**
 * narrator.device's front half, end to end — `hunk+0x7fe` to `hunk+0x872` of
 * build 33.2.
 *
 * The device's `CMD_WRITE` is a straight run of eleven jumps, and this is
 * those eleven with the arrays threaded between them. Nothing here is a
 * decision of its own: every stage is a routine ported and checked on its own
 * against the binary, and the only thing this adds is the order and the shape
 * of the workspace they share.
 *
 * The output is a **frame array** — eight bytes per frame, the thing
 * `render()` turns into samples — and, if asked, the mouth-shape stream that
 * runs alongside it.
 *
 * The tables are a parameter rather than a constant. They are Commodore's,
 * extracted from a binary this project does not redistribute, so the library
 * takes them from the caller and ships none.
 */

import { markContour, assignPitch, type PitchArrays } from './contour.js'
import { assignDurations } from './duration.js'
import {
  allocate,
  compact,
  continuationDurations,
  fill,
  markFirst,
  blendTransitions,
  markTransitions,
  type Params,
} from './frames.js'
import {
  applyGain,
  fillMarkedRuns,
  fillZeroRuns,
  intrinsicPitch,
  nasalise,
  shapeFrication,
  smooth7,
  smooth7Weighted,
  smoothMouths,
} from './interpolate.js'
import { markOnsets } from './onset.js'
import { MAX_PHONEMES, parse, TERMINATOR, type PhonemeTable } from './parse.js'
import { nextPhrase, pitchLoopBody, type ProsodyState } from './prosody.js'
import { rewrite, type Attrs, type Rule } from './rewrite.js'
import { spreadStress } from './stress.js'

/** Everything the synthesizer reads out of the device's own data. */
export interface Voice {
  /** The spellings the parser matches, and their attributes. */
  table: PhonemeTable
  /** One attribute longword per phoneme — `hunk+0x2f08`. */
  attrs: Attrs
  /** The per-phoneme parameter columns — `hunk+0x3506` onwards. */
  params: Params
  /** The second voice's three frequency columns — `hunk+0x50ae`. */
  altParams: Pick<Params, 'f1' | 'f2' | 'f3'>
  /** The 32-entry amplitude curve — `hunk+0x2cfc`. */
  gain: readonly number[]
  /** The two rewrite rule sets — `hunk+0x968` and `hunk+0xae3`. */
  rules: readonly [readonly Rule[], readonly Rule[]]
}

/** The fields of `narrator_rb` the front half looks at. */
export interface SpeakOptions {
  /** `A5+0x1c`. Divided into a constant to get every pitch period. */
  pitch?: number
  /** `A5+0x30`. 1 is the monotone robot voice. */
  mode?: number
  /** `A5+0x34`. 1 swaps in the second voice's formant frequencies. */
  sex?: number
  /** `A5+0xdb`. Asks for the lip-sync stream as well. */
  mouths?: boolean
}

export interface Speech {
  /** Eight bytes per frame, with one terminator frame past the end. */
  frames: Uint8Array
  /** Frames written, terminator excluded — the device's `A5+0x3a`. */
  total: number
  /**
   * One byte per frame, a width in the low nibble and a height in the high
   * one. Only when `mouths` was asked for.
   */
  mouths?: Uint8Array
}

/** What the device reports in `io_Error` rather than speaking. */
export class SpeakError extends Error {
  constructor(
    message: string,
    /** 1-based offset of the offending character, when the parser found one. */
    readonly at?: number,
  ) {
    super(message)
    this.name = 'SpeakError'
  }
}

/** The eight `0x80`-byte per-syllable arrays at `A5+0x6e8`. */
const ARRAYS = 8
const ARRAY_LEN = 0x80

/** `hunk+0x1e1c` steps the three cursors past the parser's two lead-in slots. */
const LEAD_IN = 2

/**
 * Turn a phoneme string into frames, exactly as `CMD_WRITE` does.
 *
 * `input` is bytes rather than a string because the device works in Latin-1
 * and reads one byte past what it was given.
 */
export function synthesize(
  input: Uint8Array,
  voice: Voice,
  opts: SpeakOptions = {},
): Speech {
  const { attrs, params } = voice
  const pitch = opts.pitch ?? 110
  const mode = opts.mode ?? 0

  // ------------------------------------------------------------------ 0xf68
  const parsed = parse(input, voice.table)
  if (parsed.error !== undefined) {
    throw new SpeakError(`not a phoneme at character ${parsed.error}`, parsed.error)
  }
  const { phonemes, stress, flags } = parsed
  const state = { phonemes, stress, flags, count: parsed.count }

  // 0x112c, then the first rewrite pass, then the stress spreader.
  markOnsets(state, attrs)
  if (!rewrite(state, voice.rules[0], attrs)) {
    throw new SpeakError('too many phonemes after the first rewrite pass')
  }
  spreadStress(state, attrs)

  // ----------------------------------------------------------------- 0x1e1c
  // The pitch stage's own workspace: eight arrays, seven counters, and three
  // cursors that start past the lead-in.
  const prosody: ProsodyState = {
    phonemes,
    stress,
    flags,
    atPhoneme: LEAD_IN,
    atStress: LEAD_IN,
    atFlag: LEAD_IN,
    arr: Array.from({ length: ARRAYS }, () => new Uint8Array(ARRAY_LEN)),
    arrAt: 0,
    counters: {
      pass: 0, stresses: 0, syllables: 0, first: 0,
      boundaries: 0, last: 0, total: 0,
    },
  }

  // 0x832: one phrase per turn until there is none left.
  while (nextPhrase(prosody, attrs)) pitchLoopBody(prosody, attrs, mode)

  // 0x846: durations, then the second rewrite pass.
  assignDurations(state, attrs, params)
  if (!rewrite(state, voice.rules[1], attrs)) {
    throw new SpeakError('too many phonemes after the second rewrite pass')
  }

  // ----------------------------------------------------------------- 0x1454
  // Seven routines that turn phonemes and durations into the frame array.
  compact(state, attrs)
  continuationDurations(state, attrs, params)
  const { frames, total } = allocate(state)
  const mouths = opts.mouths ? new Uint8Array(total) : undefined
  fill(state, attrs, params, frames, opts.sex ? voice.altParams : undefined, mouths)
  markFirst(frames)
  blendTransitions(state, attrs, params, frames)
  markTransitions(state, attrs, params, frames)

  // ----------------------------------------------------------------- 0x19bc
  markContour(state, attrs)
  assignPitch(state, contourArrays(prosody), frames, { pitch, mode })

  // ----------------------------------------------------------------- 0x29d8
  // Four columns of holes filled, two smoothed, the microprosody, then the
  // frication and nasal fixes, the amplitudes, and the gain curve.
  for (const column of [0, 1, 2, 7]) fillZeroRuns(frames, column)
  smooth7(frames, 1)
  smooth7Weighted(frames, 2)
  intrinsicPitch(phonemes, flags, attrs, frames)
  smooth7(frames, 7)
  shapeFrication(phonemes, flags, attrs, frames)
  for (const column of [3, 4, 5]) fillMarkedRuns(frames, column)
  applyGain(frames, voice.gain)
  nasalise(phonemes, flags, attrs, params, frames)
  if (mouths) smoothMouths(mouths, total)

  return { frames, total, mouths }
}

/**
 * The four arrays `hunk+0x1a8e` reads, out of the eight the pitch stage keeps.
 *
 * It addresses them from the array *bases*, not from the cursors the loop
 * advanced, so this is deliberately not `subarray(arrAt)`.
 */
function contourArrays(prosody: ProsodyState): PitchArrays {
  return {
    onset: prosody.arr[0],
    peak: prosody.arr[1],
    end: prosody.arr[2],
    tail: prosody.arr[3],
  }
}

/** Re-exported so a caller can size a buffer without reaching into `parse`. */
export { MAX_PHONEMES, TERMINATOR }
