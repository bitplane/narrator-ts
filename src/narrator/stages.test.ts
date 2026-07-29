import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { markOnsets } from './onset.js'

/**
 * Front-half stages that are small enough not to want a file each, checked
 * against the device's arrays either side of them.
 *
 * The snapshots come from `tools/capture-stages.py`; the stage names are the
 * ones in the table in research/02-narrator.md.
 */
const STAGES = 'fixtures/golden/stages.json'
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot {
  stage: string
  count: number
  phonemes: number[]
  stress: number[]
  flags: number[]
}
interface Capture { in: string; stages?: Snapshot[] }

const captures: Capture[] = existsSync(STAGES)
  ? (JSON.parse(readFileSync(STAGES, 'utf8')) as Capture[])
  : []

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

const ready = captures.length > 0 && attrs !== undefined

/** How many of the captures actually make this stage do something. */
function changedBy(from: string, to: string, field: keyof Snapshot): number {
  let n = 0
  for (const c of captures) {
    const a = c.stages?.find((s) => s.stage === from)
    const b = c.stages?.find((s) => s.stage === to)
    if (!a || !b) continue
    const xs = a[field] as number[]
    const ys = b[field] as number[]
    if (xs.slice(0, b.count).join() !== ys.slice(0, b.count).join()) n++
  }
  return n
}

describe.skipIf(!ready)('the onset marker, against the device', () => {
  it('is exercised by the corpus at all', () => {
    // Guards against the whole suite below passing because the stage happens
    // to be a no-op on everything captured.
    expect(changedBy('parse', 'after-parse', 'stress')).toBeGreaterThan(0)
  })

  for (const c of captures) {
    const before = c.stages?.find((s) => s.stage === 'parse')
    const after = c.stages?.find((s) => s.stage === 'after-parse')
    if (!before || !after) continue

    it(`${JSON.stringify(c.in)} (${before.count} phonemes)`, () => {
      const state = { phonemes: pad(before.phonemes), stress: pad(before.stress) }
      markOnsets(state, attrs!)
      const n = after.count
      expect(Array.from(state.stress.slice(0, n))).toEqual(after.stress.slice(0, n))
      expect(Array.from(state.phonemes.slice(0, n))).toEqual(after.phonemes.slice(0, n))
    })
  }
})
