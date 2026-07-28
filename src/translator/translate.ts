import { engineFor, type EngineTraits } from './engines.js'
import { CLASS, type Rule, type TranslateResult, type TranslatorTables } from './types.js'

/**
 * English text to narrator phonemes — a port of translator.library's
 * Translate(), following the 33.2 disassembly rather than the published
 * description of the NRL rules, because the two differ in places that matter.
 *
 * Addresses in comments are hunk offsets into translator.library 33.2
 * (`11997e3c`); see research/01-translator.md.
 */

const SPACE = 0x20
const HASH = 0x23
const DEL = 0x7f
const RBRACKET = 0x5d

/** Longest word the library will buffer, from `cmpi.w #$64,D3` at 0x552. */
const MAX_WORD = 100
/** The word buffer is 27 longwords of spaces pushed at 0x13e. */
const WORD_BUF = 108
/** Returned when a word exceeds MAX_WORD (`moveq #-3,D1` at 0x590). */
const ERR_WORD_TOO_LONG = -3

/** Letters the suffix and long-U wildcards compare against by name. */
const CH = { D: 0x44, E: 0x45, G: 0x47, I: 0x49, L: 0x4c, N: 0x4e, R: 0x52, S: 0x53, Y: 0x59 } as const

/**
 * Fold one input character the way the buffer filler does (0x522-0x54c).
 *
 * The range test is `cmpi.b #$20,D1` followed by **bge** — a *signed* branch.
 * A byte of 0x80 or more is negative as a signed byte, so it fails the test
 * and becomes a space, exactly like a control character. That is why the
 * class table only ever needs its 128 real entries: no high byte reaches it.
 */
function normalise(c: number): number {
  if (c >= 0x80) return SPACE                   // signed bge at 0x526
  if (c < 0x20) return SPACE
  if (c === DEL) return SPACE
  if (c >= 0x61 && c <= 0x7a) return c - 0x20   // to upper
  if (c === RBRACKET) return SPACE              // ']' can't appear in a rule
  return c
}

export function translate(
  text: string,
  tables: TranslatorTables,
  outSize = 4096,
): TranslateResult {
  const traits: EngineTraits = engineFor(tables.version)
  const classOf = (c: number): number =>
    c >= 0 && c < tables.classes.length ? tables.classes[c] : 0

  const input: number[] = []
  for (let i = 0; i < text.length; i++) input.push(text.charCodeAt(i) & 0xff)

  let inPos = 0
  let remaining = input.length            // frame+0x82
  const out: number[] = []
  let wordStart = 0                       // frame+0x10, start of this word's output
  let stressPending = false               // frame+0x14 bit 0
  let overflowed = false

  const word = new Uint8Array(WORD_BUF).fill(SPACE)
  let pos = 0                             // A2, index into `word`
  let written = 0                         // D3

  const emit = (c: number): void => {
    if (out.length >= outSize - 1) { overflowed = true; return }
    out.push(c)
  }

  // ---------------------------------------------------------------- 0x4fc
  /**
   * Fill the buffer with the next word. Returns an error code, or 0.
   *
   * The buffer is laid out as [carried char][space][word...]: matching starts
   * at index 2, so a rule's left context can see a space at word start. The
   * filler deliberately over-reads one character past the trailing space and
   * un-reads it from the input (0x58a), carrying it into the next buffer.
   */
  const fillWord = (): number => {
    // 0x50e, and only here: the loop's back-edges all target 0x514, so the
    // remaining-input test is not repeated. Re-testing it each pass emits the
    // end sentinel in the middle of a word that consumes the last character.
    if (remaining <= 0) {
      emit(HASH)
      written = 0
      return 0
    }
    let a2 = 0
    word[a2] = word[a2 + written]
    a2++
    word[a2++] = SPACE
    let d0 = 0
    let d1 = 0
    written = 0

    for (;;) {
      d0 = d1
      d1 = input[inPos++] ?? 0
      if (d1 === 0) remaining = 1     // 0x51a: NUL forces the last pass
      d1 = normalise(d1)
      written++
      // 0x590 puts -3 in D1 and returns. The main loop branches on D3, not
      // D1, so an over-long word does not abort: the buffer simply keeps the
      // first 100 characters and matching carries on. D1 is then overwritten
      // with 0 on the normal exit path (0x1a8), so the code rarely surfaces.
      if (written > MAX_WORD) return ERR_WORD_TOO_LONG
      word[a2++] = d1

      if (d0 === SPACE) {             // 0x55a: stop one past the space...
        inPos--                       // 0x58a: ...and un-read it
        written--
        return 0
      }
      remaining--
      if (remaining === 0) {          // 0x564 -> 0x594
        word[a2++] = SPACE
        word[a2++] = SPACE
        return 0
      }
      if (d1 === HASH && d0 === HASH) {          // 0x566: '##' ends translation
        if (written === 2) {                     // 0x572
          emit(HASH)
          written = 0
          return 0
        }
        inPos--                                  // 0x580
        word[a2 - 2] = SPACE
        written--
        inPos--
        written--
        return 0
      }
    }
  }

  // ---------------------------------------------------------------- 0x59e
  /**
   * Insert a stress mark into the word just emitted.
   *
   * Only when the previous rule left a mark pending, the word is at least
   * three characters, and it contains no stress digit already — a rule that
   * supplied its own digit wins, which is why `Amiga` keeps its `IY3` rather
   * than gaining a `4` on the leading `AH`.
   */
  const stressPass = (): void => {
    // Every exit path runs 0x608, which advances the word-start marker —
    // including the not-pending branch at 0x5a4. Returning early without it
    // makes the next word's stress land on this one.
    if (!stressPending) { wordStart = out.length; return }
    if (out.length - wordStart < 3) { wordStart = out.length; return }   // 0x5b2
    for (let i = wordStart; i < out.length; i++) {                       // 0x5bc
      if (classOf(out[i]) & CLASS.DIGIT) { wordStart = out.length; return }
    }
    for (let i = wordStart; i + 1 < out.length; i++) {                   // 0x5da
      const pair = String.fromCharCode(out[i], out[i + 1])
      if (tables.vowels.includes(pair)) {
        out.splice(i + 2, 0, 0x34)                                       // '4'
        break
      }
    }
    wordStart = out.length
  }

  // ---------------------------------------------------------------- 0x3be
  /**
   * Read the next character of the word buffer and advance.
   * `dir` +1 walks left (predecrement), -1 walks right (postincrement).
   */
  const step = (dir: number): number => (dir < 0 ? word[pos++] : word[--pos]) ?? SPACE
  /** The same, when only the character's class matters. */
  const stepClass = (dir: number): number => classOf(step(dir))

  // ---------------------------------------------------------------- 0x398
  /**
   * Apply one wildcard. Returns true on match.
   *
   * The handlers are in jump-table order (hunk 0x60e). Two asymmetries are
   * deliberate and reproduced: `*` does not step back after over-consuming,
   * while `:` and `_` do; and `%` never checks that its `?NG` branch actually
   * begins with an I, so any letter followed by NG at a word end counts as
   * the suffix.
   */
  const wildcard = (wc: string, dir: number): boolean => {
    switch (wc) {
      case '#': return (stepClass(dir) & CLASS.VOWEL) !== 0
      case '*': {
        if (!(stepClass(dir) & CLASS.CONSONANT)) return false
        while (stepClass(dir) & CLASS.CONSONANT) { /* consume; no step back */ }
        return true
      }
      case '.': {
        const c = stepClass(dir)
        return (c & CLASS.VOICED) !== 0 && (c & CLASS.CONSONANT) !== 0
      }
      case '$': {
        if (!(stepClass(dir) & CLASS.CONSONANT)) return false
        const c = step(dir)
        return c === CH.I || c === CH.E
      }
      case '%': {                                          // 0x422
        // A suffix only counts when it ends the word. `-ES`/`-ED`/`-ELY`
        // check that directly (0x47a); `-ER` and `-ING` allow a trailing S
        // first (0x46a), and ING falls through into the very same code.
        const endsWord = (): boolean => (stepClass(dir) & CLASS.LETTER) === 0   // 0x47a
        // 0x46a — the trailing-S branch exists only from 31.7 on; engines.ts.
        const afterRorIng = (): boolean => {
          if (!traits.suffixAllowsTrailingS) return endsWord()
          const c = step(dir)
          if (!(classOf(c) & CLASS.LETTER)) return true
          if (c !== CH.S) return false
          return endsWord()
        }
        if (step(dir) === CH.E) {
          const c = step(dir)
          if (!(classOf(c) & CLASS.LETTER)) return true    // bare E at word end
          if (c === CH.S || c === CH.D) return endsWord()
          if (c === CH.R) return afterRorIng()
          if (c === CH.L) return step(dir) === CH.Y ? endsWord() : false
          return false
        }
        // 0x456: the leading letter is never checked, so anything followed by
        // NG at a word end counts as -ING. Reproduced deliberately.
        if (step(dir) !== CH.N) return false
        if (step(dir) !== CH.G) return false
        return afterRorIng()
      }
      case '&': return (stepClass(dir) & CLASS.SIBILANT) !== 0
      case '@': return (stepClass(dir) & CLASS.AFFECTS_U) !== 0
      case '^': return (stepClass(dir) & CLASS.CONSONANT) !== 0
      case '+': return (stepClass(dir) & CLASS.FRONT_VOWEL) !== 0
      case ':': {
        while (stepClass(dir) & CLASS.CONSONANT) { /* consume */ }
        pos += dir                                          // 0x4c2 step back
        return true
      }
      case '?': return (stepClass(dir) & CLASS.DIGIT) !== 0
      case '_': {
        while (stepClass(dir) & CLASS.DIGIT) { /* consume */ }
        pos += dir                                          // 0x4de step back
        return true
      }
      default: {                                            // ' ' — 0x4e6
        return (stepClass(dir) & CLASS.LETTER) === 0
      }
    }
  }

  /** Match a context pattern. Left runs right-to-left from `pos`. */
  const matchContext = (pattern: string, dir: number): boolean => {
    const order = dir > 0
      ? [...pattern].reverse()      // left context is scanned backwards
      : [...pattern]
    for (const ch of order) {
      if (classOf(ch.charCodeAt(0)) & CLASS.WILDCARD) {
        if (!wildcard(ch, dir)) return false
      } else {
        if (dir > 0) { if (word[--pos] !== ch.charCodeAt(0)) return false }
        else { if (word[pos++] !== ch.charCodeAt(0)) return false }
      }
    }
    return true
  }

  // ---------------------------------------------------------------- 0x23a
  /** Bucket 0-25 for A-Z, 26 for digits, 27 for anything else. */
  const bucketFor = (c: number): number => {
    const cl = classOf(c)
    let k = c
    if (!(cl & CLASS.LETTER)) k = cl & CLASS.DIGIT ? 0x5b : 0x5c
    return k - 0x41
  }

  const tryRules = (): boolean => {
    const bucket = tables.buckets[bucketFor(word[pos])]
    if (!bucket) return false
    for (const [left, match, right, outStr, term] of bucket) {
      const save = pos
      let ok = true
      for (let i = 0; i < match.length; i++) {          // 0x266, literal
        if (word[pos + i] !== match.charCodeAt(i)) { ok = false; break }
      }
      if (!ok) continue
      pos = save
      if (!matchContext(left, +1)) { pos = save; continue }
      pos = save + match.length
      if (!matchContext(right, -1)) { pos = save; continue }

      pos = save + match.length
      for (let i = 0; i < outStr.length; i++) emit(outStr.charCodeAt(i))

      // 0x334: a rule whose output ends in a letter leaves a stress mark
      // pending, unless the rule was stored with a backtick terminator.
      const last = out.length ? out[out.length - 1] : 0
      if (classOf(last) & CLASS.LETTER) stressPending = term !== '`'
      return true
    }
    return false
  }

  // ---------------------------------------------------------------- 0x17a
  let rc = 0
  for (;;) {
    if (out.length && out[out.length - 1] === HASH) break        // 0x17a
    if (pos === 0 || word[pos - 1] === SPACE) {                  // 0x184
      const err = fillWord()
      stressPass()
      if (written < 0) { rc = err; break }    // 0x19a tests D3, and returns D1
      if (written === 0) break                // 0x19c
      pos = 2
    }
    if (!tryRules()) pos++      // no rule matched: don't spin on this character
    if (overflowed) { rc = -(input.length - inPos); break }
  }

  stressPass()                                                   // 0x1aa
  if (out.length && out[out.length - 1] === HASH) out.pop()      // 0x1ae

  return { phonemes: String.fromCharCode(...out), rc }
}

/** Convenience wrapper around a fixed table set. */
export function createTranslator(tables: TranslatorTables) {
  return {
    version: tables.version,
    translate: (text: string, outSize?: number): TranslateResult =>
      translate(text, tables, outSize),
  }
}

export type { Rule, TranslatorTables, TranslateResult }
export type { EngineTraits }
