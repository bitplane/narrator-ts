import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { render, FRAME, FRAME_BYTES } from './render.js'

/**
 * The renderer, against frames captured from the real device.
 *
 * `tools/capture-frames.py` stops narrator.device at the top of its render
 * loop, dumps the frame array and the tables it is about to read, and pairs
 * them with the audio that same utterance produced. So this asks the
 * TypeScript for those samples given those frames, and nothing is asserted
 * from the implementation's own behaviour.
 *
 * A build product, like the golden corpora: absent from a clean checkout, and
 * the suite says so rather than passing vacuously.
 */
const FRAMES = 'fixtures/golden/frames.json'

/** See the comment by `check` below. */
const KNOWN_DIVERGENT = new Set<string>([])

interface Capture {
  in: string
  params: Record<string, number>
  frames: number[][]
  periodCount: number
  waveStep: number
  wave: number[]
  ampTable: number[]
  pcm: number[]
  fricatives?: number[][]
  period: number
}

const captures: Capture[] = existsSync(FRAMES)
  ? (JSON.parse(readFileSync(FRAMES, 'utf8')) as Capture[])
  : []

/** How far the two agree before diverging — a more useful number than a bool. */
function firstDiff(a: Int8Array, b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (((a[i] << 24) >> 24) !== ((b[i] << 24) >> 24)) return i
  return a.length === b.length ? -1 : n
}

describe.skipIf(captures.length === 0)('the renderer, against captured frames', () => {
  it('has captures to run against', () => {
    expect(captures.length).toBeGreaterThan(0)
  })

  for (const c of captures) {
    // The last frame is the end marker and is never rendered.
    const body = c.frames.filter((f) => (f[FRAME.F1_FREQ] & 0x80) === 0)
    const unvoiced = body.filter((f) => f[FRAME.VOICING] !== 0).length
    // Still diverging, all of them shortly after a *mixed*-voicing frame (a
    // voicing byte with bit 7 set, i.e. a voiced fricative). The device
    // freezes F1 there and we do not, so some state a mixed frame leaves
    // behind is still unaccounted for. Marked rather than hidden, so it
    // announces itself the moment it starts passing.
    const check = KNOWN_DIVERGENT.has(c.in) ? it.fails : it
    check(`${c.in} (${c.frames.length} frames, ${unvoiced} unvoiced)`, () => {
      const got = render(Uint8Array.from(c.frames.flat()), {
        wave: Uint8Array.from(c.wave),
        ampTable: Uint8Array.from(c.ampTable),
        periodCount: c.periodCount,
        waveStep: c.waveStep,
        fricatives: c.fricatives?.map((f) => Uint8Array.from(f)),
      })
      const at = firstDiff(got, c.pcm)
      expect({ diverges: at, ours: got.length, theirs: c.pcm.length })
        .toEqual({ diverges: -1, ours: c.pcm.length, theirs: c.pcm.length })
    })
  }
})

describe('the frame layout', () => {
  it('is eight bytes', () => {
    expect(FRAME_BYTES).toBe(8)
    expect(Object.keys(FRAME)).toHaveLength(8)
  })

  it.skipIf(captures.length === 0)('ends every captured array with bit 7 set', () => {
    for (const c of captures) {
      expect(c.frames.at(-1)![FRAME.F1_FREQ] & 0x80).toBeTruthy()
      // ...and only there, or the renderer would stop early.
      for (const f of c.frames.slice(0, -1)) {
        expect(f[FRAME.F1_FREQ] & 0x80).toBe(0)
      }
    }
  })
})
