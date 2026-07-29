import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  boundaryFall,
  markBoundaries,
  nextPhrase,
  phrasePitch,
  markCadence,
  markPunctuation,
  markVoiced,
  linkSyllables,
  scanPhrase,
  syllablePitch,
  syllableRange,
  type ProsodyState,
} from './prosody.js'

/**
 * The five routines of hunk+0x1ee0, against the device either side of each.
 *
 * These run once per phrase, so a capture holds one set of boundaries per
 * iteration of the driver's loop rather than one each — hence `pairs()`
 * instead of the `pair()` the other stage tests use. A one-phrase utterance
 * still goes round twice, the second time only to be told there is nothing
 * left, so the last iteration is the one that exercises the empty case.
 */
const STAGES = [
  'fixtures/golden/stages.json',
  'fixtures/golden/stages-sex1.json',
  'fixtures/golden/stages-mode1.json',
]
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot {
  stage: string
  phonemes: number[]
  stress: number[]
  flags: number[]
  params: number[][]
  scalars: number[]
  a5: number
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

/** `scalars` starts at A5+0x10. */
const SCALAR_BASE = 0x10
const word = (s: Snapshot, off: number): number =>
  (s.scalars[off - SCALAR_BASE] << 8) | s.scalars[off - SCALAR_BASE + 1]
const long = (s: Snapshot, off: number): number => {
  let v = 0
  for (let k = 0; k < 4; k++) v = v * 256 + s.scalars[off - SCALAR_BASE + k]
  return v
}

/** The three array bases in the workspace, for turning pointers into indices. */
const PHONEMES = 0xe8
const STRESS = 0x2e8
const FLAGS = 0x4e8

const pad = (xs: number[]): Uint8Array => {
  const out = new Uint8Array(0x202)
  out.set(xs)
  return out
}

function stateOf(s: Snapshot): ProsodyState {
  return {
    phonemes: pad(s.phonemes),
    stress: pad(s.stress),
    flags: pad(s.flags),
    atPhoneme: long(s, 0x7c) - s.a5 - PHONEMES,
    atStress: long(s, 0x84) - s.a5 - STRESS,
    atFlag: long(s, 0x80) - s.a5 - FLAGS,
    arr: s.params.map((p) => Uint8Array.from(p)),
    // A5+0x6c is arr4's cursor; all eight move together.
    arrAt: long(s, 0x6c) - s.a5 - 0x8e8,
    counters: {
      pass: word(s, 0x88),
      stresses: word(s, 0x8a),
      syllables: word(s, 0x8c),
      first: word(s, 0x8e),
      boundaries: word(s, 0x90),
      last: word(s, 0x9e),
      total: word(s, 0xa0),
    },
  }
}

/**
 * Everything the routines are allowed to have changed, as one comparable.
 *
 * `pass` is excluded from the per-routine comparisons because none of the
 * five touches it — hunk+0x1ee0 increments it before calling the first — and
 * the whole-loop test below puts it back.
 */
function shape(state: ProsodyState, withPass = false): unknown {
  const { pass, ...rest } = state.counters
  return {
    arr: state.arr.map((a) => Array.from(a)),
    at: [state.atPhoneme, state.atStress, state.atFlag, state.arrAt],
    counters: withPass ? { pass, ...rest } : rest,
  }
}
const shapeOf = (s: Snapshot, withPass = false): unknown => shape(stateOf(s), withPass)

/** The snapshot the driver took just before entering hunk+0x1ee0. */
function loopPairs(c: Capture): [Snapshot, Snapshot][] {
  const s = c.stages ?? []
  const out: [Snapshot, Snapshot][] = []
  const tests = s.map((x, i) => [x, i] as const).filter(([x]) => x.stage === 'loop-test')
  let from = 0
  for (const [, at] of tests) {
    while (from < at && s[from].stage !== 'pitch/0x1f02') from++
    if (from >= at) break
    out.push([s[from - 1], s[at]])
    from = at + 1
  }
  return out
}

/** Every (input, output) pair for a stage, one per pass round the loop. */
function pairs(c: Capture, stage: string): [Snapshot, Snapshot][] {
  const out: [Snapshot, Snapshot][] = []
  const s = c.stages ?? []
  for (let i = 1; i < s.length; i++) if (s[i].stage === stage) out.push([s[i - 1], s[i]])
  return out
}

const ready = captures.length > 0 && attrs !== undefined

describe.skipIf(!ready)('the prosody pass, against the device', () => {
  it('the corpus drives more than one phrase in some utterance', () => {
    // Two passes is the minimum (one phrase, then the empty check), so a
    // corpus that never reaches three has never tested the loop carrying
    // state from one phrase to the next.
    expect(Math.max(...captures.map((c) => pairs(c, 'pitch/0x1f02').length))).toBeGreaterThan(2)
  })

  for (const c of captures) {
    const opts = Object.entries(c.opts ?? {})
      .filter(([k, v]) => (k === 'sex' || k === 'mode') && v)
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')
    const base = JSON.stringify(c.in) + opts

    // hunk+0x2160 skips its whole body for a phrase with no primary stress in
    // it, so these are counted off against each other rather than against the
    // phrase index — a capture can hold fewer of them than it holds phrases.
    const peaks = pairs(c, 'body/0x21b8')
    const spreads = pairs(c, 'body/0x220c')
    const ranges = pairs(c, 'body/0x230c')
    const links = pairs(c, 'body/0x23ce')
    const falls = pairs(c, 'body/0x25f8')
    for (const [i, [before, after]] of peaks.entries()) {
      it(`phrase pitch: ${base} stressed phrase ${i + 1}`, () => {
        const state = stateOf(before)
        phrasePitch(state)
        expect(shape(state)).toEqual(shapeOf(after))
      })

      const spread = spreads[i]
      if (!spread) continue
      it(`syllable pitch: ${base} stressed phrase ${i + 1}`, () => {
        // `D0` carries hunk+0x21b8's result into hunk+0x220c, so it has to
        // come from running that rather than from the snapshot.
        const pitch = phrasePitch(stateOf(before))
        const state = stateOf(spread[0])
        syllablePitch(state, pitch)
        expect(shape(state)).toEqual(shapeOf(spread[1]))
      })

      const range = ranges[i]
      if (!range) continue
      it(`syllable range: ${base} stressed phrase ${i + 1}`, () => {
        const state = stateOf(range[0])
        syllableRange(state)
        expect(shape(state)).toEqual(shapeOf(range[1]))
      })

      const link = links[i]
      if (!link) continue
      it(`link syllables: ${base} stressed phrase ${i + 1}`, () => {
        const state = stateOf(link[0])
        linkSyllables(state)
        expect(shape(state)).toEqual(shapeOf(link[1]))
      })

      const fall = falls[i]
      if (!fall) continue
      it(`boundary fall: ${base} stressed phrase ${i + 1}`, () => {
        const state = stateOf(fall[0])
        boundaryFall(state)
        expect(shape(state)).toEqual(shapeOf(fall[1]))
      })
    }

    for (const [i, [before, after]] of loopPairs(c).entries()) {
      it(`whole loop test: ${base} phrase ${i + 1}`, () => {
        const state = stateOf(before)
        nextPhrase(state, attrs!)
        expect(shape(state, true)).toEqual(shapeOf(after, true))
      })
    }

    for (const [i, [before, after]] of pairs(c, 'pitch/0x1f02').entries()) {
      const tag = `${base} phrase ${i + 1}`

      it(`scan: ${tag}`, () => {
        const state = stateOf(before)
        scanPhrase(state, attrs!)
        expect(shape(state)).toEqual(shapeOf(after))
      })

      // The four after it only run when the scan found a phrase.
      const rest = ['pitch/0x1fd8', 'pitch/0x20bc', 'pitch/0x20d0', 'pitch/0x210a']
      const found = rest.map((s) => pairs(c, s)[i])
      if (found.some((p) => p === undefined)) continue

      it(`boundaries: ${tag}`, () => {
        const state = stateOf(found[0][0])
        markBoundaries(state, attrs!)
        expect(shape(state)).toEqual(shapeOf(found[0][1]))
      })

      // `D4` is a register the device never reloads, and 0x1fd8 recounts into
      // it, so the last three see *its* count rather than the scan's.
      const counted = markBoundaries(stateOf(found[0][0]), attrs!)

      it(`voiced: ${tag}`, () => {
        const state = stateOf(found[1][0])
        markVoiced(state, counted)
        expect(shape(state)).toEqual(shapeOf(found[1][1]))
      })

      it(`punctuation: ${tag}`, () => {
        const state = stateOf(found[2][0])
        markPunctuation(state, counted)
        expect(shape(state)).toEqual(shapeOf(found[2][1]))
      })

      it(`cadence: ${tag}`, () => {
        const state = stateOf(found[3][0])
        markCadence(state, counted)
        expect(shape(state)).toEqual(shapeOf(found[3][1]))
      })
    }
  }
})
