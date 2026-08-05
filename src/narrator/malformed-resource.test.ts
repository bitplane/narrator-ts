import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { decodeArosResource, encodeArosResource } from '../aros-resource/index.js'
import { SpeakError, synthesizeSentence } from './speak.js'
import { voiceFrom, type VoiceData } from './voice.js'

const voice = JSON.parse(readFileSync('reference/voice-free.json', 'utf8')) as VoiceData
const metadata = {
  generator: 'narrator-ts test',
  voiceLicense: 'Public domain',
}

function chunkPayload(bytes: Uint8Array, wanted: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 12; at < bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4))
    if (id === wanted) return at + 8
    const size = view.getUint32(at + 4)
    at += 8 + size + (size & 1)
  }
  throw new Error(`missing ${wanted}`)
}

describe('malformed AROS voice resources', () => {
  it('either synthesizes or rejects every single-byte VATR mutation', () => {
    const encoded = encodeArosResource({ voice, metadata })
    const attrs = chunkPayload(encoded, 'VATR')
    const probes = ['/HEH4LOW WER4LD ', 'Q Q OWOYIN( L ',
      'DHAH KWIHK BROWN FAAKS JAHMPT OWVER DHAH LEYZIY DAOG.']

    for (let offset = 0; offset < voice.names.length * 4; offset++) {
      for (const value of [0x00, 0xff]) {
        if (encoded[attrs + offset] === value) continue
        const mutated = encoded.slice()
        mutated[attrs + offset] = value
        const decoded = decodeArosResource(mutated).voice!
        const candidate = voiceFrom({
          ...decoded,
          version: voice.version,
          source: voice.source,
        })
        for (const probe of probes) {
          try {
            synthesizeSentence(new TextEncoder().encode(probe), candidate)
          } catch (error) {
            expect(error).toBeInstanceOf(SpeakError)
          }
        }
      }
    }
  }, 30_000)
})
