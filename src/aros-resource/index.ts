/**
 * AROS Narrator resource interchange.
 *
 * The file is an ordinary big-endian IFF FORM. `LTRS` holds the compact
 * letter-to-sound table. The voice uses separate native IFF chunks so each
 * table is independently inspectable and no JSON parser is needed on AROS.
 */

import type { VoiceData } from '../narrator/voice.js'
import type { TranslatorTables } from '../translator/types.js'

export const AROS_RESOURCE_FORM = 'NARR'
export const AROS_RESOURCE_VERSION = 1

const VOICE_COLUMNS = [
  'f1', 'f2', 'f3', 'a1', 'a2', 'a3', 'voicing', 'rank', 'weight',
  'transitionIn', 'transitionOut', 'mouth',
] as const
const ALT_VOICE_COLUMNS = ['f1', 'f2', 'f3'] as const

export interface ArosResourceInput {
  translator?: TranslatorTables
  voice?: VoiceData
  metadata: {
    generator: string
    translatorLicense?: string
    voiceLicense?: string
  }
}

export interface ArosComponentMetadata {
  version?: string
  source?: string
  license?: string
}

export interface ArosResourceMetadata {
  generator?: string
  translator?: ArosComponentMetadata
  voice?: ArosComponentMetadata
}

export interface ArosVoiceTables {
  names: string[]
  attrs: number[]
  params: Record<(typeof VOICE_COLUMNS)[number], number[]>
  paramsAlt: Record<(typeof ALT_VOICE_COLUMNS)[number], number[]>
  stressed: number[]
  unstressed: number[]
  gain: number[]
  rules: VoiceData['rules']
  wave: number[]
  amp: number[]
  fricatives: number[][]
}

export interface DecodedArosResource {
  version: number
  metadata: ArosResourceMetadata
  translator?: TranslatorTables
  voice?: ArosVoiceTables
}

class Writer {
  private readonly bytes: number[] = []

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`not a byte: ${value}`)
    this.bytes.push(value)
  }

  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`not a u16: ${value}`)
    this.bytes.push(value >>> 8, value & 0xff)
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`not a u32: ${value}`)
    this.bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }

  raw(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.u8(values[i])
  }

  id(value: string): void {
    if (value.length !== 4) throw new RangeError(`IFF ID must have four characters: ${value}`)
    for (const c of value) this.u8(c.charCodeAt(0))
  }

  latin8(value: string): void {
    if (value.length > 0xff) throw new RangeError('string is too long')
    this.u8(value.length)
    for (const c of value) {
      const code = c.charCodeAt(0)
      if (code > 0xff) throw new RangeError(`not Latin-1: ${JSON.stringify(c)}`)
      this.u8(code)
    }
  }

  text(value: string, label: string): void {
    if (value.length === 0 || value.length > 0xff) throw new RangeError(`${label} must be 1..255 bytes`)
    for (const c of value) {
      const code = c.charCodeAt(0)
      if (code === 0 || code > 0xff) throw new RangeError(`${label} is not non-NUL Latin-1 text`)
      this.u8(code)
    }
  }

  finish(): Uint8Array { return Uint8Array.from(this.bytes) }
}

class Reader {
  private at = 0
  constructor(private readonly bytes: Uint8Array) {}

  private need(count: number): void {
    if (this.at + count > this.bytes.length) throw new RangeError('truncated AROS speech resource')
  }

  u8(): number { this.need(1); return this.bytes[this.at++] }
  u16(): number { return (this.u8() << 8) | this.u8() }
  u32(): number { return ((this.u8() * 0x1000000) + (this.u8() << 16) + (this.u8() << 8) + this.u8()) >>> 0 }
  latin8(): string {
    const n = this.u8()
    this.need(n)
    let out = ''
    for (let i = 0; i < n; i++) out += String.fromCharCode(this.u8())
    return out
  }
  vector(count: number): number[] {
    this.need(count)
    const out = Array.from(this.bytes.subarray(this.at, this.at + count))
    this.at += count
    return out
  }
  done(): boolean { return this.at === this.bytes.length }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

function chunk(id: string, payload: Uint8Array): Uint8Array {
  const w = new Writer()
  w.id(id)
  w.u32(payload.length)
  w.raw(payload)
  if (payload.length & 1) w.u8(0)
  return w.finish()
}

function textChunk(id: string, value: string): Uint8Array {
  const w = new Writer()
  w.text(value, id)
  return chunk(id, w.finish())
}

function translatorChunk(data: TranslatorTables): Uint8Array {
  if (data.classes.length !== 128 || data.buckets.length !== 28) throw new RangeError('invalid translator table shape')
  const w = new Writer()
  w.u16(data.classes.length)
  for (const value of data.classes) w.u16(value)
  w.latin8(data.wildcards)
  w.u8(data.vowels.length)
  for (const vowel of data.vowels) w.latin8(vowel)
  w.u16(data.buckets.length)
  for (const bucket of data.buckets) {
    w.u16(bucket.length)
    for (const [left, match, right, out, term] of bucket) {
      w.latin8(left); w.latin8(match); w.latin8(right); w.latin8(out)
      if (term.length !== 1) throw new RangeError('translator rule terminator must be one byte')
      w.u8(term.charCodeAt(0))
    }
  }
  return w.finish()
}

function padded(values: readonly number[] | undefined, count: number): number[] {
  const out = new Array<number>(count).fill(0)
  if (values) for (let i = 0; i < Math.min(values.length, count); i++) out[i] = values[i]
  return out
}

function voiceChunks(data: VoiceData): Uint8Array[] {
  const count = data.names.length
  if (count === 0 || count > 0xffff) throw new RangeError('invalid voice name count')
  if (data.wave.length < 4096) throw new RangeError('wave table is shorter than 4096 bytes')
  const names = new Writer(); names.u16(count)
  for (const name of data.names) {
    if (name.length > 2) throw new RangeError(`phoneme name is longer than two bytes: ${name}`)
    names.u8(name.charCodeAt(0) || 0); names.u8(name.charCodeAt(1) || 0)
  }
  const attrs = new Writer()
  for (const value of padded(data.attrs, count)) attrs.u32(value)
  const params = new Writer()
  for (const name of VOICE_COLUMNS) params.raw(padded(data.params[name], count))
  const alt = new Writer()
  for (const name of ALT_VOICE_COLUMNS) alt.raw(padded(data.paramsAlt[name], count))
  const durations = new Writer()
  durations.raw(padded(data.stressed, count)); durations.raw(padded(data.unstressed, count))
  const rules = (set: VoiceData['rules'][keyof VoiceData['rules']]): Uint8Array => {
    const out = new Writer(); out.u16(set.rules.length)
    for (const rule of set.rules) {
      out.u8(rule.match); out.u8(rule.left); out.u8(rule.right); out.u8(rule.flags)
      out.u8(rule.replace); out.u8(rule.insertBefore); out.u8(rule.insertAfter)
      out.u8(rule.tests.length); out.raw(rule.tests)
    }
    return out.finish()
  }
  const fricatives = new Writer()
  const fricativeLength = data.fricatives[0]?.length ?? 0
  fricatives.u16(data.fricatives.length); fricatives.u16(fricativeLength)
  for (const table of data.fricatives) {
    if (table.length !== fricativeLength) throw new RangeError('fricative tables have unequal lengths')
    fricatives.raw(table)
  }
  return [
    chunk('VNAM', names.finish()), chunk('VATR', attrs.finish()),
    chunk('VPRM', params.finish()), chunk('VALT', alt.finish()),
    chunk('VDUR', durations.finish()), chunk('VGAN', Uint8Array.from(data.gain)),
    chunk('VRL1', rules(data.rules.allophones)), chunk('VRL2', rules(data.rules.frames)),
    chunk('VWAV', Uint8Array.from(data.wave.slice(0, 4096))), chunk('VAMP', Uint8Array.from(data.amp)),
    chunk('VFRI', fricatives.finish()),
  ]
}

/** Encode free or extracted tables as the AROS deployment resource. */
export function encodeArosResource(input: ArosResourceInput): Uint8Array {
  if (!input.translator && !input.voice) throw new RangeError('resource contains no tables')
  if (!input.metadata?.generator) throw new RangeError('resource generator is required')
  if (input.translator && !input.metadata.translatorLicense) throw new RangeError('translator license is required')
  if (input.voice && !input.metadata.voiceLicense) throw new RangeError('voice license is required')
  const version = new Writer(); version.u32(AROS_RESOURCE_VERSION)
  const chunks = [chunk('VERS', version.finish()), textChunk('FVER', input.metadata.generator)]
  if (input.translator) {
    chunks.push(textChunk('TVER', input.translator.version))
    chunks.push(textChunk('TSRC', input.translator.source))
    chunks.push(textChunk('TLIC', input.metadata.translatorLicense!))
    chunks.push(chunk('LTRS', translatorChunk(input.translator)))
  }
  if (input.voice) {
    chunks.push(textChunk('VVER', input.voice.version))
    chunks.push(textChunk('VSRC', input.voice.source))
    chunks.push(textChunk('VLIC', input.metadata.voiceLicense!))
    chunks.push(...voiceChunks(input.voice))
  }
  const body = concat(chunks)
  const head = new Writer(); head.id('FORM'); head.u32(body.length + 4); head.id(AROS_RESOURCE_FORM)
  return concat([head.finish(), body])
}

/** Emit the same IFF bytes as a C array for ROM or built-in resource use. */
export function emitArosCResource(
  input: ArosResourceInput,
  symbol = 'sc_speech_resource',
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) throw new RangeError(`invalid C symbol: ${symbol}`)
  const bytes = encodeArosResource(input)
  const rows: string[] = []
  for (let at = 0; at < bytes.length; at += 12) {
    rows.push(`    ${Array.from(bytes.subarray(at, at + 12), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`)
  }
  return [
    '/* Generated by narrator-ts; do not edit. */',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '',
    `const uint8_t ${symbol}[] = {`,
    ...rows,
    '};',
    `const size_t ${symbol}_length = sizeof(${symbol});`,
    '',
  ].join('\n')
}

function chunksFrom(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 12) throw new RangeError('truncated IFF FORM')
  const ascii = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  const u32 = (at: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at)
  if (ascii(0) !== 'FORM' || ascii(8) !== AROS_RESOURCE_FORM || u32(4) + 8 !== bytes.length) throw new RangeError('not an AROS Narrator IFF resource')
  const chunks = new Map<string, Uint8Array>()
  const singletons = new Set([
    'VERS', 'FVER', 'TVER', 'TSRC', 'TLIC', 'LTRS', 'VVER', 'VSRC', 'VLIC',
    'VNAM', 'VATR', 'VPRM', 'VALT', 'VDUR', 'VGAN', 'VRL1', 'VRL2',
    'VWAV', 'VAMP', 'VFRI',
  ])
  let at = 12
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new RangeError('truncated IFF chunk')
    const id = ascii(at), size = u32(at + 4), start = at + 8, end = start + size
    if (end > bytes.length) throw new RangeError('truncated IFF chunk payload')
    if (singletons.has(id) && chunks.has(id)) throw new RangeError(`duplicate ${id} chunk`)
    chunks.set(id, bytes.subarray(start, end))
    at = end + (size & 1)
  }
  if (at !== bytes.length) throw new RangeError('missing IFF pad byte')
  return chunks
}

function decodeText(bytes: Uint8Array | undefined, id: string): string | undefined {
  if (!bytes) return undefined
  if (bytes.length === 0 || bytes.length > 0xff || bytes.includes(0)) throw new RangeError(`invalid ${id} text chunk`)
  return String.fromCharCode(...bytes)
}

function decodeTranslator(bytes: Uint8Array, metadata?: ArosComponentMetadata): TranslatorTables {
  const r = new Reader(bytes)
  const classes = Array.from({ length: r.u16() }, () => r.u16())
  const wildcards = r.latin8()
  const vowels = Array.from({ length: r.u8() }, () => r.latin8())
  const buckets: TranslatorTables['buckets'] = []
  const bucketCount = r.u16()
  for (let b = 0; b < bucketCount; b++) {
    const rules: TranslatorTables['buckets'][number] = []
    const count = r.u16()
    for (let i = 0; i < count; i++) rules.push([r.latin8(), r.latin8(), r.latin8(), r.latin8(), String.fromCharCode(r.u8())])
    buckets.push(rules)
  }
  if (!r.done()) throw new RangeError('trailing translator data')
  return {
    version: metadata?.version ?? 'resource',
    source: metadata?.source ?? 'IFF LTRS',
    classes, wildcards, vowels, buckets,
  }
}

function requiredChunk(chunks: Map<string, Uint8Array>, id: string): Uint8Array {
  const value = chunks.get(id)
  if (!value) throw new RangeError(`missing ${id} chunk`)
  return value
}

function decodeVoice(chunks: Map<string, Uint8Array>): ArosVoiceTables {
  const namesReader = new Reader(requiredChunk(chunks, 'VNAM')), count = namesReader.u16()
  const names = Array.from({ length: count }, () => {
    const a = namesReader.u8(), b = namesReader.u8()
    return String.fromCharCode(a, b).replace(/\0+$/, '')
  })
  if (!namesReader.done()) throw new RangeError('trailing VNAM data')
  const attrsReader = new Reader(requiredChunk(chunks, 'VATR'))
  const attrs = Array.from({ length: count }, () => attrsReader.u32())
  if (!attrsReader.done()) throw new RangeError('invalid VATR length')
  const paramsReader = new Reader(requiredChunk(chunks, 'VPRM'))
  const params = {} as ArosVoiceTables['params']
  for (const name of VOICE_COLUMNS) params[name] = paramsReader.vector(count)
  if (!paramsReader.done()) throw new RangeError('invalid VPRM length')
  const altReader = new Reader(requiredChunk(chunks, 'VALT'))
  const paramsAlt = {} as ArosVoiceTables['paramsAlt']
  for (const name of ALT_VOICE_COLUMNS) paramsAlt[name] = altReader.vector(count)
  if (!altReader.done()) throw new RangeError('invalid VALT length')
  const durationReader = new Reader(requiredChunk(chunks, 'VDUR'))
  const stressed = durationReader.vector(count), unstressed = durationReader.vector(count)
  if (!durationReader.done()) throw new RangeError('invalid VDUR length')
  const decodeRules = (id: string): VoiceData['rules']['allophones'] => {
    const rr = new Reader(requiredChunk(chunks, id)), ruleCount = rr.u16()
    const rules = Array.from({ length: ruleCount }, () => ({
      match: rr.u8(), left: rr.u8(), right: rr.u8(), flags: rr.u8(),
      replace: rr.u8(), insertBefore: rr.u8(), insertAfter: rr.u8(),
      tests: rr.vector(rr.u8()),
    }))
    if (!rr.done()) throw new RangeError(`trailing ${id} data`)
    return { rules }
  }
  const fr = new Reader(requiredChunk(chunks, 'VFRI'))
  const fricativeCount = fr.u16(), fricativeLength = fr.u16()
  const fricatives = Array.from({ length: fricativeCount }, () => fr.vector(fricativeLength))
  if (!fr.done()) throw new RangeError('trailing VFRI data')
  const gain = Array.from(requiredChunk(chunks, 'VGAN'))
  const wave = Array.from(requiredChunk(chunks, 'VWAV'))
  const amp = Array.from(requiredChunk(chunks, 'VAMP'))
  if (gain.length !== 32 || wave.length !== 4096 || amp.length !== 1024)
    throw new RangeError('invalid fixed voice table length')
  return {
    names, attrs, params, paramsAlt, stressed, unstressed, gain,
    rules: { allophones: decodeRules('VRL1'), frames: decodeRules('VRL2') },
    wave, amp, fricatives,
  }
}

/** Decode and validate an AROS resource, primarily for tools and tests. */
export function decodeArosResource(bytes: Uint8Array): DecodedArosResource {
  const chunks = chunksFrom(bytes)
  const versionBytes = chunks.get('VERS')
  if (!versionBytes || versionBytes.length !== 4) throw new RangeError('missing resource version')
  const version = new DataView(versionBytes.buffer, versionBytes.byteOffset, 4).getUint32(0)
  if (version !== AROS_RESOURCE_VERSION) throw new RangeError(`unsupported resource version ${version}`)
  const translatorMetadata: ArosComponentMetadata = {
    version: decodeText(chunks.get('TVER'), 'TVER'),
    source: decodeText(chunks.get('TSRC'), 'TSRC'),
    license: decodeText(chunks.get('TLIC'), 'TLIC'),
  }
  const voiceMetadata: ArosComponentMetadata = {
    version: decodeText(chunks.get('VVER'), 'VVER'),
    source: decodeText(chunks.get('VSRC'), 'VSRC'),
    license: decodeText(chunks.get('VLIC'), 'VLIC'),
  }
  const metadata: ArosResourceMetadata = {}
  const generator = decodeText(chunks.get('FVER'), 'FVER')
  if (generator !== undefined) metadata.generator = generator
  if (Object.values(translatorMetadata).some((value) => value !== undefined))
    metadata.translator = translatorMetadata
  if (Object.values(voiceMetadata).some((value) => value !== undefined))
    metadata.voice = voiceMetadata
  const translator = chunks.has('LTRS') ? decodeTranslator(chunks.get('LTRS')!, metadata.translator) : undefined
  const voice = chunks.has('VNAM') ? decodeVoice(chunks) : undefined
  return { version, metadata, translator, voice }
}
