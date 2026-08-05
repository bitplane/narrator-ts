import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { VoiceData } from '../narrator/voice.js'
import type { TranslatorTables } from '../translator/types.js'
import { AROS_RESOURCE_VERSION, decodeArosResource, emitArosCResource, encodeArosResource } from './index.js'

const translator = JSON.parse(readFileSync('reference/nrl-table.json', 'utf8')) as TranslatorTables
const voice = JSON.parse(readFileSync('reference/voice-free.json', 'utf8')) as VoiceData
const metadata = {
  generator: 'narrator-ts test',
  translatorLicense: 'Public domain; US Government work',
  voiceLicense: 'Public domain',
}

function chunkIds(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ids: string[] = []
  for (let at = 12; at < bytes.length;) {
    ids.push(String.fromCharCode(...bytes.subarray(at, at + 4)))
    const size = view.getUint32(at + 4)
    at += 8 + size + (size & 1)
  }
  return ids
}

function chunkOffset(bytes: Uint8Array, wanted: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 12; at < bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4))
    if (id === wanted) return at
    const size = view.getUint32(at + 4)
    at += 8 + size + (size & 1)
  }
  throw new Error(`missing ${wanted}`)
}

function resourceWithUnknownJson(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept: Uint8Array[] = []
  for (let at = 12; at < bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4))
    const size = view.getUint32(at + 4), total = 8 + size + (size & 1)
    if (id === 'VERS' || id === 'LTRS' || [
      'VNAM', 'VATR', 'VPRM', 'VALT', 'VDUR', 'VGAN', 'VRL1', 'VRL2',
      'VWAV', 'VAMP', 'VFRI',
    ].includes(id)) kept.push(bytes.slice(at, at + total))
    at += total
  }
  const json = new TextEncoder().encode('{"legacy":true}')
  const meta = new Uint8Array(8 + json.length + (json.length & 1))
  meta.set(new TextEncoder().encode('META'))
  new DataView(meta.buffer).setUint32(4, json.length)
  meta.set(json, 8)
  const bodyLength = 4 + kept.reduce((n, part) => n + part.length, 0) + meta.length
  const out = new Uint8Array(8 + bodyLength)
  out.set(new TextEncoder().encode('FORM'), 0)
  new DataView(out.buffer).setUint32(4, bodyLength)
  out.set(new TextEncoder().encode('NARR'), 8)
  let at = 12
  out.set(meta, at); at += meta.length
  for (const part of kept) { out.set(part, at); at += part.length }
  return out
}

describe('AROS Narrator IFF resource', () => {
  it('round-trips the deployment tables', () => {
    const encoded = encodeArosResource({ translator, voice, metadata })
    const decoded = decodeArosResource(encoded)
    expect(String.fromCharCode(...encoded.subarray(0, 4))).toBe('FORM')
    expect(String.fromCharCode(...encoded.subarray(8, 12))).toBe('NARR')
    expect(decoded.version).toBe(AROS_RESOURCE_VERSION)
    expect(chunkIds(encoded)).toEqual([
      'VERS', 'FVER', 'TVER', 'TSRC', 'TLIC', 'LTRS',
      'VVER', 'VSRC', 'VLIC', 'VNAM', 'VATR', 'VPRM', 'VALT', 'VDUR',
      'VGAN', 'VRL1', 'VRL2', 'VWAV', 'VAMP', 'VFRI',
    ])
    expect(chunkIds(encoded)).not.toContain('META')
    expect(decoded.metadata).toEqual({
      generator: metadata.generator,
      translator: {
        version: translator.version,
        source: translator.source,
        license: metadata.translatorLicense,
      },
      voice: {
        version: voice.version,
        source: voice.source,
        license: metadata.voiceLicense,
      },
    })
    expect(decoded.translator?.classes).toEqual(translator.classes)
    expect(decoded.translator?.buckets).toEqual(translator.buckets)
    expect(decoded.voice?.names).toEqual(voice.names)
    expect(decoded.voice?.params.f1.slice(0, voice.params.f1.length)).toEqual(voice.params.f1)
    expect(decoded.voice?.params.f1.slice(voice.params.f1.length)).toEqual(
      new Array(voice.names.length - voice.params.f1.length).fill(0),
    )
    expect(decoded.voice?.paramsAlt.f1.slice(0, voice.paramsAlt.f1.length)).toEqual(voice.paramsAlt.f1)
    expect(decoded.voice?.gain).toEqual(voice.gain)
    const deploymentRule = ({ match, left, right, flags, replace, insertBefore, insertAfter, tests }:
      VoiceData['rules']['allophones']['rules'][number]) =>
      ({ match, left, right, flags, replace, insertBefore, insertAfter, tests })
    expect(decoded.voice?.rules.allophones.rules).toEqual(voice.rules.allophones.rules.map(deploymentRule))
    expect(decoded.voice?.rules.frames.rules).toEqual(voice.rules.frames.rules.map(deploymentRule))
    expect(decoded.voice?.wave).toEqual(voice.wave)
    expect(decoded.voice?.amp).toEqual(voice.amp)
    expect(decoded.voice?.fricatives).toEqual(voice.fricatives)
  })

  it('rejects truncated resources', () => {
    const encoded = encodeArosResource({
      translator,
      metadata: { generator: metadata.generator, translatorLicense: metadata.translatorLicense },
    })
    expect(() => decodeArosResource(encoded.subarray(0, encoded.length - 1))).toThrow(/resource|FORM|chunk/)
  })

  it('can emit the resource as portable C', () => {
    const input = {
      translator,
      metadata: { generator: metadata.generator, translatorLicense: metadata.translatorLicense },
    }
    const bytes = encodeArosResource(input)
    const source = emitArosCResource(input, 'test_resource')
    const cBytes = Uint8Array.from(
      Array.from(source.matchAll(/0x([0-9a-f]{2})/g), (match) => Number.parseInt(match[1], 16)),
    )
    expect(source).toContain('const uint8_t test_resource[]')
    expect(source).toContain('const size_t test_resource_length')
    expect(cBytes).toEqual(bytes)
    expect(() => emitArosCResource({
      translator,
      metadata: { generator: metadata.generator, translatorLicense: metadata.translatorLicense },
    }, 'not-a-symbol')).toThrow(/symbol/)
  })

  it('ignores unknown JSON metadata without parsing it', () => {
    const encoded = encodeArosResource({ translator, voice, metadata })
    const decoded = decodeArosResource(resourceWithUnknownJson(encoded))
    expect(decoded.metadata).toEqual({})
    expect(decoded.translator?.classes).toEqual(translator.classes)
    expect(decoded.voice?.names).toEqual(voice.names)
  })

  it('rejects invalid native metadata', () => {
    expect(() => encodeArosResource({
      translator,
      metadata: { generator: 'narrator-ts test', translatorLicense: '' },
    })).toThrow(/license/)
    expect(() => encodeArosResource({
      translator,
      metadata: { generator: 'narrator-ts\0test', translatorLicense: 'Public domain' },
    })).toThrow(/Latin-1/)
    expect(() => encodeArosResource({
      translator,
      metadata: { generator: 'x'.repeat(256), translatorLicense: 'Public domain' },
    })).toThrow(/255/)

    const encoded = encodeArosResource({ translator, voice, metadata })
    const nulText = encoded.slice()
    nulText[chunkOffset(nulText, 'FVER') + 8] = 0
    expect(() => decodeArosResource(nulText)).toThrow(/FVER/)

    const duplicate = encoded.slice()
    duplicate.set(new TextEncoder().encode('FVER'), chunkOffset(duplicate, 'TVER'))
    expect(() => decodeArosResource(duplicate)).toThrow(/duplicate FVER/)
  })
})
