/**
 * narrator.device 33.2, as a library.
 *
 * {@link speak} is the whole of it. The stages below are exported because the
 * device's own interface exposes them — the singing-voice hacks drive it
 * phoneme by phoneme, and a lip-sync caller wants the mouth stream without the
 * audio — not because a normal caller needs them.
 */

export { speak, type SpeechResult } from './speak.js'
export {
  synthesize,
  synthesizeSentence,
  SpeakError,
  type Speech,
  type SpeakOptions,
  type Voice,
} from './speak.js'
export { render, FRAME, FRAME_BYTES, type RenderTables } from './render.js'
export {
  voiceFrom,
  renderTables,
  audioPeriod,
  PAL_CLOCK,
  type VoiceData,
  type RenderOptions,
} from './voice.js'
export { parse, MAX_PHONEMES, TERMINATOR, type Parsed, type PhonemeTable } from './parse.js'
export type { Params } from './frames.js'
export type { Attrs, Rule } from './rewrite.js'
