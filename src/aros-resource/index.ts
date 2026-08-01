/**
 * AROS Narrator resource interchange.
 *
 * The file is an ordinary big-endian IFF FORM. `LTRS` holds the compact
 * letter-to-sound table and `NVOI` the subset of a voice consumed by AROS's
 * bounded narrator engine. Unknown chunks can be skipped by older readers.
 */

import type { VoiceData } from '../narrator/voice.js'
import type { TranslatorTables } from '../translator/types.js'

export const AROS_RESOURCE_FORM = 'NARR'
export const AROS_RESOURCE_VERSION = 1

const VOICE_COLUMNS = [
  'f1', 'f2', 'f3', 'a1', 'a2', 'a3', 'voicing', 'mouth',
] as const
const ALT_VOICE_COLUMNS = ['f1', 'f2', 'f3'] as const

export interface ArosResourceInput {
  translator?: TranslatorTables
  voice?: VoiceData
}

export interface ArosVoiceTables {
  names: string[]
  attrs: number[]
  params: Record<(typeof VOICE_COLUMNS)[number], number[]>
  paramsAlt: Record<(typeof ALT_VOICE_COLUMNS)[number], number[]>
  stressed: number[]
  unstressed: number[]
  fricatives: number[][]
}

export interface DecodedArosResource {
  version: number
  metadata: Record<string, unknown>
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

function voiceChunk(data: VoiceData): Uint8Array {
  const count = data.names.length
  if (count === 0 || count > 0xffff) throw new RangeError('invalid voice name count')
  const w = new Writer()
  w.u16(count)
  for (const name of data.names) {
    if (name.length > 2) throw new RangeError(`phoneme name is longer than two bytes: ${name}`)
    w.u8(name.charCodeAt(0) || 0); w.u8(name.charCodeAt(1) || 0)
  }
  for (const value of padded(data.attrs, count)) w.u32(value)
  for (const name of VOICE_COLUMNS.slice(0, 3)) w.raw(padded(data.params[name], count))
  for (const name of ALT_VOICE_COLUMNS) w.raw(padded(data.paramsAlt[name], count))
  for (const name of VOICE_COLUMNS.slice(3)) w.raw(padded(data.params[name], count))
  w.raw(padded(data.stressed, count))
  w.raw(padded(data.unstressed, count))
  const fricativeLength = data.fricatives[0]?.length ?? 0
  w.u16(data.fricatives.length); w.u16(fricativeLength)
  for (const table of data.fricatives) {
    if (table.length !== fricativeLength) throw new RangeError('fricative tables have unequal lengths')
    w.raw(table)
  }
  return w.finish()
}

/** Encode free or extracted tables as the AROS deployment resource. */
export function encodeArosResource(input: ArosResourceInput): Uint8Array {
  if (!input.translator && !input.voice) throw new RangeError('resource contains no tables')
  const version = new Writer(); version.u32(AROS_RESOURCE_VERSION)
  const meta = new TextEncoder().encode(JSON.stringify({
    format: 'AROS Narrator Resource',
    translator: input.translator && { version: input.translator.version, source: input.translator.source },
    voice: input.voice && { version: input.voice.version, source: input.voice.source },
  }))
  const chunks = [chunk('VERS', version.finish()), chunk('META', meta)]
  if (input.translator) chunks.push(chunk('LTRS', translatorChunk(input.translator)))
  if (input.voice) chunks.push(chunk('NVOI', voiceChunk(input.voice)))
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
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) throw new RangeError('truncated IFF chunk')
    const id = ascii(at), size = u32(at + 4), start = at + 8, end = start + size
    if (end > bytes.length) throw new RangeError('truncated IFF chunk payload')
    chunks.set(id, bytes.subarray(start, end))
    at = end + (size & 1)
  }
  return chunks
}

function decodeTranslator(bytes: Uint8Array): TranslatorTables {
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
  return { version: 'resource', source: 'IFF LTRS', classes, wildcards, vowels, buckets }
}

function decodeVoice(bytes: Uint8Array): ArosVoiceTables {
  const r = new Reader(bytes), count = r.u16()
  const names = Array.from({ length: count }, () => {
    const a = r.u8(), b = r.u8()
    return String.fromCharCode(a, b).replace(/\0+$/, '')
  })
  const attrs = Array.from({ length: count }, () => r.u32())
  const params = {} as ArosVoiceTables['params']
  for (const name of VOICE_COLUMNS.slice(0, 3)) params[name] = r.vector(count)
  const paramsAlt = {} as ArosVoiceTables['paramsAlt']
  for (const name of ALT_VOICE_COLUMNS) paramsAlt[name] = r.vector(count)
  for (const name of VOICE_COLUMNS.slice(3)) params[name] = r.vector(count)
  const stressed = r.vector(count), unstressed = r.vector(count)
  const fricativeCount = r.u16(), fricativeLength = r.u16()
  const fricatives = Array.from({ length: fricativeCount }, () => r.vector(fricativeLength))
  if (!r.done()) throw new RangeError('trailing voice data')
  return { names, attrs, params, paramsAlt, stressed, unstressed, fricatives }
}

/** Decode and validate an AROS resource, primarily for tools and tests. */
export function decodeArosResource(bytes: Uint8Array): DecodedArosResource {
  const chunks = chunksFrom(bytes)
  const versionBytes = chunks.get('VERS')
  if (!versionBytes || versionBytes.length !== 4) throw new RangeError('missing resource version')
  const version = new DataView(versionBytes.buffer, versionBytes.byteOffset, 4).getUint32(0)
  if (version !== AROS_RESOURCE_VERSION) throw new RangeError(`unsupported resource version ${version}`)
  const metadata = JSON.parse(new TextDecoder().decode(chunks.get('META') ?? new Uint8Array())) as Record<string, unknown>
  const translator = chunks.has('LTRS') ? decodeTranslator(chunks.get('LTRS')!) : undefined
  const voice = chunks.has('NVOI') ? decodeVoice(chunks.get('NVOI')!) : undefined
  return { version, metadata, translator, voice }
}
