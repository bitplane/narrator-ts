import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { markContour } from './contour.js'

/**
 * hunk+0x19c4, against the device's stress array either side of it.
 *
 * `hunk+0x19bc` is two calls in a row, so `capture-stages.py --sub` breaks
 * between them and this one can be checked without the pitch pass that reads
 * its output.
 */
const STAGES = ['fixtures/golden/stages.json', 'fixtures/golden/stages-sex1.json']
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot { stage: string; count: number; phonemes: number[]; stress: number[] }
interface Capture { in: string; opts?: Record<string, number>; stages?: Snapshot[] }

const captures: Capture[] = STAGES.filter(existsSync).flatMap(
  (f) => JSON.parse(readFileSync(f, 'utf8')) as Capture[],
)
const attrs: number[] | undefined = existsSync(TABLE)
  ? (JSON.parse(readFileSync(TABLE, 'utf8')) as { attrs: number | null }[])
      .filter((r) => r.attrs !== null)
      .map((r) => r.attrs as number)
  : undefined

const pad = (xs: number[]): Uint8Array => {
  const out = new Uint8Array(0x202)
  out.set(xs)
  return out
}
const upTo = (xs: ArrayLike<number>): number[] => {
  const out: number[] = []
  for (let i = 0; i < xs.length; i++) {
    out.push(xs[i])
    if (xs[i] === 0xff) break
  }
  return out
}

function pair(c: Capture): [Snapshot, Snapshot] | undefined {
  const s = c.stages
  const at = s?.findIndex((x) => x.stage === 'contour/0x19c4')
  return at !== undefined && at > 0 ? [s![at - 1], s![at]] : undefined
}

const ready = captures.length > 0 && attrs !== undefined

describe.skipIf(!ready)('the contour marker, against the device', () => {
  it('is exercised by the corpus at all', () => {
    const n = captures.filter((c) => {
      const p = pair(c)
      return p && p[0].stress.join() !== p[1].stress.join()
    }).length
    expect(n).toBeGreaterThan(0)
  })

  for (const c of captures) {
    const p = pair(c)
    if (!p) continue
    const tag = c.opts?.sex ? `${JSON.stringify(c.in)} sex=1` : JSON.stringify(c.in)
    it(tag, () => {
      const state = { phonemes: pad(p[0].phonemes), stress: pad(p[0].stress) }
      markContour(state, attrs!)
      expect(upTo(state.stress)).toEqual(upTo(p[1].stress))
    })
  }
})
