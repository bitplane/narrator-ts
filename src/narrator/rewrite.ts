/**
 * narrator.device's allophonic rewrite engine — hunk+0x12d8 of build 33.2.
 *
 * One table-driven pass over the phoneme array, run twice by the driver with
 * different rules. The first pass is allophony proper: `T` between vowels
 * becomes the flap `DX`, `D` before `R` becomes `J`, `UL` becomes `AX L`. The
 * second expands phonemes into the several frames they are really made of —
 * diphthongs gain their second half, and `P`/`T`/`K` gain a release whose
 * identity depends on whether an `S` precedes, which is the difference
 * between "pin" and "spin".
 *
 * Both tables come out of the binary with `tools/extract-rewrite-rules.py`.
 * See research/02-narrator.md.
 */

import { MAX_PHONEMES, TERMINATOR } from './parse.js'

/** One rule, as `extract-rewrite-rules.py` reads it. */
export interface Rule {
  /** Phoneme to match, `0xff` for any. */
  match: number
  /** Left neighbour, `0xff` for any. */
  left: number
  /** Right neighbour, `0xff` for any. */
  right: number
  /** Byte 3's high nibble — see `RULE`. The low nibble was the rule's length
   *  and is consumed by the extractor. */
  flags: number
  /** Replacement, `0xff` to leave the phoneme alone. */
  replace: number
  insertBefore: number
  insertAfter: number
  /** Attribute tests, in three groups: this phoneme, then left, then right. */
  tests: number[]
}

export const RULE = {
  /** Bit 5: after applying, keep scanning rules at this same position. */
  RESCAN: 1 << 1,
  /** Bit 6: if the right neighbour is a space, test the one beyond it. */
  SKIP_RIGHT: 1 << 2,
  /** Bit 7: likewise leftwards. */
  SKIP_LEFT: 1 << 3,
} as const

/** A test byte, from `+7` onwards. */
const TEST = {
  /** Bits 0-4: which bit of the subject to test. */
  BIT: 0x1f,
  /** Bit 5: invert the subject first. */
  INVERT: 0x20,
  /** Bit 6: the subject is the attribute longword, not the stress byte. */
  ATTRS: 0x40,
  /** Bit 7: this is the last test in its group. */
  LAST: 0x80,
} as const

export interface RewriteState {
  phonemes: Uint8Array
  stress: Uint8Array
  flags: Uint8Array
  /** The device's `A5+0x9a`. Insertions grow it. */
  count: number
}

/** Attribute longwords indexed by phoneme — the table at hunk+0x2f08. */
export type Attrs = readonly number[]

/**
 * Run one rewrite pass, in place. False if an insertion would overflow the
 * 0x200-entry arrays, which the device reports as an error rather than
 * truncating.
 */
export function rewrite(state: RewriteState, rules: readonly Rule[], attrs: Attrs): boolean {
  const { phonemes, stress, flags } = state

  /**
   * 0x13e4: one group of attribute tests, starting at `from`. Returns the
   * index just past the group, or -1 if it failed.
   *
   * A test *passes* when its bit is clear — which reads backwards until you
   * notice the caller branches on `bne`.
   */
  const group = (rule: Rule, from: number, phoneme: number, stressByte: number): number => {
    let t = from
    for (;;) {
      const test = rule.tests[t]
      // A group with no bytes left passes: the rule simply has fewer tests
      // than the three groups could use.
      if (test === undefined) return t
      let subject = test & TEST.ATTRS ? (attrs[phoneme] ?? 0) : stressByte
      if (test & TEST.INVERT) subject = ~subject
      if ((subject >>> (test & TEST.BIT)) & 1) return -1
      t++
      if (test & TEST.LAST) return t
    }
  }

  /** 0x1308-0x139c: does this rule apply at `at`? */
  const matches = (rule: Rule, at: number): boolean => {
    // 0x1308: byte 0, with 0xff as a wildcard rather than a terminator.
    if (rule.match !== TERMINATOR && rule.match !== phonemes[at]) return false
    // 0x1324: byte 1, the left neighbour.
    if (rule.left !== TERMINATOR && rule.left !== phonemes[at - 1]) return false
    // 0x1334: byte 2. A rule that wants a specific right neighbour never
    // matches at the end of the array (0x133e).
    if (rule.right !== TERMINATOR) {
      if (phonemes[at + 1] === TERMINATOR) return false
      if (rule.right !== phonemes[at + 1]) return false
    }

    // Three groups of tests, consuming `tests` in order.
    let t = group(rule, 0, phonemes[at], stress[at])
    if (t < 0) return false

    // 0x1356: the left neighbour, skipping a space if the rule says to.
    let li = at - 1
    if (phonemes[li] === 0 && rule.flags & RULE.SKIP_LEFT) li = at - 2
    t = group(rule, t, phonemes[li], stress[li])
    if (t < 0) return false

    // 0x1376: the right neighbour likewise, and 0x1390 treats the array's
    // terminator as a space rather than looking it up. Its *stress* byte is
    // passed through untouched, terminator and all.
    let ri = at + 1
    if (phonemes[ri] === 0 && rule.flags & RULE.SKIP_RIGHT) ri = at + 2
    const rp = phonemes[ri] === TERMINATOR ? 0 : phonemes[ri]
    return group(rule, t, rp, stress[ri]) >= 0
  }

  // 0x12f8: the scan starts at 1, so rules can see and rewrite the seeded QX.
  let i = 1

  /**
   * 0x1412: shift the three arrays right and drop `p` in.
   *
   * It inserts at `i + 1`, not at `i`, and leaves `i` pointing at what it
   * inserted. That is why "insert before" is written as decrement, insert,
   * increment — the caller moves the cursor rather than the routine taking a
   * position.
   */
  const insert = (p: number): boolean => {
    const n = state.count
    if (n >= MAX_PHONEMES) return false
    state.count = n + 1
    for (let k = n; k > i + 1; k--) {
      phonemes[k] = phonemes[k - 1]
      stress[k] = stress[k - 1]
      flags[k] = flags[k - 1]
    }
    i++
    phonemes[i] = p
    stress[i] = 0
    flags[i] = 0
    return true
  }

  for (; i <= MAX_PHONEMES; i++) {
    if (phonemes[i] === TERMINATOR) return true        // 0x12fe

    // 0x12f6: every position restarts at the first rule.
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]
      if (!matches(rule, i)) continue

      // 0x13a0: replacement, then the two insertions.
      if (rule.replace !== TERMINATOR) phonemes[i] = rule.replace
      if (rule.insertBefore !== TERMINATOR) {
        i--
        if (!insert(rule.insertBefore)) return false
        i++
      }
      if (rule.insertAfter !== TERMINATOR && !insert(rule.insertAfter)) return false

      // 0x13d6: with the rescan bit set the scan carries on through the
      // remaining rules at this position; without it the position is done.
      if (!(rule.flags & RULE.RESCAN)) break
    }
  }
  return true
}
