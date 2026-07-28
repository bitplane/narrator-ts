/**
 * Measure how far the free NRL-only table's output is from the Amiga's.
 *
 * `research/03-nrl-provenance.md` establishes that 318 of NRL's 329 rules
 * survive into `translator.library`, and that SoftVoice's additions are 383
 * rules plus a stress pass. This answers the question that leaves open: what
 * a consumer of the free table actually gets.
 *
 * Two numbers are reported, because they measure different things:
 *
 *   exact       identical strings. Bounded above by the unstressed figure,
 *               since NRL has no stress marks and 282 Amiga rules carry one.
 *   unstressed  the same after deleting stress digits from the Amiga output.
 *               This is the interesting one: it isolates disagreements about
 *               *phonemes* from the absence of a pass NRL never had.
 *
 * Both are reported per phrase and per distinct word. The word figure is the
 * honest one for judging the table - the matcher buffers a word at a time
 * (0x4fc), so words are independent, and a phrase score just compounds them.
 * The phrase corpora also contain deliberately degenerate probes (200 letter
 * `x`s) which say nothing about English.
 *
 * The Amiga table is a build product (see README) so this is a tool, not a
 * test - it cannot run from a clean checkout.
 *
 *   npx vite-node tools/nrl-divergence.ts [--examples 25]
 */
import { readFileSync, existsSync } from 'node:fs'

import { translate } from '../src/translator/translate.js'
import type { TranslatorTables } from '../src/translator/types.js'

const AMIGA = 'data/translator-33.2.json'
const CORPORA = [
  ['training', 'fixtures/corpus/phrases.txt'],
  ['held-out', 'fixtures/corpus/holdout.txt'],
] as const

const argv = process.argv
const examples = Number(argv[argv.indexOf('--examples') + 1]) || 25
/** `--nrl` points at another build of the table, e.g. `--verbatim` output. */
const NRL = argv.includes('--nrl')
  ? argv[argv.indexOf('--nrl') + 1]!
  : 'reference/nrl-table.json'

const load = (p: string): TranslatorTables =>
  JSON.parse(readFileSync(p, 'utf8')) as TranslatorTables
const rules = (t: TranslatorTables): number =>
  t.buckets.reduce((n, b) => n + b.length, 0)
/** Delete stress digits. `EH4` and `EH` are the same phoneme to the device. */
const unstress = (s: string): string => s.replace(/[1-9]/g, '')
const pct = (k: number, n: number): string => `${((k / n) * 100).toFixed(1)}%`

if (!existsSync(AMIGA)) {
  console.error(`${AMIGA} is missing - run tools/gen-tables.py first.`)
  process.exit(1)
}
const amiga = load(AMIGA)
const nrl = load(NRL)

console.log(`${nrl.source}: ${rules(nrl)} rules, no stress pass`)
console.log(`translator.library ${amiga.version}: ${rules(amiga)} rules\n`)

const say = (t: TranslatorTables, s: string): string => translate(s, t).phonemes

// ------------------------------------------------------------------ phrases
console.log('per phrase')
for (const [label, path] of CORPORA) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  let exact = 0
  let unstressed = 0
  for (const line of lines) {
    const a = say(amiga, line)
    const n = say(nrl, line)
    if (a === n) exact++
    if (unstress(a) === n) unstressed++
  }
  console.log(`  ${label.padEnd(9)} ${String(lines.length).padStart(5)} phrases`
    + `   exact ${pct(exact, lines.length).padStart(6)}`
    + `   ignoring stress ${pct(unstressed, lines.length).padStart(6)}`)
}

// -------------------------------------------------------------------- words
/** Every distinct word in either corpus, in the form the library would see. */
const words = new Set<string>()
for (const [, path] of CORPORA) {
  for (const w of readFileSync(path, 'utf8').split(/\s+/)) {
    // The buffer holds 100 characters; longer "words" are the degenerate
    // probes and measure the truncation path, not the rules.
    if (w && w.length <= 100) words.add(w.toUpperCase())
  }
}

interface Diff { word: string; amiga: string; nrl: string }
const diffs: Diff[] = []
let wordExact = 0
let wordUnstressed = 0
for (const w of words) {
  const a = say(amiga, w)
  const n = say(nrl, w)
  if (a === n) wordExact++
  if (unstress(a) === n) wordUnstressed++
  else diffs.push({ word: w, amiga: unstress(a), nrl: n })
}

console.log(`\nper distinct word (${words.size} words)`)
console.log(`  exact           ${pct(wordExact, words.size).padStart(6)}`)
console.log(`  ignoring stress ${pct(wordUnstressed, words.size).padStart(6)}`)

// ------------------------------------------------------- recurring patterns
/**
 * Reduce a divergence to the substring that actually differs, so the same
 * cause seen in many words collapses to one line. `AHV`/`AXV` and
 * `PAARTIY`/`PAARTIH` are two causes, not two hundred.
 */
function core(a: string, n: string): string {
  let i = 0
  while (i < a.length && i < n.length && a[i] === n[i]) i++
  let j = 0
  while (j < a.length - i && j < n.length - i
    && a[a.length - 1 - j] === n[n.length - 1 - j]) j++
  return `${a.slice(i, a.length - j) || '-'} / ${n.slice(i, n.length - j) || '-'}`
}

const byCause = new Map<string, Diff[]>()
for (const d of diffs) {
  const k = core(d.amiga, d.nrl)
  const bucket = byCause.get(k)
  if (bucket) bucket.push(d)
  else byCause.set(k, [d])
}

console.log(`\ntop ${examples} recurring differences (amiga unstressed / nrl-only)`)
const ranked = [...byCause.entries()].sort((x, y) => y[1].length - x[1].length)
for (const [cause, group] of ranked.slice(0, examples)) {
  const eg = group.slice(0, 3).map((d) => d.word.toLowerCase()).join(', ')
  console.log(`  ${String(group.length).padStart(5)}  ${cause.padEnd(24)}  ${eg}`)
}
console.log(`  ${ranked.length} distinct causes over ${diffs.length} differing words`)
