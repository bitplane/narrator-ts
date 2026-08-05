import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { engineFor } from './engines.js'
import { translate } from './translate.js'
import { CLASS, type TranslatorTables } from './types.js'

/**
 * The free letter-to-sound table, built from NRL Report 7948 and curated
 * pronunciation rules.
 *
 * Unlike translate.test.ts these tests need no build products: both the table
 * and the report it comes from are checked in, because the report is a work of
 * the US Government and not subject to copyright there.
 *
 * Nothing here asserts agreement with the Amiga - the table deliberately
 * differs, and `tools/nrl-divergence.ts` measures by how much. What is
 * asserted is that the table is faithful to the report, and that it cannot
 * break the matcher.
 */
const table = JSON.parse(
  readFileSync('reference/nrl-table.json', 'utf8'),
) as TranslatorTables

const NRL = JSON.parse(readFileSync('reference/nrl-7948.json', 'utf8')) as {
  classes: Record<string, string>
  rules: Record<string, string[]>
}

const pronunciations = JSON.parse(
  readFileSync('reference/free-pronunciations.json', 'utf8'),
) as {
  words: Record<string, string>
  prefixes: Record<string, string>
  rules: Array<[string, string, string, string, string]>
}

const curatedCount = Object.keys(pronunciations.words).length +
  Object.keys(pronunciations.prefixes).length + pronunciations.rules.length

const all = table.buckets.flat()

describe('the NRL table', () => {
  it('has one bucket per letter, plus digits and punctuation', () => {
    expect(table.buckets).toHaveLength(28)
  })

  it('keeps every rule of the report bar the one the matcher cannot hold', () => {
    // `[ ]'=/ /` is the blank *before* an apostrophe: an artefact of NRL's
    // punctuation-blanking pass with nothing left to match once that pass is
    // gone. See tools/gen-nrl-table.py.
    const published = Object.values(NRL.rules).reduce((n, r) => n + r.length, 0)
    expect(published).toBe(329)
    expect(all).toHaveLength(published - 1 + curatedCount)
  })

  it('prepends the curated pronunciation rules', () => {
    for (const [word, output] of Object.entries(pronunciations.words)) {
      const bucket = table.buckets[word.charCodeAt(0) - 65]!
      expect(bucket).toContainEqual([' ', word, ' ', output, '`'])
    }
    for (const [prefix, output] of Object.entries(pronunciations.prefixes)) {
      const bucket = table.buckets[prefix.charCodeAt(0) - 65]!
      expect(bucket).toContainEqual([' ', prefix, '', output, '`'])
    }
    for (const rule of pronunciations.rules) {
      const bucket = table.buckets[rule[1].charCodeAt(0) - 65]!
      expect(bucket).toContainEqual(rule)
    }
  })

  it('carries no stress marks, because NRL has no notion of stress', () => {
    const curated = new Set([
      ...Object.keys(pronunciations.words),
      ...Object.keys(pronunciations.prefixes),
      ...pronunciations.rules.map((rule) => rule[1]),
    ])
    for (const [, match, , out] of all) {
      if (!curated.has(match)) expect(out).not.toMatch(/[1-9]/)
    }
    // Belt and braces: every rule also carries the terminator that tells the
    // matcher its output is ineligible for one.
    for (const [, , , , term] of all) expect(term).toBe('`')
    expect(table.vowels).toEqual([])
  })

  it('is matched by the pre-31.7 engine', () => {
    // The report's SUFFIX is ER/E/ES/ED/ING/ELY and must end the word; the
    // trailing-S allowance is SoftVoice's.
    expect(engineFor(table.version).suffixAllowsTrailingS).toBe(false)
  })
})

describe('its character classes', () => {
  const bits: Array<[string, number]> = [
    ['VOWEL', CLASS.VOWEL],
    ['CONSONANT', CLASS.CONSONANT],
    ['VOICED', CLASS.VOICED],
    ['FRONT', CLASS.FRONT_VOWEL],
    ['SIBILANT', CLASS.SIBILANT],
    ['NONPAL', CLASS.AFFECTS_U],
  ]

  it.each(bits)('match the report: %s', (name, bit) => {
    const members = [...Array(128).keys()]
      .filter((c) => table.classes[c] & bit)
      .map((c) => String.fromCharCode(c))
      .sort()
      .join('')
    expect(members).toBe([...NRL.classes[name]!].sort().join(''))
  })

  it('mark NRL\'s ten metacharacters and no others', () => {
    const wild = [...Array(128).keys()]
      .filter((c) => table.classes[c] & CLASS.WILDCARD)
      .map((c) => String.fromCharCode(c))
    // The space is the matcher's "not a letter" handler (0x4e6), so it must
    // dispatch as a wildcard. `?` and `_` are SoftVoice's and must not.
    expect(wild.sort().join('')).toBe(' #$%&*+.:@^')
    expect(table.classes['?'.charCodeAt(0)] & CLASS.WILDCARD).toBe(0)
    expect(table.classes['_'.charCodeAt(0)] & CLASS.WILDCARD).toBe(0)
  })
})

describe('its rules cannot break the matcher', () => {
  it('never leave the match literal empty', () => {
    // An empty literal succeeds without consuming a character, and the main
    // loop only advances `pos` when no rule fires — so one would spin.
    for (const [, match] of all) expect(match).not.toBe('')
  })

  it('never put `^` immediately left of `:` in a left context', () => {
    // A left context is applied outwards from the match, and `:` steps back
    // exactly one after over-consuming (0x4c2), so the character `^` then
    // tests is the one that ended `:`'s run — never a consonant. The report
    // writes ten rules this way; SNOBOL backtracks, this matcher does not.
    for (const [left] of all) expect(left).not.toContain('^:')
  })

  it('give every letter an unconditional last resort', () => {
    for (let b = 0; b < 26; b++) {
      const [left, match, right] = table.buckets[b]!.at(-1)!
      expect([left, match, right]).toEqual(['', String.fromCharCode(65 + b), ''])
    }
  })

  it('terminate on input no rule matches', () => {
    // NRL has no rule for `~`, so the matcher skips each one and only the
    // word-boundary blank survives. The assertion that matters is that this
    // returns at all.
    expect(translate('~~~', table).phonemes).toBe(' ')
  })
})

describe('its output', () => {
  // Traceable to a single published rule each, so these check the pipeline
  // from the report's notation to the device's, not the matcher.
  it.each([
    ['7', 'SEHVUN ', '[7]=/S EH V AX N/, with AX+N folded to the syllabic UN'],
    ['4', 'FOWR ', '[4]=/F OW R/, tokens run together'],
    ['who', '/HUW ', '[WHO]=/HH UW/, HH spelled /H'],
    ['age', 'EYJ ', '#:[AG]E=/IH JH/ then [E], JH spelled J'],
  ])('%s -> %s', (input, expected) => {
    expect(translate(input, table).phonemes).toBe(expected)
  })

  it('emits a literal space for a space, not silence', () => {
    // `[ ]=/< >/` — the angle brackets mean "emit this character", and are
    // the only way a rule can produce a blank. A body of `/ /`, by contrast,
    // is genuinely silent.
    //
    // The lone `b` also shows what the free table does not have: the Amiga
    // says `BIY4` here, from a letter-name rule SoftVoice added. NRL falls
    // through to its catch-all `[B]=/B/`.
    expect(translate('a b', table).phonemes).toBe('AX B ')
  })
})
