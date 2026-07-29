import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { fillMarkedRuns, fillZeroRuns } from './interpolate.js'

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

interface Snapshot { stage: string; frames: number[][] | null }
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
  }
})
