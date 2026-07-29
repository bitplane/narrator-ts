/**
 * Render captured frames to WAV with the TypeScript renderer, so it can be
 * listened to rather than only diffed.
 *
 * The port cannot yet go from text to audio on its own — the stage that turns
 * phonemes into frames is not written — so this takes the frames the real
 * device produced (`tools/capture-frames.py`) and runs only our back half over
 * them. That is still a real test of the renderer: everything you hear after
 * the frame array is ours.
 *
 * With `--both` it writes the device's own PCM alongside, from the same
 * capture, so the two can be compared by ear as well as by byte.
 *
 *   npx vite-node tools/render-wav.ts -- -o /tmp/out            # all captures
 *   npx vite-node tools/render-wav.ts -- -o /tmp/out --both -p J
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { render } from '../src/narrator/render.js'

const FRAMES = 'fixtures/golden/frames.json'

interface Capture {
  in: string
  frames: number[][]
  periodCount: number
  waveStep: number
  wave: number[]
  ampTable: number[]
  fricatives?: number[][]
  pcm: number[]
  period: number
}

/** PAL Paula: the period the device asked audio.device for sets the rate. */
const PAL_CLOCK = 3546895

/** 8-bit WAV is unsigned, and the device's samples are signed. */
function wav(samples: Int8Array | number[], rate: number): Uint8Array {
  const n = samples.length
  const buf = new Uint8Array(44 + n)
  const view = new DataView(buf.buffer)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + n, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)          // PCM
  view.setUint16(22, 1, true)          // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)       // byte rate
  view.setUint16(32, 1, true)          // block align
  view.setUint16(34, 8, true)          // bits
  ascii(36, 'data')
  view.setUint32(40, n, true)
  for (let i = 0; i < n; i++) buf[44 + i] = (samples[i] + 128) & 0xff
  return buf
}

/** Strip anything that would need quoting, so the names stay typeable. */
const slug = (s: string): string =>
  s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'empty'

function main(): void {
  const argv = process.argv.slice(2)
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const outDir = arg('-o') ?? arg('--out')
  const only = arg('-p') ?? arg('--phrase')
  const both = argv.includes('--both')

  if (!outDir) {
    console.error('usage: render-wav.ts -o <dir> [-p <phrase>] [--both]')
    process.exit(2)
  }
  if (!existsSync(FRAMES)) {
    console.error(`${FRAMES} is missing — run tools/capture-frames.py first.`)
    process.exit(1)
  }

  const captures = JSON.parse(readFileSync(FRAMES, 'utf8')) as Capture[]
  const wanted = only ? captures.filter((c) => c.in === only) : captures
  if (wanted.length === 0) {
    console.error(`no capture for ${JSON.stringify(only)}; have:`)
    for (const c of captures) console.error(`  ${c.in}`)
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })

  for (const c of wanted) {
    const rate = Math.round(PAL_CLOCK / c.period)
    const ours = render(Uint8Array.from(c.frames.flat()), {
      wave: Uint8Array.from(c.wave),
      ampTable: Uint8Array.from(c.ampTable),
      periodCount: c.periodCount,
      waveStep: c.waveStep,
      fricatives: c.fricatives?.map((f) => Uint8Array.from(f)),
    })
    const name = slug(c.in)
    writeFileSync(join(outDir, `${name}.wav`), wav(ours, rate))
    let note = ''
    if (both) {
      const theirs = c.pcm.map((v) => (v << 24) >> 24)
      writeFileSync(join(outDir, `${name}-device.wav`), wav(theirs, rate))
      const same = ours.length === theirs.length &&
        theirs.every((v, i) => v === ours[i])
      note = same ? '  (identical to the device)' : '  (DIFFERS from the device)'
    }
    console.log(
      `${name}.wav  ${ours.length} samples at ${rate} Hz` +
      `  ${(ours.length / rate).toFixed(2)}s${note}`,
    )
  }
  console.log(`\n-> ${outDir}`)
}

main()
