import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { assignPitch, markContour } from './contour.js'

/**
 * hunk+0x19c4, against the device's stress array either side of it.
 *
 * `hunk+0x19bc` is two calls in a row, so `capture-stages.py --sub` breaks
 * between them and this one can be checked without the pitch pass that reads
 * its output.
 */
const STAGES = [
  'fixtures/golden/stages.json',
  'fixtures/golden/stages-sex1.json',
  // `mode` 1 is the monotone robot voice, a whole branch of the pitch pass
  // that no phrase can reach at the default.
  'fixtures/golden/stages-mode1.json',
]
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot {
  stage: string
  count: number
  phonemes: number[]
  stress: number[]
  flags: number[]
  params: number[][]
  scalars: number[]
  frames: number[][] | null
}
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

function pair(c: Capture, stage = 'contour/0x19c4'): [Snapshot, Snapshot] | undefined {
  const s = c.stages
  const at = s?.findIndex((x) => x.stage === stage)
  return at !== undefined && at > 0 ? [s![at - 1], s![at]] : undefined
}

/** `scalars` starts at A5+0x10, so a word at A5+off is here. */
const word = (s: Snapshot, off: number): number =>
  (s.scalars[off - 0x10] << 8) | s.scalars[off - 0x10 + 1]

const ready = captures.length > 0 && attrs !== undefined

describe.skipIf(!ready)('the contour marker, against the device', () => {
  it('is exercised by the corpus at all', () => {
    const n = captures.filter((c) => {
      const p = pair(c)
      return p && p[0].stress.join() !== p[1].stress.join()
    }).length
    expect(n).toBeGreaterThan(0)
    // The monotone branch is chosen by a parameter, so it takes its own run.
    expect(captures.some((c) => c.opts?.mode === 1)).toBe(true)
  })

  for (const c of captures) {
    const p = pair(c)
    if (!p) continue
    const opts = Object.entries(c.opts ?? {})
      .filter(([k, v]) => (k === 'sex' || k === 'mode') && v)
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')
    const tag = JSON.stringify(c.in) + opts
    it(`marker: ${tag}`, () => {
      const state = { phonemes: pad(p[0].phonemes), stress: pad(p[0].stress) }
      markContour(state, attrs!)
      expect(upTo(state.stress)).toEqual(upTo(p[1].stress))
    })

    const q = pair(c, 'contour/0x1a8e')
    if (!q?.[0].frames || !q[1].frames) continue
    it(`pitch: ${tag}`, () => {
      const frames = new Uint8Array(q[0].frames!.flat())
      assignPitch(
        {
          phonemes: pad(q[0].phonemes),
          stress: pad(q[0].stress),
          flags: pad(q[0].flags),
        },
        {
          onset: Uint8Array.from(q[0].params[0]),
          peak: Uint8Array.from(q[0].params[1]),
          end: Uint8Array.from(q[0].params[2]),
          tail: Uint8Array.from(q[0].params[3]),
        },
        frames,
        { pitch: word(q[0], 0x1c), mode: word(q[0], 0x30) },
      )
      expect(Array.from(frames)).toEqual(q[1].frames!.flat())
    })
  }
})
