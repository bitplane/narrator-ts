/**
 * narrator.device's phoneme parser — the front of the front half.
 *
 * Ported from hunk+0xf68 of build 33.2. It turns the input string into three
 * parallel byte arrays, and every later stage works from those rather than
 * from the text, so getting this exactly right is a precondition for getting
 * durations or frames right. See research/02-narrator.md.
 *
 * The arrays start at index 4, not 0. Slots 0-3 are a lead-in the later
 * stages look backwards into, with slot 2 seeded to QX; a port that starts at
 * zero will produce plausible phonemes and wrong everything else.
 */

/** The device's own phoneme table, as `tools/extract-phonemes.py` reads it. */
export interface PhonemeTable {
  /** 112 two-character names, `''` for a continuation slot. */
  names: string[]
  /** 102 attribute longwords, indexed by phoneme. The digits have none. */
  attrs: number[]
}

/** Attribute bits this stage tests. Others are used further down. */
export const ATTR = {
  /** Bit 0 (0x100a): a stress digit may follow this phoneme. */
  STRESSABLE: 1 << 0,
  /** Bit 25 (0x10de): this phoneme already ends an utterance. */
  TERMINAL: 1 << 25,
  /** Bit 26 (0x103a): a pause — space, `.`, `?`, `,` or `-`. */
  PAUSE: 1 << 26,
  /** Bit 27 (0x1032): rejected wherever it appears. */
  ILLEGAL: 1 << 27,
} as const

/** Phoneme indices the parser names directly. */
const P = { SPACE: 0, PERIOD: 1, QUERY: 2, DASH: 4, OPEN: 5, CLOSE: 6, QX: 0x15 } as const

/** Where the real phonemes start; 0-3 are the lead-in. */
export const LEAD_IN = 4
/** The arrays are 0x200 bytes, which is also the phoneme limit. */
export const MAX_PHONEMES = 0x200
/** Written into all three arrays after the last phoneme. */
export const TERMINATOR = 0xff

export interface Parsed {
  /** Phoneme indices, lead-in included, `0xff`-terminated. */
  phonemes: Uint8Array
  /** The stress digit as ASCII, or 0. Parallel to `phonemes`. */
  stress: Uint8Array
  /** Bit 5 for `(`, bit 4 for `)`. Parallel to `phonemes`. */
  flags: Uint8Array
  /** Total length written, terminator included — the device's D3. */
  count: number
  /**
   * Set when the device rejects the input: the 1-based offset of the
   * offending character, which is what it reports back in `io_Actual`.
   */
  error?: number
}

/**
 * Parse a phoneme string the way the device does.
 *
 * `input` is bytes rather than a string because the device works in Latin-1
 * and scans two characters at a time, including the byte past the end.
 */
export function parse(input: Uint8Array, table: PhonemeTable, length = input.length): Parsed {
  const phonemes = new Uint8Array(MAX_PHONEMES + 2)
  const stress = new Uint8Array(MAX_PHONEMES + 2)
  const flags = new Uint8Array(MAX_PHONEMES + 2)

  // 0x100a and friends index the attribute table by phoneme. The digits sit
  // past its end and are peeled off as stress before any lookup, so anything
  // out of range here would be a bug rather than a value.
  const attrOf = (p: number): number => table.attrs[p] ?? 0

  // 0xf8a-0xf96: the lead-in. Only slot 2 is non-zero.
  phonemes[2] = P.QX

  // 0xf68: an empty request produces nothing at all, not an empty utterance.
  if (length <= 0) return { phonemes, stress, flags, count: 0 }

  let at = 0          // A0, the read position
  let n = LEAD_IN     // D3, the write position
  stress[n] = 0       // 0xfa8, the loop's entry clear
  flags[n] = 0

  const byte = (i: number): number => (i < input.length ? input[i] : 0)

  for (;;) {
    const c0 = byte(at)
    // 0xfb2/0xfba: NUL or '#' ends the input regardless of io_Length.
    if (c0 === 0 || c0 === 0x23) break

    // 0xfbe-0xfe2: match two characters, then fall back to one. The table is
    // words, so a one-character name is that character followed by NUL — and
    // the retry masks the low byte off rather than re-reading.
    let word = (c0 << 8) | byte(at + 1)
    let taken = 2
    let idx = table.names.findIndex((_, i) => wordAt(table, i) === word)
    if (idx < 0) {
      if (taken === 1) return fail(at)
      word &= 0xff00
      taken = 1
      idx = table.names.findIndex((_, i) => wordAt(table, i) === word)
      if (idx < 0) return fail(at)
    }

    // 0xfea-0x1022: a stress digit. It attaches to the phoneme *already*
    // written, not to the next one.
    if (word >= 0x3000 && word <= 0x3900) {
      at += taken
      // 0x3000 is a bare '0', which is the default and simply disappears.
      if (word !== 0x3000) {
        if (!(attrOf(phonemes[n - 1]) & ATTR.STRESSABLE)) return fail(at - taken)
        stress[n - 1] = 0x30 | ((word >> 8) & 0x0f)
      }
      if (!more()) break
      continue
    }

    at += taken
    const attr = attrOf(idx)
    // 0x1032, and note the position: A0 is advanced at 0x1026, *before* this
    // test, so the offset reported points past the phoneme rather than at it.
    // The digit and no-match rejections above report the character itself.
    if (attr & ATTR.ILLEGAL) return fail(at)

    if (attr & ATTR.PAUSE) {
      // 0x103a-0x1062: pauses collapse. A run of them keeps the *last*, so
      // "a . b" and "a. b" agree — except that a plain space after any pause
      // is dropped instead of replacing it.
      if (attrOf(phonemes[n - 1]) & ATTR.PAUSE) {
        if (n <= LEAD_IN || idx === P.SPACE) {
          if (!more()) break
          continue
        }
        // Overwrite the previous pause. Note its stress and flag bytes are
        // *not* re-cleared — the loop only clears the slot after the one it
        // just wrote — so they survive into the replacement.
        n--
      }
    } else if (idx === P.OPEN) {
      // 0x106a: emphasis brackets set a bit and store no phoneme. Neither
      // path takes the io_Length check at the bottom of the loop.
      flags[n] |= 0x20
      continue
    } else if (idx === P.CLOSE) {
      flags[n - 1] |= 0x10
      continue
    }

    // 0x1084: store.
    phonemes[n] = idx
    n++
    // 0x108a: '.' and '?' end the utterance even mid-string.
    if (idx === P.PERIOD || idx === P.QUERY) break
    if (n >= MAX_PHONEMES) return fail(at)
    if (!more()) break
    stress[n] = 0
    flags[n] = 0
  }

  // 0x10cc. A trailing space is dropped, and then the result is *still*
  // considered for a '-' — the device falls through from one to the other
  // rather than choosing between them, so "AA4 " ends up a phoneme longer
  // than it started rather than a phoneme shorter.
  //
  // Note there is no lower bound on the decrement. With nothing but a pause
  // for input the write index walks back into the lead-in, and the length
  // test at the end then rejects the whole utterance — which is why a lone
  // "." produces silence rather than a pause.
  let dash = true
  if (phonemes[n - 1] === P.SPACE) n--
  else if (attrOf(phonemes[n - 1]) & ATTR.TERMINAL) dash = false

  // 0x10e4: `ble` against 3, not against the lead-in.
  if (dash && n > 3) {
    phonemes[n] = P.DASH
    stress[n] = 0
    flags[n] = 0
    n++
  }

  phonemes[n] = TERMINATOR
  stress[n] = TERMINATOR
  flags[n] = TERMINATOR
  n++

  // 0x1118: four or fewer means the lead-in and nothing else.
  if (n <= LEAD_IN) return { phonemes, stress, flags, count: 0 }
  return { phonemes, stress, flags, count: n }

  /** 0x10aa: stop once io_Length is consumed, whatever the buffer holds. */
  function more(): boolean {
    if (at >= length) return false
    stress[n] = 0
    flags[n] = 0
    return true
  }

  /** 0x10c2: the device reports a 1-based character offset, not a code. */
  function fail(pos: number): Parsed {
    return { phonemes, stress, flags, count: 0, error: pos + 1 }
  }
}

/** The table as the scan sees it: two bytes, NUL-padded, big-endian. */
function wordAt(table: PhonemeTable, i: number): number {
  const s = table.names[i] ?? ''
  return ((s.charCodeAt(0) || 0) << 8) | (s.charCodeAt(1) || 0)
}
