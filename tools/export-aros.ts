/** Package narrator-ts tables for AROS narrator/speech.device. */
import { readFileSync, writeFileSync } from 'node:fs'

import { emitArosCResource, encodeArosResource } from '../src/aros-resource/index.js'
import type { VoiceData } from '../src/narrator/voice.js'
import type { TranslatorTables } from '../src/translator/types.js'

const argv = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at < 0 ? undefined : argv[at + 1]
}
const output = value('-o') ?? value('--out')
if (!output || argv.includes('-h') || argv.includes('--help')) {
  console.error('usage: export-aros.ts -o speech.iff [--format iff|c] [--translator table.json] [--voice voice.json]')
  console.error('omitted table paths use the redistributable reference tables')
  process.exit(output ? 0 : 2)
}
const translatorPath = value('--translator') ?? 'reference/nrl-table.json'
const voicePath = value('--voice') ?? 'reference/voice-free.json'
const translator = JSON.parse(readFileSync(translatorPath, 'utf8')) as TranslatorTables
const voice = JSON.parse(readFileSync(voicePath, 'utf8')) as VoiceData
const format = value('--format') ?? (output.endsWith('.c') ? 'c' : 'iff')
if (format !== 'iff' && format !== 'c') throw new RangeError(`unknown format: ${format}`)
const resource = encodeArosResource({ translator, voice })
writeFileSync(output, format === 'c' ? emitArosCResource({ translator, voice }) : resource)
console.log(`${translator.version} + ${voice.version}: ${resource.length} resource bytes -> ${output}`)
