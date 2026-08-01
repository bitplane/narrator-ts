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
  console.error('       [--translator-license text] [--voice-license text]')
  console.error('omitted table paths use the redistributable reference tables')
  process.exit(output ? 0 : 2)
}
const translatorArgument = value('--translator')
const voiceArgument = value('--voice')
const translatorPath = translatorArgument ?? 'reference/nrl-table.json'
const voicePath = voiceArgument ?? 'reference/voice-free.json'
const translator = JSON.parse(readFileSync(translatorPath, 'utf8')) as TranslatorTables
const voice = JSON.parse(readFileSync(voicePath, 'utf8')) as VoiceData
const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}
const metadata = {
  generator: `${packageInfo.name} ${packageInfo.version}`,
  translatorLicense: value('--translator-license') ?? (translatorArgument === undefined
    ? 'Public domain; US Government work'
    : 'User supplied; redistribution not granted'),
  voiceLicense: value('--voice-license') ?? (voiceArgument === undefined
    ? 'Public domain'
    : 'User supplied; redistribution not granted'),
}
const input = { translator, voice, metadata }
const format = value('--format') ?? (output.endsWith('.c') ? 'c' : 'iff')
if (format !== 'iff' && format !== 'c') throw new RangeError(`unknown format: ${format}`)
const resource = encodeArosResource(input)
writeFileSync(output, format === 'c' ? emitArosCResource(input) : resource)
console.log(`${translator.version} + ${voice.version}: ${resource.length} resource bytes -> ${output}`)
