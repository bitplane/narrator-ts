import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { translate } from './translate.js'
import type { TranslatorTables } from './types.js'

/**
 * Every assertion here compares against output captured from the real
 * translator.library running under the 68k oracle. Nothing is asserted from
 * the implementation's own behaviour, so the tests cannot drift with it.
 *
 * Both the tables and the goldens are build products (see README). When they
 * are absent the suite says so rather than passing vacuously.
 */
const DATA = 'data'
const GOLDEN = 'fixtures/golden'

function versions(): string[] {
  if (!existsSync(DATA)) return []
  return readdirSync(DATA)
    .map((f) => /^translator-(.+)\.json$/.exec(f)?.[1])
    .filter((v): v is string => Boolean(v))
    .sort()
}

function goldenFor(prefix: string, version: string): string | undefined {
  if (!existsSync(GOLDEN)) return undefined
  return readdirSync(GOLDEN).find((f) => f.startsWith(`${prefix}-${version}-`))
}

interface Case { in: string; out: string; rc: number }

function casesFrom(file: string): Case[] {
  return readFileSync(`${GOLDEN}/${file}`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Case)
}

const found = versions()

describe('translator tables', () => {
  it('has generated tables to test against', () => {
    expect(
      found.length,
      'no data/translator-*.json — run: python3 tools/gen-tables.py fixtures/amiga/translator_library-*.bin -o data',
    ).toBeGreaterThan(0)
  })
})

describe.each(found)('translator %s', (version) => {
  const tables = JSON.parse(readFileSync(`${DATA}/translator-${version}.json`, 'utf8')) as TranslatorTables
  const suites: Array<[string, string | undefined]> = [
    // The main corpus derives probes from the rule tables, so on its own it
    // partly measures the extractor. The holdout shares no input with it and
    // was chosen without reference to the tables.
    ['training', goldenFor('translator', version)],
    ['holdout', goldenFor('holdout', version)],
  ]

  it('table looks structurally sane', () => {
    expect(tables.classes).toHaveLength(128)
    expect(tables.vowels).toHaveLength(15)
    expect(tables.buckets).toHaveLength(28)
    expect(tables.buckets.flat().length).toBeGreaterThan(600)
  })

  for (const [label, file] of suites) {
    if (!file) {
      it.skip(`matches the real library on the ${label} corpus (not generated)`, () => {})
      continue
    }
    const cases = casesFrom(file)
    it(`matches the real library on ${cases.length} ${label} phrases`, () => {
      const bad: Array<{ in: string; want: string; got: string }> = []
      for (const c of cases) {
        const got = translate(c.in, tables).phonemes
        if (got !== c.out) bad.push({ in: c.in, want: c.out, got })
      }
      const rate = ((cases.length - bad.length) / cases.length) * 100
      const sample = bad
        .slice(0, 15)
        .map((b) => `  ${JSON.stringify(b.in)}\n    want ${JSON.stringify(b.want)}\n    got  ${JSON.stringify(b.got)}`)
        .join('\n')
      expect(
        bad.length,
        `${bad.length}/${cases.length} mismatches (${rate.toFixed(2)}% exact)\n${sample}`,
      ).toBe(0)
    })
  }

  it('reports the return code the library reports', () => {
    const file = goldenFor('holdout', version)
    if (!file) return
    const bad = casesFrom(file).filter((c) => translate(c.in, tables).rc !== c.rc)
    expect(bad.slice(0, 5).map((b) => b.in), `${bad.length} rc mismatches`).toEqual([])
  })
})
