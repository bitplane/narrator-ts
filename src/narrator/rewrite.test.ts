import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rewrite, type Rule } from './rewrite.js'

/**
 * The rewrite engine, against the device's own arrays either side of it.
 *
 * `tools/capture-stages.py` snapshots the phoneme, stress and flag arrays
 * after every stage of the front half, so each pass can be checked on its own
 * rather than only at the far end. The two passes here are stages
 * `after-parse` -> `rewrite-1` and `pre-rewrite-2` -> `rewrite-2`.
 */
const STAGES = 'fixtures/golden/stages.json'
const RULES = 'fixtures/golden/rewrite-33.2.json'
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot {
  stage: string
  count: number
  phonemes: number[]
  stress: number[]
  flags: number[]
}
interface Capture { in: string; ok: boolean; stages?: Snapshot[] }

const captures: Capture[] = existsSync(STAGES)
  ? (JSON.parse(readFileSync(STAGES, 'utf8')) as Capture[])
  : []

const tables: Record<string, { rules: Rule[] }> | undefined = existsSync(RULES)
  ? JSON.parse(readFileSync(RULES, 'utf8'))
  : undefined

const attrs: number[] | undefined = existsSync(TABLE)
  ? (JSON.parse(readFileSync(TABLE, 'utf8')) as { attrs: number | null }[])
      .filter((r) => r.attrs !== null)
      .map((r) => r.attrs as number)
  : undefined

const ready = captures.length > 0 && tables !== undefined && attrs !== undefined

/** The device's arrays are 0x200 long; a snapshot only holds the live prefix. */
function pad(xs: number[]): Uint8Array {
  const out = new Uint8Array(0x202)
  out.set(xs.subarray ? xs : Uint8Array.from(xs))
  return out
}

const PASSES = [
  { name: 'allophones', from: 'after-parse', to: 'rewrite-1' },
  { name: 'frames', from: 'pre-rewrite-2', to: 'rewrite-2' },
] as const

describe.skipIf(!ready)('the rewrite engine, against the device', () => {
  it('has captures, rules and attributes to run against', () => {
    expect(captures.length).toBeGreaterThan(0)
    expect(tables!.allophones.rules.length).toBeGreaterThan(0)
    expect(tables!.frames.rules.length).toBeGreaterThan(0)
  })

  for (const pass of PASSES) {
    for (const c of captures) {
      const before = c.stages?.find((s) => s.stage === pass.from)
      const after = c.stages?.find((s) => s.stage === pass.to)
      if (!before || !after) continue

      it(`${pass.name}: ${JSON.stringify(c.in)} (${before.count} -> ${after.count})`, () => {
        const state = {
          phonemes: pad(before.phonemes),
          stress: pad(before.stress),
          flags: pad(before.flags),
          count: before.count,
        }
        expect(rewrite(state, tables![pass.name].rules, attrs!)).toBe(true)
        const n = after.count
        expect(state.count).toBe(n)
        expect(Array.from(state.phonemes.slice(0, n))).toEqual(after.phonemes.slice(0, n))
        expect(Array.from(state.stress.slice(0, n))).toEqual(after.stress.slice(0, n))
        expect(Array.from(state.flags.slice(0, n))).toEqual(after.flags.slice(0, n))
      })
    }
  }
})
