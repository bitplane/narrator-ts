import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { FRAME_BYTES, render, type RenderTables } from './render.js'
import { synthesize, type Voice } from './speak.js'

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
const TABLE = 'fixtures/golden/phonemes-33.2.json'
const TABLES = 'fixtures/golden/tables-33.2.json'
const RULES = 'fixtures/golden/rewrite-33.2.json'
const RENDER = 'fixtures/golden/frames.json'

interface Row {
  index: number
  name: string
  attrs: number | null
  duration: number[] | null
  params: Record<string, number> | null
  paramsAlt: Record<string, number> | null
}
interface Snapshot { stage: string; frames: number[][] | null; mouths: number[] | null }
interface Capture { in: string; opts?: Record<string, number>; ok?: boolean; stages?: Snapshot[] }

const read = <T,>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined

const rows = read<Row[]>(TABLE)
const gain = read<{ amplitudeGain: number[] }>(TABLES)?.amplitudeGain
const rules = read<Record<'allophones' | 'frames', { rules: unknown[] }>>(RULES)
const captures: Capture[] = STAGES.flatMap((f) => read<Capture[]>(f) ?? [])

const col = (k: string): number[] => rows!.map((r) => r.params?.[k] ?? 0)

const voice: Voice | undefined =
  rows && gain && rules
    ? {
        table: {
          // `parse` matches two-character names first, so it wants the raw
          // table in index order exactly as the device holds it.
          names: rows.map((r) => r.name),
          attrs: rows.map((r) => r.attrs ?? 0),
        },
        attrs: rows.filter((r) => r.attrs !== null).map((r) => r.attrs as number),
        params: {
          f1: col('f1'), f2: col('f2'), f3: col('f3'),
          a1: col('a1'), a2: col('a2'), a3: col('a3'),
          voicing: col('voicing'),
          stressed: rows.map((r) => r.duration?.[0] ?? 0),
          unstressed: rows.map((r) => r.duration?.[1] ?? 0),
          rank: col('rank'), weight: col('weight'),
          transitionIn: col('transitionIn'), transitionOut: col('transitionOut'),
          mouth: col('mouth'),
        },
        altParams: {
          f1: rows.map((r) => r.paramsAlt?.f1 ?? 0),
          f2: rows.map((r) => r.paramsAlt?.f2 ?? 0),
          f3: rows.map((r) => r.paramsAlt?.f3 ?? 0),
        },
        gain,
        rules: [rules.allophones.rules, rules.frames.rules] as Voice['rules'],
      }
    : undefined

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
      const out = synthesize(latin1(c.in), voice!, {
        pitch: c.opts?.pitch,
        mode: c.opts?.mode,
        sex: c.opts?.sex,
        mouths: Boolean(c.opts?.mouths),
      })
      expect(out.total).toBe(last.frames!.length - 1)
      const got: number[][] = []
      for (let i = 0; i < last.frames!.length; i++) {
        got.push(Array.from(out.frames.slice(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)))
      }
      expect(got).toEqual(last.frames)
      if (last.mouths) expect(Array.from(out.mouths!)).toEqual(last.mouths)
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
 */
interface RenderCapture {
  in: string
  params: Record<string, number>
  frames: number[][]
  periodCount: number
  waveStep: number
  wave: number[]
  ampTable: number[]
  fricatives: number[][]
  pcm: number[]
}

const rendered = read<RenderCapture[]>(RENDER) ?? []

describe.skipIf(!voice || rendered.length === 0)('text to samples', () => {
  for (const c of rendered) {
    it(`${JSON.stringify(c.in)}`, () => {
      const out = synthesize(latin1(c.in), voice!, {
        pitch: c.params.pitch,
        mode: c.params.mode,
        sex: c.params.sex,
      })
      // The renderer stops on bit 7 of byte 0, which `fill` wrote as a whole
      // 0xff frame, so the array it is handed is the one this built.
      const tables: RenderTables = {
        wave: Uint8Array.from(c.wave),
        ampTable: Uint8Array.from(c.ampTable),
        fricatives: c.fricatives.map((f) => Uint8Array.from(f)),
        periodCount: c.periodCount,
        waveStep: c.waveStep,
      }
      const pcm = render(out.frames, tables)
      expect(Array.from(pcm)).toEqual(c.pcm.map((v) => (v > 127 ? v - 256 : v)))
    })
  }
})
