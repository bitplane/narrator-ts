import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { assignDurations, type Durations } from './duration.js'

/**
 * hunk+0x1be8, checked against the device's arrays either side of it.
 *
 * The stage before it in `stages.json` is `loop-test`, the last thing the
 * pitch loop runs; the one after is `pre-rewrite-2`. Only the flag array
 * changes between them, and only its low six bits.
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
interface Row { attrs: number | null; duration: [number, number] | null }

const captures: Capture[] = existsSync(STAGES)
  ? (JSON.parse(readFileSync(STAGES, 'utf8')) as Capture[])
  : []

const rows: Row[] | undefined = existsSync(TABLE)
  ? (JSON.parse(readFileSync(TABLE, 'utf8')) as Row[])
  : undefined

const attrs = rows?.filter((r) => r.attrs !== null).map((r) => r.attrs as number)
const table: Durations | undefined = rows && {
  stressed: rows.map((r) => r.duration?.[0] ?? 0),
  unstressed: rows.map((r) => r.duration?.[1] ?? 0),
}

const pad = (xs: number[]): Uint8Array => {
  const out = new Uint8Array(0x202)
  out.set(xs)
  return out
}

/** The snapshot the driver takes just before hunk+0x1be8 runs. */
const before = (c: Capture): Snapshot | undefined => {
  const s = c.stages
  const at = s?.findIndex((x) => x.stage === 'pre-rewrite-2')
  return at !== undefined && at > 0 ? s![at - 1] : undefined
}

const ready = captures.length > 0 && attrs !== undefined && table !== undefined

describe.skipIf(!ready)('duration assignment, against the device', () => {
  it('is exercised by the corpus at all', () => {
    let n = 0
    for (const c of captures) {
      const a = before(c)
      const b = c.stages?.find((s) => s.stage === 'pre-rewrite-2')
      if (a && b && a.flags.join() !== b.flags.join()) n++
    }
    expect(n).toBeGreaterThan(0)
  })

  for (const c of captures) {
    const a = before(c)
    const b = c.stages?.find((s) => s.stage === 'pre-rewrite-2')
    if (!a || !b) continue

    it(`${JSON.stringify(c.in)} (${a.count} phonemes)`, () => {
      const state = {
        phonemes: pad(a.phonemes),
        stress: pad(a.stress),
        flags: pad(a.flags),
      }
      assignDurations(state, attrs!, table!)
      const n = b.count
      expect(Array.from(state.flags.slice(0, n))).toEqual(b.flags.slice(0, n))
      // Nothing else moves.
      expect(Array.from(state.stress.slice(0, n))).toEqual(b.stress.slice(0, n))
      expect(Array.from(state.phonemes.slice(0, n))).toEqual(b.phonemes.slice(0, n))
    })
  }
})
