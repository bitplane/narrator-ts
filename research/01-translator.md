# translator.library

Offsets are **hunk**-relative (`hunk = file - 0x24`) and cite build 33.2
`11997e3c` unless stated otherwise.

## How many engines are there really?

All six good builds were run through the oracle over the same 9,804-phrase
corpus and their output compared pairwise:

|        | 1.3 | 31.7 | 33.2 | 34.3 | 36.1 | 37.1 |
|--------|----:|-----:|-----:|-----:|-----:|-----:|
| **1.3**  |   0 |   78 |   78 |   78 |   78 |   78 |
| **31.7** |  78 |    0 |    0 |    0 |    0 |    0 |
| **33.2** |  78 |    0 |    0 |    0 |    0 |    0 |
| **34.3** |  78 |    0 |    0 |    0 |    0 |    0 |
| **36.1** |  78 |    0 |    0 |    0 |    0 |    0 |
| **37.1** |  78 |    0 |    0 |    0 |    0 |    0 |

**Two behaviours, not seven.** Everything from 31.7 (Nov 1985) through 37.1
(Jan 1991) is output-identical across the whole corpus, including the V37
rewrite. Only 1.3 (Sep 1985) differs, in 78 phrases — largely the `-TIVE`
suffix:

```
'adjectives'  1.3: AEDJEHKTAY3VZ    31.7+: AE4DJEHKTIHVZ
'automotive'  1.3: AO3TAHMAATAY3V   31.7+: AO3TAHMAATIHV
'atomizers'   1.3: AE2TAHMIHZERZ    31.7+: AE2TAHMAY1ZERZ
```

This is a claim about the corpus, not a proof of equivalence. The corpus does
cover every rule in every version's table (see below), so a rule-level
difference would have to hide in a context no probe reaches.

## Two library conventions

1.3-36.1 carry **no RomTag**. They use the older disk-library convention where
the loaded segment's entry point *is* the initialiser: it calls `MakeLibrary`
and `AddLibrary` itself. 33.2's returns **-1**, not the library base, so the
base has to be taken from the `AddLibrary` call rather than the return value.

37.1 is a proper `RTF_AUTOINIT` resident (flags `0x81`, 5 vectors) and its
vector table is read straight from the RomTag.

Both paths are implemented in `tools/oracle/translate.py:_bring_up`.

## Table layout

Located by signature, not hardcoded, so the same extractor works on every
build despite the offsets moving (33.2 shown; 37.1 has them ~0x62 lower):

| what | hunk offset | notes |
|---|---|---|
| character class table | `0x642` | 128 entries, one big-endian word, indexed `char * 2` |
| wildcard characters | `0x742` | `#*.$%&@^+:?_ `, NUL-terminated |
| vowel phonemes | `0x750` | 15 two-character entries, used by the stress pass |
| bucket offsets | `0x76e` | 28 big-endian longwords, relative to this table's own start |
| rule text | `0x802` | 701 rules across 28 buckets |

The first bucket offset is `0x70` — exactly the table's own length — so bucket
0 begins immediately after it.

## Rule syntax

    left [ match ] right = output <terminator>

with `\` (`0x5C`) or `` ` `` (`0x60`) as terminator. Two traps:

**Parsing must be structural, not terminator-first.** The table contains rules
*for the terminator characters themselves*:

```
[\]= \      [|]=OHR `      [`]= \      [[]= \      [{]= \
```

Splitting on terminators first shreds these. Locating `[` and `]` first makes
the matched literal opaque, which is how the matcher reads it too.

**`=` is optional.** `U[U]\` and `V[V]\` have no `=` at all, meaning empty
output — a silent letter. A parser that requires `=` drops them.

There is also a rule with an empty match, `[]= `, which would be the rule for
`]`; it can never fire, because the normaliser has already turned `]` into a
space (below).

## What the terminator actually does

At `0x2f8` the output-length scan treats both terminators identically:

```
0002fe  move.b  (A6,D7.w), D0
000302  cmpi.b  #$5c, D0        ; '\'
000306  beq     $30e
000308  cmpi.b  #$60, D0        ; '`'
00030c  bne     $2fc            ; keep scanning
```

So both end a rule. The difference is at `0x334`, immediately after the output
is copied:

```
000338  move.b  (-$1,A1), D0    ; last character written
00033e  move.w  (A4,D0.w), D0   ; its class word
000342  btst    #$7, D0
000346  beq     $35a            ; class bit 7 clear -> nothing to do
000348  bset    #$0, ($14,A5)   ; set the pending-stress flag
00034e  cmpi.b  #$60, (A6)      ; terminator is '`' ?
000352  bne     $35a
000354  bclr    #$0, ($14,A5)   ; '`' -> clear it again
```

That flag is read at `0x59e`, which gates a pass that looks the last two
output characters up in the 15-vowel table at `0x750`. So the terminator
chooses whether a rule's output is eligible for **stress marking** — the
digits in `EH4`, `AH3`, `IY2`. `\` leaves it eligible; `` ` `` suppresses it.

This is why guessing was a bad idea: both candidate explanations (trailing
space, last-rule-in-bucket) would have produced a translator that is right on
most words and quietly wrong on stress placement.

## Input normalisation (`0x4fc`)

Before matching, each character is folded:

- `a`-`z` → uppercase (`subi.b #$20`)
- anything below `0x20` → space
- `0x7F` (DEL) → space
- `]` (`0x5D`) → space
- words are buffered to a maximum of **100 characters** (`cmpi.w #$64`)

## The class table

128 entries of one word each, indexed `char * 2`. Bits 9 and 12-15 are never
set. Each name below comes from the wildcard handler that tests the bit (jump
table at `0x60e`), not from what the letters appear to have in common:

| bit | meaning | used by |
|---|---|---|
| 0 | not alphanumeric | — |
| 1 | digit `0`-`9` | `?`, `_`, stress pass |
| 2 | D J L N R S T Z — consonants that change a following long U | `@` |
| 3 | voiced consonant: B D G J L M N R V W Z | `.` |
| 4 | sibilant: C G J S X Z | `&` |
| 5 | consonant | `^`, `*`, `:` |
| 6 | vowel: A E I O U Y | `#` |
| 7 | any letter | stress eligibility, `%`, ` ` |
| 8 | front vowel: E I Y | `+` |
| 10 | the character is itself a metacharacter | rule parsing |
| 11 | word or sentence delimiter | — |

## Buckets

Selection is at `0x258`: the character is remapped to `[` if it is a digit or
`\` if it is neither letter nor digit, then indexed as `char - 'A'`. So
**0-25 are A-Z, 26 is digits, and 27 is everything else**. Bucket 27's last
rule is `[]= ` — an empty match that always succeeds and emits a space.

## Things that only show up on held-out input

Each of these was found by running inputs the corpus generator never saw, and
each is a place where a reasonable-looking implementation is wrong.

**High bytes are folded to spaces, by a signed compare.** The range test at
`0x522` is `cmpi.b #$20,D1` followed by **`bge`** — signed. A byte of 0x80 or
more is negative as a signed byte, fails the test, and becomes a space exactly
like a control character. This is also why the 128-entry class table is
sufficient: bucket selection would index past it with `lsl.w` for a high byte,
but no high byte ever gets that far.

**An over-long word does not abort the translation.** `0x590` puts -3 in D1
and returns, but the main loop at `0x19a` branches on **D3**, which holds the
character count. So the buffer simply keeps its first 100 characters and
matching carries on; D1 is then overwritten with 0 on the normal exit path at
`0x1a8`, so the error code almost never surfaces.

**The remaining-input test runs once, not per character.** `0x50e` sits
before the fill loop and every back-edge targets `0x514`. Repeating the test
each pass emits the `#` end sentinel in the middle of a word that happens to
consume the last input character.

**Rules with no `=` are dead.** The right-context scanner stops at `=`; with
none, it reads the rule's terminator as a literal to compare against input,
which cannot match. `U[U]\` and `V[V]\` are the only two, and the library duly
pronounces both letters of `divvied` and `UU`.

**`%` requires the suffix to end the word**, and from 31.7 on it also accepts
one trailing `S` (`0x46a`). 1.3 lacks that branch — the single behavioural
difference between the two engines. It also never checks that its `?NG` branch
starts with an I, so any letter followed by NG at a word end counts as `-ING`.

**The word-start marker advances on every path through the stress pass**,
including the not-pending branch at `0x5a4`, which jumps to `0x608` where
`move.l A1,(0x10,A5)` still runs. Returning early without it makes the next
word's stress mark land on the previous word.

## Verification

`translate.ts` matches the real library byte-for-byte on **all six good
builds**, over 9,804 training phrases and 5,601 held-out phrases each,
including the returned status code — 92,430 exact comparisons.

The two corpora are kept separate on purpose: the training set derives probes
from the rule tables, so on its own it partly measures the extractor. The
holdout shares no input with it and was built without reference to the tables.

## Still open

- Nothing known for the translator. The next work is `narrator.device`.
