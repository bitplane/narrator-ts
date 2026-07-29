/**
 * Speak, with nothing but the TypeScript.
 *
 * English goes through `translate()` to phonemes, the phonemes through
 * `synthesize()` to a frame array, the frames through `render()` to samples,
 * and the samples out as a WAV at the rate a real Amiga would have played
 * them. No emulator anywhere in the path.
 *
 *   npx vite-node tools/say.ts -- 'hello world' -o hello.wav
 *   npx vite-node tools/say.ts -- -p '/HEH4LOW WER4LD' -o hello.wav
 *   npx vite-node tools/say.ts -- 'is this a question' --pitch 200 --rate 100
 *
 * The tables it loads are build products of `tools/gen-tables.py` and
 * `tools/gen-voice.py`, which read them out of Amiga binaries this repository
 * does not ship. Both print what to run if their output is missing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { render } from '../src/narrator/render.js'
import { synthesize } from '../src/narrator/speak.js'
import { audioPeriod, PAL_CLOCK, renderTables, voiceFrom, type VoiceData } from '../src/narrator/voice.ts'
import { translate } from '../src/translator/translate.js'
import type { TranslatorTables } from '../src/translator/types.js'

const DEFAULT_VERSION = '33.2'

/** 8-bit WAV is unsigned and the device's samples are signed. */
function wav(samples: Int8Array, rate: number): Uint8Array {
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
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  ascii(36, 'data')
  view.setUint32(40, n, true)
  for (let i = 0; i < n; i++) buf[44 + i] = (samples[i] + 128) & 0xff
  return buf
}

const latin1 = (s: string): Uint8Array =>
  Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff))

function main(): void {
  const argv = process.argv.slice(2)
  const flag = (...names: string[]): string | undefined => {
    for (const name of names) {
      const i = argv.indexOf(name)
      if (i >= 0) return argv[i + 1]
    }
    return undefined
  }
  const num = (...names: string[]): number | undefined => {
    const v = flag(...names)
    return v === undefined ? undefined : Number(v)
  }

  const version = flag('-V', '--version') ?? DEFAULT_VERSION
  const phonemesIn = flag('-p', '--phonemes')
  const out = flag('-o', '--out')
  // Anything not consumed as a flag or a flag's value is the text to speak.
  const consumed = new Set<number>()
  for (const [i, a] of argv.entries()) {
    if (a.startsWith('-')) {
      consumed.add(i)
      if (a !== '--mouths') consumed.add(i + 1)
    }
  }
  const text = argv.filter((_, i) => !consumed.has(i)).join(' ')

  if (!phonemesIn && !text) {
    console.error('usage: say.ts <text> -o out.wav')
    console.error('       say.ts -p <phonemes> -o out.wav')
    console.error('  --pitch N  --rate N  --sampfreq N  --sex 0|1  --mode 0|1')
    process.exit(2)
  }

  const voicePath = `data/narrator-${version}.json`
  if (!existsSync(voicePath)) {
    console.error(`${voicePath} is missing. Build it with:`)
    console.error(`  python3 tools/gen-voice.py fixtures/amiga/narrator_device-${version}-*.bin -o data`)
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(voicePath, 'utf8')) as VoiceData
  const voice = voiceFrom(data)

  let phonemes = phonemesIn
  if (phonemes === undefined) {
    const rulePath = `data/translator-${version}.json`
    if (!existsSync(rulePath)) {
      console.error(`${rulePath} is missing. Build it with:`)
      console.error(`  python3 tools/gen-tables.py fixtures/amiga/translator_library-${version}-*.bin -o data`)
      process.exit(1)
    }
    const rules = JSON.parse(readFileSync(rulePath, 'utf8')) as TranslatorTables
    const t = translate(text, rules)
    if (t.rc !== 0) {
      console.error(`translator returned ${t.rc} for ${JSON.stringify(text)}`)
      process.exit(1)
    }
    phonemes = t.phonemes
    console.log(`${JSON.stringify(text)} -> ${JSON.stringify(phonemes)}`)
  }

  const sampfreq = num('--sampfreq') ?? 22200
  // One buffer per sentence, as the device produces them, each rendered on its
  // own — the waveform pointer and pitch phase start again at every one.
  const sentences = synthesize(latin1(phonemes), voice, {
    pitch: num('--pitch'),
    mode: num('--mode'),
    sex: num('--sex'),
    mouths: argv.includes('--mouths'),
  })
  const tables = renderTables(data, { sampfreq, rate: num('--rate'), sex: num('--sex') })
  const parts = sentences.map((s) => render(s.frames, tables))

  const pcm = new Int8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const part of parts) {
    pcm.set(part, off)
    off += part.length
  }

  const rate = Math.round(PAL_CLOCK / audioPeriod(sampfreq))
  const seconds = (pcm.length / rate).toFixed(2)
  const frames = sentences.reduce((n, s) => n + s.total, 0)
  const where = sentences.length === 1 ? '' : ` in ${sentences.length} sentences`
  console.log(`${frames} frames${where}, ${pcm.length} samples at ${rate} Hz, ${seconds}s`)
  for (const s of sentences) {
    if (s.mouths) console.log(`mouth shapes: ${Array.from(s.mouths.slice(0, 24)).join(' ')}...`)
  }

  if (out) {
    writeFileSync(out, wav(pcm, rate))
    console.log(`-> ${out}`)
  } else {
    console.log('(no -o, so nothing written)')
  }
}

main()
