import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  allocate,
  compact,
  continuationDurations,
  fill,
  FRAME,
  markFirst,
  type FrameState,
  type Params,
} from './frames.js'

/**
 * The five ported sub-routines of hunk+0x1454, each against the device's own
 * state either side of it.
 *
 * `capture-stages.py --sub` breaks inside the driver, so `dur/0x1970` is the
 * snapshot taken *after* 0x1970 returns and the one before it is its input.
 * Breaking it up is what makes a wrong sub-routine nameable rather than
 * showing up as a wrong frame array at the far end of all seven.
 *
 * The `sex=1` captures are here because no phrase reaches the second voice's
 * frequency table however it is written — that branch is chosen by a
 * parameter, so covering it takes a second run rather than a longer corpus.
 */
const STAGES = ['fixtures/golden/stages.json', 'fixtures/golden/stages-sex1.json']
const TABLE = 'fixtures/golden/phonemes-33.2.json'

interface Snapshot {
  stage: string
  count: number
  phonemes: number[]
  stress: number[]
  flags: number[]
  frames: number[][] | null
}
interface Capture { in: string; opts?: Record<string, number>; stages?: Snapshot[] }
interface Row {
  attrs: number | null
  duration: [number, number] | null
  params: Record<string, number> | null
  paramsAlt: Record<string, number> | null
}

const captures: Capture[] = STAGES.filter(existsSync).flatMap(
  (f) => JSON.parse(readFileSync(f, 'utf8')) as Capture[],
)
const rows: Row[] | undefined = existsSync(TABLE)
  ? (JSON.parse(readFileSync(TABLE, 'utf8')) as Row[])
  : undefined

const attrs = rows?.filter((r) => r.attrs !== null).map((r) => r.attrs as number)
const col = (k: string): number[] => rows!.map((r) => r.params?.[k] ?? 0)
const table: Params | undefined = rows && {
  f1: col('f1'), f2: col('f2'), f3: col('f3'),
  a1: col('a1'), a2: col('a2'), a3: col('a3'),
  voicing: col('voicing'),
  stressed: rows.map((r) => r.duration?.[0] ?? 0),
  unstressed: rows.map((r) => r.duration?.[1] ?? 0),
}

/** The second voice's frequencies — hunk+0x50ae, chosen by `sex`. */
const alt = rows && {
  f1: rows.map((r) => r.paramsAlt?.f1 ?? 0),
  f2: rows.map((r) => r.paramsAlt?.f2 ?? 0),
  f3: rows.map((r) => r.paramsAlt?.f3 ?? 0),
}

const ready = captures.length > 0 && attrs !== undefined && table !== undefined

const pad = (xs: number[]): Uint8Array => {
  const out = new Uint8Array(0x202)
  out.set(xs)
  return out
}

const stateOf = (s: Snapshot): FrameState => ({
  phonemes: pad(s.phonemes),
  stress: pad(s.stress),
  flags: pad(s.flags),
  count: s.count,
})

/** The snapshot the driver took immediately before `stage`. */
function pair(c: Capture, stage: string): [Snapshot, Snapshot] | undefined {
  const s = c.stages
  const at = s?.findIndex((x) => x.stage === stage)
  return at !== undefined && at > 0 ? [s![at - 1], s![at]] : undefined
}

/** Everything up to the array's own 0xff terminator. */
const upTo = (xs: ArrayLike<number>): number[] => {
  const out: number[] = []
  for (let i = 0; i < xs.length; i++) {
    out.push(xs[i])
    if (xs[i] === 0xff) break
  }
  return out
}

/** How many captures make this stage change something. */
function changedBy(stage: string, field: 'phonemes' | 'stress' | 'flags'): number {
  let n = 0
  for (const c of captures) {
    const p = pair(c, stage)
    if (p && p[0][field].join() !== p[1][field].join()) n++
  }
  return n
}

describe.skipIf(!ready)('the frame-array builder, against the device', () => {
  it('the corpus exercises every ported sub-routine', () => {
    expect(changedBy('dur/0x1970', 'phonemes')).toBeGreaterThan(0)
    expect(changedBy('dur/0x1492', 'flags')).toBeGreaterThan(0)
    // The two below write the frame array rather than the workspace.
    const fills = captures.filter((c) => pair(c, 'dur/0x15e0')?.[1].frames).length
    expect(fills).toBeGreaterThan(0)
    // And the second voice's frequency table, which no phrase reaches at the
    // default `sex` however it is written.
    expect(captures.some((c) => c.opts?.sex)).toBe(true)
  })

  for (const c of captures) {
    const tag = c.opts?.sex ? `${JSON.stringify(c.in)} sex=1` : JSON.stringify(c.in)
    const compaction = pair(c, 'dur/0x1970')
    if (!compaction) continue

    it(`compaction: ${tag}`, () => {
      const state = stateOf(compaction[0])
      compact(state, attrs!)
      expect(upTo(state.phonemes)).toEqual(upTo(compaction[1].phonemes))
      expect(upTo(state.stress)).toEqual(upTo(compaction[1].stress))
      expect(upTo(state.flags)).toEqual(upTo(compaction[1].flags))
    })

    const cont = pair(c, 'dur/0x1492')!
    it(`continuation durations: ${tag}`, () => {
      const state = stateOf(cont[0])
      continuationDurations(state, attrs!, table!)
      expect(upTo(state.flags)).toEqual(upTo(cont[1].flags))
      expect(upTo(state.stress)).toEqual(upTo(cont[1].stress))
    })

    const filled = pair(c, 'dur/0x15e0')!
    const want = filled[1].frames
    if (!want) continue

    it(`total and fill: ${tag} (${want.length - 1} frames)`, () => {
      const state = stateOf(filled[0])
      const { frames, total } = allocate(state)
      expect(total).toBe(want.length - 1)

      fill(state, attrs!, table!, frames, c.opts?.sex ? alt : undefined)
      // Byte 7 is not written by this stage and the device's heap is not
      // cleared, so compare the seven bytes it does own.
      const got = []
      for (let i = 0; i < want.length; i++) {
        got.push(Array.from(frames.slice(i * FRAME, i * FRAME + 7)))
      }
      expect(got).toEqual(want.map((f) => f.slice(0, 7)))
    })

    const marked = pair(c, 'dur/0x1472')!
    if (!marked[0].frames || !marked[1].frames) continue

    it(`first-frame marker: ${tag}`, () => {
      const frames = new Uint8Array(marked[0].frames!.flat())
      markFirst(frames)
      expect(Array.from(frames)).toEqual(marked[1].frames!.flat())
    })
  }
})
