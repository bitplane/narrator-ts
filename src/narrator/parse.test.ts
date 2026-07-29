import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { LEAD_IN, parse, TERMINATOR, type PhonemeTable } from './parse.js'

/**
 * The parser, against what narrator.device itself produced.
 *
 * `tools/capture-parse.py` stops the device at its parser's exit and dumps the
 * three arrays; `tools/extract-phonemes.py` reads the tables it consulted out
 * of the binary. Both are build products, absent from a clean checkout, and
 * the suite says so rather than passing vacuously.
 */
const PARSE = ['fixtures/golden/parse.json', 'fixtures/golden/parse-edge.json']
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Capture {
  in: string
  /** False for both rejected input and input that yields no phonemes. */
  parsed: boolean
  /** The 1-based offset of the offending character, when rejected. */
  error?: number
  /** Set when the device produced nothing at all, which is not an error. */
  empty?: boolean
  count?: number
  phonemes?: number[]
  stress?: number[]
  flags?: number[]
}

const captures: Capture[] = PARSE.flatMap((f) =>
  existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Capture[]) : [],
)

const table: PhonemeTable | undefined = existsSync(TABLE)
  ? (() => {
      const rows = JSON.parse(readFileSync(TABLE, 'utf8')) as
        { index: number; name: string; attrs: number | null }[]
      return {
        names: rows.map((r) => r.name),
        attrs: rows.filter((r) => r.attrs !== null).map((r) => r.attrs as number),
      }
    })()
  : undefined

const latin1 = (s: string): Uint8Array =>
  Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)

const ready = captures.length > 0 && table !== undefined

describe.skipIf(!ready)('the parser, against the device', () => {
  it('has captures and a table to run against', () => {
    expect(captures.length).toBeGreaterThan(0)
    expect(table!.names).toHaveLength(112)
    expect(table!.attrs).toHaveLength(102)
  })

  for (const c of captures) {
    if (!c.parsed) {
      // Rejections and empty results are as much a part of the interface as
      // the phonemes are — a port that quietly accepts `S4` has diverged.
      it(`${JSON.stringify(c.in)} (${c.error !== undefined ? `rejected at ${c.error}` : 'no phonemes'})`, () => {
        const got = parse(latin1(c.in), table!)
        expect({ error: got.error, count: got.count })
          .toEqual({ error: c.error, count: 0 })
      })
      continue
    }
    it(`${JSON.stringify(c.in)} (${c.count} phonemes)`, () => {
      const got = parse(latin1(c.in), table!)
      expect(got.error).toBeUndefined()
      expect(got.count).toBe(c.count)
      // Only the written prefix is meaningful; the device's arrays keep
      // whatever the previous utterance left past the terminator.
      const take = c.count!
      expect(Array.from(got.phonemes.slice(0, take))).toEqual(c.phonemes!.slice(0, take))
      expect(Array.from(got.stress.slice(0, take))).toEqual(c.stress!.slice(0, take))
      expect(Array.from(got.flags.slice(0, take))).toEqual(c.flags!.slice(0, take))
    })
  }
})

describe.skipIf(table === undefined)('the parser, structurally', () => {
  it('seeds the lead-in with QX and starts writing at 4', () => {
    const got = parse(latin1('AA'), table!)
    expect(Array.from(got.phonemes.slice(0, LEAD_IN))).toEqual([0, 0, 0x15, 0])
    expect(got.phonemes[LEAD_IN]).toBe(13)   // AA
  })

  it('produces nothing at all for empty input', () => {
    expect(parse(new Uint8Array(0), table!).count).toBe(0)
  })

  it('terminates all three arrays', () => {
    const got = parse(latin1('AA'), table!)
    const end = got.count - 1
    expect(got.phonemes[end]).toBe(TERMINATOR)
    expect(got.stress[end]).toBe(TERMINATOR)
    expect(got.flags[end]).toBe(TERMINATOR)
  })

  it('rejects a stress digit where one may not go', () => {
    // A digit attaches to the phoneme already written, and 'S' does not take
    // one. The device reports the 1-based offset rather than an error code.
    expect(parse(latin1('S4'), table!).error).toBe(2)
  })
})
