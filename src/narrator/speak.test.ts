import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FRAME_BYTES, render } from './render.js'
import { synthesize, synthesizeSentence, type Voice } from './speak.js'
import { audioPeriod, renderTables, voiceFrom, type VoiceData } from './voice.js'

/**
 * The whole front half, against the device's own frame array.
 *
 * Every stage below this is already checked one at a time against the
 * snapshot either side of it, which is the right way to find *where* a port is
 * wrong. This is the other question — whether they fit together — and it is
 * the only test that starts from a string the caller could have typed.
 *
 * `stages.json`'s last snapshot is the finished frame array, so the comparison
 * is byte for byte with no allowance made anywhere. `frames.json` then carries
 * the samples the same utterance produced, so the last case here goes all the
 * way from text to PCM.
 */
const STAGES = [
  'fixtures/golden/stages.json',
  'fixtures/golden/stages-sex1.json',
  'fixtures/golden/stages-mode1.json',
  'fixtures/golden/stages-mouths.json',
]
const RENDER = [
  'fixtures/golden/frames.json',
  'fixtures/golden/frames-params.json',
  'fixtures/golden/frames-sentences.json',
]
const VOICE = 'data/narrator-33.2.json'

interface Snapshot { stage: string; frames: number[][] | null; mouths: number[] | null }
interface Capture { in: string; opts?: Record<string, number>; ok?: boolean; stages?: Snapshot[] }

const read = <T,>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined

const captures: Capture[] = STAGES.flatMap((f) => read<Capture[]>(f) ?? [])

/**
 * The tables come through `gen-voice.py` and `voiceFrom`, which is the path a
 * caller takes — so this checks that what the extractor writes is enough to
 * speak with, not just that the stages agree when hand-fed.
 */
const data = read<VoiceData>(VOICE)
const voice: Voice | undefined = data && voiceFrom(data)

const latin1 = (s: string): Uint8Array =>
  Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff))

describe.skipIf(!voice || captures.length === 0)('the front half, end to end', () => {
  it('runs on more than a handful of utterances', () => {
    expect(captures.filter((c) => c.ok !== false).length).toBeGreaterThan(50)
  })

  for (const c of captures) {
    const last = c.stages?.[c.stages.length - 1]
    if (!last || last.stage !== 'frames' || !last.frames) continue
    const opts = Object.entries(c.opts ?? {})
      .filter(([k, v]) => (k === 'sex' || k === 'mode' || k === 'mouths') && v)
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')

    it(`${JSON.stringify(c.in)}${opts}`, () => {
      const out = synthesizeSentence(latin1(c.in), voice!, {
        pitch: c.opts?.pitch,
        mode: c.opts?.mode,
        sex: c.opts?.sex,
        mouths: Boolean(c.opts?.mouths),
      })
      expect(out).not.toBeNull()
      expect(out!.total).toBe(last.frames!.length - 1)
      const got: number[][] = []
      for (let i = 0; i < last.frames!.length; i++) {
        got.push(Array.from(out!.frames.slice(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)))
      }
      expect(got).toEqual(last.frames)
      if (last.mouths) expect(Array.from(out!.mouths!)).toEqual(last.mouths)
    })
  }
})

/**
 * And the whole thing: a string in, samples out, checked against what
 * audio.device was handed.
 *
 * `capture-frames.py` records both the renderer's input and the PCM it
 * produced, so this is the only place the two halves are asked to agree
 * without the frame array being handed over from the oracle in between.
 *
 * `pcm` is the *whole* utterance, every buffer the device wrote, which is why
 * the multi-sentence corpus lives here and not in `render.test.ts`: that one
 * renders the captured frame array, and the capture only holds the first
 * sentence's.
 */
interface RenderCapture {
  in: string
  params: Record<string, number>
  frames: number[][]
  periodCount: number
  waveStep: number
  period: number
  pcm: number[]
}

const rendered = RENDER.flatMap((f) => read<RenderCapture[]>(f) ?? [])

describe.skipIf(!voice || !data || rendered.length === 0)('text to samples', () => {
  it('covers more than one set of speech parameters', () => {
    const seen = new Set(rendered.map((c) => JSON.stringify(c.params)))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('speaks nothing extra for trailing whitespace', () => {
    // The translator's output always ends in a space, so this is the common
    // case and not an edge one. The device exits its loop on the parser's `Z`
    // rather than treating what is left as an empty sentence; a port that
    // skips the pass instead of stopping speaks a stray frame or two of
    // lead-in at the end of every utterance.
    for (const c of rendered.slice(0, 8)) {
      const n = (t: string): number =>
        synthesize(latin1(t), voice!, { pitch: c.params.pitch, sex: c.params.sex })
          .reduce((k, x) => k + x.total, 0)
      expect(n(`${c.in}  `), c.in).toBe(n(c.in))
    }
  })

  it('covers utterances with more than one sentence in them', () => {
    // The device speaks one sentence per pass and loops; a corpus of
    // single-sentence phrases cannot tell a port that does not.
    const many = rendered.filter((c) => (c.in.match(/[.?]/g) ?? []).length > 1)
    expect(many.length).toBeGreaterThan(2)
  })

  for (const c of rendered) {
    const opts = Object.entries(c.params)
      .filter(([k]) => k !== 'volume' && k !== 'mouths')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')

    it(`${JSON.stringify(c.in)} ${opts}`, () => {
      // Everything the renderer needs, derived from the parameters rather
      // than lifted out of the capture — hunk+0x53fa and hunk+0x52e2.
      const tables = renderTables(data!, {
        sampfreq: c.params.sampfreq,
        rate: c.params.rate,
        sex: c.params.sex,
      })
      expect(tables.periodCount).toBe(c.periodCount)
      expect(tables.waveStep).toBe(c.waveStep)
      expect(audioPeriod(c.params.sampfreq)).toBe(c.period)

      // One buffer per sentence, each rendered on its own and joined — which
      // is what the device hands to audio.device, and not the same as joining
      // the frames and rendering once.
      const parts = synthesize(latin1(c.in), voice!, {
        pitch: c.params.pitch,
        mode: c.params.mode,
        sex: c.params.sex,
      }).map((s) => render(s.frames, tables))

      const got: number[] = []
      for (const part of parts) got.push(...part)
      expect(got).toEqual(c.pcm.map((v) => (v > 127 ? v - 256 : v)))
    })
  }
})
