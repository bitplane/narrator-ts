/**
 * A rule from the letter-to-sound table: `left[match]right=out<term>`.
 *
 * `term` is the raw terminator byte the rule was stored with, `\` or a
 * backtick. It is not decoration — see CLASS.LETTER and the stress pass in
 * translate.ts.
 */
export interface Rule {
  left: string
  match: string
  right: string
  out: string
  term: string
}

/** Everything the matcher needs, extracted from one translator.library build. */
export interface TranslatorTables {
  version: string
  source: string
  /** 128 entries, one per character code, of CLASS bit flags. */
  classes: number[]
  /** The pattern metacharacters, in dispatch order. */
  wildcards: string
  /** The fifteen two-character vowel phonemes the stress pass looks for. */
  vowels: string[]
  /**
   * 28 buckets: 0-25 for A-Z, 26 for digits, 27 for everything else.
   * Order within a bucket decides which rule wins, so it is load-bearing.
   */
  buckets: Array<Array<[string, string, string, string, string]>>
}

/**
 * Character class bits, read from the table at hunk 0x642.
 *
 * Bits 9 and 12-15 are never set in any shipped build. The names come from
 * which wildcard handler tests each bit (jump table at hunk 0x60e), not from
 * guesswork about what the letters have in common.
 */
export const CLASS = {
  /** Not alphanumeric. */
  PUNCT: 1 << 0,
  /** `0`-`9`; tested by `?` and `_`, and by the stress pass. */
  DIGIT: 1 << 1,
  /** `@` — a consonant that changes a following long U: D J L N R S T Z. */
  AFFECTS_U: 1 << 2,
  /** `.` — voiced consonant: B D G J L M N R V W Z. */
  VOICED: 1 << 3,
  /** `&` — sibilant: C G J S X Z. */
  SIBILANT: 1 << 4,
  /** `^`, `*` and `:` — a consonant. */
  CONSONANT: 1 << 5,
  /** `#` — a vowel: A E I O U Y. */
  VOWEL: 1 << 6,
  /** Any letter. Gates whether a rule's output can take a stress mark. */
  LETTER: 1 << 7,
  /** `+` — a front vowel: E I Y. */
  FRONT_VOWEL: 1 << 8,
  /** The character is itself a pattern metacharacter. */
  WILDCARD: 1 << 10,
  /** A word or sentence delimiter. */
  DELIMITER: 1 << 11,
} as const

export interface TranslateResult {
  /** The phoneme string, as narrator.device expects it. */
  phonemes: string
  /**
   * 0 on success, or minus the number of input characters not consumed when
   * the output buffer ran out — the library's own convention.
   */
  rc: number
}
