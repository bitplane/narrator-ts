import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  applyGain,
  fillMarkedRuns,
  fillZeroRuns,
  smooth7,
  intrinsicPitch,
  smooth7Weighted,
} from './interpolate.js'

/**
 * The four zero-run passes and the three marked-run passes of hunk+0x29d8,
 * against the frame array either side of each.
 *
 * The three amplitude columns are done by one call in the device, so they
 * share a boundary and are checked together.
 */
const STAGES = [
  'fixtures/golden/stages.json',
  'fixtures/golden/stages-sex1.json',
  'fixtures/golden/stages-mode1.json',
]

const TABLES = 'fixtures/golden/tables-33.2.json'
const gain: number[] | undefined = existsSync(TABLES)
  ? (JSON.parse(readFileSync(TABLES, 'utf8')) as { amplitudeGain: number[] }).amplitudeGain
  : undefined

const PHONEMES = 'fixtures/golden/phonemes-33.2.json'
const attrs: number[] | undefined = existsSync(PHONEMES)
  ? (JSON.parse(readFileSync(PHONEMES, 'utf8')) as { attrs: number | null }[])
      .filter((r) => r.attrs !== null)
      .map((r) => r.attrs as number)
  : undefined

interface Snapshot {
  stage: string
  phonemes: number[]
  flags: number[]
  frames: number[][] | null
}
interface Capture { in: string; opts?: Record<string, number>; stages?: Snapshot[] }

const captures: Capture[] = STAGES.filter(existsSync).flatMap(
  (f) => JSON.parse(readFileSync(f, 'utf8')) as Capture[],
)

function pair(c: Capture, stage: string): [Snapshot, Snapshot] | undefined {
  const s = c.stages
  const at = s?.findIndex((x) => x.stage === stage)
  return at !== undefined && at > 0 ? [s![at - 1], s![at]] : undefined
}

/** Column each pass works on, in the order hunk+0x29d8 runs them. */
const ZERO_PASSES: [string, number][] = [
  ['frames/fill-f1', 0],
  ['frames/fill-f2', 1],
  ['frames/fill-f3', 2],
  ['frames/fill-pitch', 7],
]

describe.skipIf(captures.length === 0)('the frame interpolator, against the device', () => {
  it('the corpus exercises every pass', () => {
    for (const [stage] of [...ZERO_PASSES, ['frames/fill-amplitudes']] as [string][]) {
      const n = captures.filter((c) => {
        const p = pair(c, stage)
        return p?.[0].frames && p[1].frames && p[0].frames.flat().join() !== p[1].frames.flat().join()
      }).length
      expect(n, stage).toBeGreaterThan(0)
    }
  })

  for (const c of captures) {
    const opts = Object.entries(c.opts ?? {})
      .filter(([k, v]) => (k === 'sex' || k === 'mode') && v)
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')
    const tag = JSON.stringify(c.in) + opts

    for (const [stage, column] of ZERO_PASSES) {
      const p = pair(c, stage)
      if (!p?.[0].frames || !p[1].frames) continue
      it(`${stage.slice(7)}: ${tag}`, () => {
        const frames = new Uint8Array(p[0].frames!.flat())
        fillZeroRuns(frames, column)
        expect(Array.from(frames)).toEqual(p[1].frames!.flat())
      })
    }

    const p = pair(c, 'frames/fill-amplitudes')
    if (!p?.[0].frames || !p[1].frames) continue
    it(`fill-amplitudes: ${tag}`, () => {
      const frames = new Uint8Array(p[0].frames!.flat())
      // hunk+0x2a4a: bytes 3, 4 and 5, in that order.
      for (const column of [3, 4, 5]) fillMarkedRuns(frames, column)
      expect(Array.from(frames)).toEqual(p[1].frames!.flat())
    })

    for (const [stage, run, column] of [
      ['frames/0x2d54-f2', smooth7, 1],
      ['frames/0x2d86-f3', smooth7Weighted, 2],
      ['frames/0x2d54-pitch', smooth7, 7],
    ] as const) {
      const q = pair(c, stage)
      if (!q?.[0].frames || !q[1].frames) continue
      it(`${stage.slice(7)}: ${tag}`, () => {
        const frames = new Uint8Array(q[0].frames!.flat())
        run(frames, column)
        expect(Array.from(frames)).toEqual(q[1].frames!.flat())
      })
    }

    const ip = pair(c, 'frames/0x2dca')
    if (ip?.[0].frames && ip[1].frames && attrs !== undefined) {
      it(`intrinsic pitch: ${tag}`, () => {
        const frames = new Uint8Array(ip[0].frames!.flat())
        intrinsicPitch(
          Uint8Array.from(ip[0].phonemes),
          Uint8Array.from(ip[0].flags),
          attrs,
          frames,
        )
        expect(Array.from(frames)).toEqual(ip[1].frames!.flat())
      })
    }

    const g = pair(c, 'frames/0x2d1c')
    if (!g?.[0].frames || !g[1].frames || gain === undefined) continue
    it(`gain curve: ${tag}`, () => {
      const frames = new Uint8Array(g[0].frames!.flat())
      applyGain(frames, gain)
      expect(Array.from(frames)).toEqual(g[1].frames!.flat())
    })
  }
})
