import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { VoiceData } from '../narrator/voice.js'
import type { TranslatorTables } from '../translator/types.js'
import { AROS_RESOURCE_VERSION, decodeArosResource, emitArosCResource, encodeArosResource } from './index.js'

const translator = JSON.parse(readFileSync('reference/nrl-table.json', 'utf8')) as TranslatorTables
const voice = JSON.parse(readFileSync('reference/voice-free.json', 'utf8')) as VoiceData

describe('AROS Narrator IFF resource', () => {
  it('round-trips the deployment tables', () => {
    const encoded = encodeArosResource({ translator, voice })
    const decoded = decodeArosResource(encoded)
    expect(String.fromCharCode(...encoded.subarray(0, 4))).toBe('FORM')
    expect(String.fromCharCode(...encoded.subarray(8, 12))).toBe('NARR')
    expect(decoded.version).toBe(AROS_RESOURCE_VERSION)
    expect(decoded.translator?.classes).toEqual(translator.classes)
    expect(decoded.translator?.buckets).toEqual(translator.buckets)
    expect(decoded.voice?.names).toEqual(voice.names)
    expect(decoded.voice?.params.f1.slice(0, voice.params.f1.length)).toEqual(voice.params.f1)
    expect(decoded.voice?.params.f1.slice(voice.params.f1.length)).toEqual(
      new Array(voice.names.length - voice.params.f1.length).fill(0),
    )
    expect(decoded.voice?.paramsAlt.f1.slice(0, voice.paramsAlt.f1.length)).toEqual(voice.paramsAlt.f1)
    expect(decoded.voice?.fricatives).toEqual(voice.fricatives)
  })

  it('rejects truncated resources', () => {
    const encoded = encodeArosResource({ translator })
    expect(() => decodeArosResource(encoded.subarray(0, encoded.length - 1))).toThrow(/resource|FORM|chunk/)
  })

  it('can emit the resource as portable C', () => {
    const source = emitArosCResource({ translator }, 'test_resource')
    expect(source).toContain('const uint8_t test_resource[]')
    expect(source).toContain('const size_t test_resource_length')
    expect(() => emitArosCResource({ translator }, 'not-a-symbol')).toThrow(/symbol/)
  })
})
