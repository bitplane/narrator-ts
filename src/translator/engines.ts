/**
 * Behavioural differences between translator.library builds.
 *
 * The rule *tables* are near-identical across every shipped build — 1.3 has
 * 700 rules, everything later has 701, and the text barely moves. What
 * actually changes is the matcher, so version differences are expressed as
 * code traits here rather than as data.
 */

export interface EngineTraits {
  /**
   * Whether `-ER` and `-ING` may be followed by a trailing `S` and still
   * count as a suffix for `%`.
   *
   * 1.3's handler (hunk 0x422-0x47e) sends S, D and R alike to a single
   * "next character must not be a letter" check. 31.7 onwards inserts a
   * branch at 0x46a that accepts one `S` first, which is 16 bytes longer —
   * visible in the jump table, where the following handler sits at 0x490
   * instead of 0x480.
   *
   * The effect is on words like `brokers`, `atomizers` and `backsliders`:
   * with the trailing S accepted, `[O]^%` fires and gives the long vowel
   * (`BROW4KERZ`); without it the rule fails and the catch-all short vowel
   * applies (`BRAA4KERZ`).
   */
  suffixAllowsTrailingS: boolean
}

const V1: EngineTraits = { suffixAllowsTrailingS: false }
const V31: EngineTraits = { suffixAllowsTrailingS: true }

/**
 * Confirmed by running every build under the oracle over the same 9,804
 * phrases: 31.7, 33.2, 34.3, 36.1 and 37.1 are output-identical to each
 * other, and 1.3 differs from all of them in 78 phrases.
 *
 * `reference/nrl-table.json` is not a build and is named `nrl-7948`. It takes
 * the 1.3 behaviour, and not merely by falling through: the report's SNOBOL
 * defines SUFFIX as ER/E/ES/ED/ING/ELY and requires the suffix to end the
 * word outright. The trailing-S allowance is SoftVoice's addition.
 */
export function engineFor(version: string): EngineTraits {
  if (version.startsWith('nrl')) return V1
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= 31 ? V31 : V1
}
