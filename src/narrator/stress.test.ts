import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { spreadStress } from './stress.js'

/**
 * The stress spreader, against the device's arrays either side of it —
 * stages `rewrite-1` -> `stress-decode` from `tools/capture-stages.py`.
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

describe.skipIf(!ready)('the stress spreader, against the device', () => {
  it('has captures to run against', () => {
    expect(captures.length).toBeGreaterThan(0)
  })

  for (const c of captures) {
    const before = c.stages?.find((s) => s.stage === 'rewrite-1')
    const after = c.stages?.find((s) => s.stage === 'stress-decode')
    if (!before || !after) continue

    it(`${JSON.stringify(c.in)} (${before.count} phonemes)`, () => {
      const state = {
        phonemes: pad(before.phonemes),
        stress: pad(before.stress),
        flags: pad(before.flags),
      }
      spreadStress(state, attrs!)
      const n = after.count
      // The phoneme array is untouched by this stage; assert that too, since
      // a port that quietly rewrote it would still pass on the other two.
      expect(Array.from(state.phonemes.slice(0, n))).toEqual(after.phonemes.slice(0, n))
      expect(Array.from(state.stress.slice(0, n))).toEqual(after.stress.slice(0, n))
      expect(Array.from(state.flags.slice(0, n))).toEqual(after.flags.slice(0, n))
    })
  }
})
