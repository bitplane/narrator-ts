# narrator.device

Offsets are **hunk**-relative (`hunk = file - 0x24`) and cite build 33.2
`1e9f46e0` unless stated otherwise.

This covers bringing the device up, getting audio out of it, and the synthesis
pipeline: command dispatch, which stage is which, the frame format and the
renderer. The front half — how phonemes become frames — is mapped but not
decoded; see "Still open".

## It is not a library you can call

`translator.library` has a `Translate()` you invoke and it returns. The
narrator does not work that way, and this is the whole reason the oracle grew a
scheduler.

Its init creates a **server task**, and `BeginIO` only posts a message to it:

```
0000ba  jsr (-$11a,A6)     ; AddTask(task A1, initialPC A2, finalPC A3)
```

with `A1 = devbase+0x48`, `A2 = hunk+0x5230`, `A3 = 0`. Everything audible
happens in the window where the *caller* is blocked in `WaitIO`. A rig that
only knows how to call a routine and wait for it to return will sit there
forever.

## Bring-up

```
00001a  jsr (-$54,A6)      ; MakeLibrary(dataSize $30c, 6 vectors)
000028  move.l A6,($a4,A2) ; devbase+0xa4  = ExecBase
00002c  move.l D3,($fc,A2) ; devbase+0xfc  = segList
000030  ...                ; NewList at devbase+0x36
000048  jsr (-$c6,A6)      ; AllocMem($22, MEMF_PUBLIC|MEMF_CLEAR) -> a MsgPort
000060  move.l A3,($f4,A2) ; devbase+0xf4  = that port
000064  move.b #4,($8,A3)  ; ln_Type = NT_MSGPORT
00006a  lea $17c2,A1 ; move.l A1,($a,A3)   ; ln_Name
000074  jsr (-$14a,A6)     ; AllocSignal(-1)  -> mp_SigBit
00007e  jsr (-$126,A6)     ; FindTask(0)      -> mp_SigTask
000098  lea ($48,A2),A1    ; the Task struct, inside the device's own data
0000a0  move.l A0,($3a,A1) ; tc_SPLower = devbase+0x104
0000a8  move.l A0,($3e,A1) ; tc_SPUpper = devbase+0x304   — a 512-byte stack
0000ac  move.l A2,-(A0)    ; push the device base onto that stack
0000ae  move.l A0,($36,A1) ; tc_SPReg
0000ba  jsr (-$11a,A6)     ; AddTask
0000c0  jsr (-$1b0,A6)     ; AddDevice
0000c4  moveq #-1,D0       ; returns -1, not the base
```

Two things a reimplementation of the *host side* has to get right:

**The base comes from AddDevice, not the return value** — 33.2 returns -1,
exactly as its translator.library sibling does.

**AddTask must push the finalPC.** The init pre-pushes the device base and sets
`tc_SPReg` itself; `AddTask` then pushes the finalPC on top, which is why the
server reads its device base from `4(A7)` and not `(A7)`.

### Three conventions across five builds

| build | RomTag | how it starts |
|---|---|---|
| 1.6, 31.13, 33.2, 36.9 | none | segment entry point is the initialiser |
| 37.7 | yes, flags `0x00` | resident, but **not** `RTF_AUTOINIT` — `rt_Init` is a routine to call |

36.9 and 37.7 never fill in `LN_NAME`, so there is nothing for `AddDevice` to
register them under. Real exec does not care — it only enqueues the node — and
the rig had to stop caring too.

## The server task

```
005230  movea.l $4.w, A6         ; ExecBase
005234  movea.l ($4,A7), A2      ; the device base, above the pushed finalPC
005238  movea.l A2, A3
00523a  lea ($22,A2), A2         ; A2 = devbase+0x22, the server's own MsgPort
005240  jsr (-$126,A6)           ; FindTask(0)
005244  move.l D0, ($10,A2)      ;   -> mp_SigTask = itself
00524c  jsr (-$14a,A6)           ; AllocSignal(-1)
005252  move.b D0, ($f,A2)       ;   -> mp_SigBit
005258  jsr (-$14a,A6)           ; AllocSignal(-1) again — a second bit
00525e  move.l D2, ($308,A3)     ; devbase+0x308 = the wait mask, both bits
005262  bsr $526e                ; drain the port
005268  jsr (-$13e,A6)           ; Wait(mask)
00526c  bra $5262                ; forever
```

and the drain loop:

```
00526e  btst #6, ($22,A2)        ; devbase+0x44, a flags byte
005276  bset #0, ($22,A2)        ; re-entrancy guard
005280  jsr (-$174,A6)           ; GetMsg(port)
00528a  cmpi.w #$2, ($1c,A1)     ; io_Command — which fixes io_Command at 28
00529c  jsr $146e                ; hunk+0x36e, the worker
0052a2  bra $526e
```

The prologue is load-bearing: until it runs, the port reads `mp_SigTask = 0`
and the first `BeginIO` posts into nothing. On a real machine it has long since
run by the time a client opens the device, so `AddTask` in the rig yields to
the new task rather than merely making it runnable.

## What it asks of audio.device

Confirmed by recording every request (`tools/oracle/audiodev.py`):

```
Open -> ADCMD_ALLOCATE -> CMD_STOP -> CMD_WRITE, CMD_WRITE -> CMD_START
     -> CMD_WRITE ... -> ADCMD_FREE
```

Two buffers are primed before the channels start, then it is a steady stream:

| | |
|---|---|
| buffer size | **512 bytes**, every write, 8-bit signed |
| channels | a **stereo pair**, alternating — mask 3 from the allocation list |
| `ioa_Cycles` | 1 |
| `ioa_Volume` | the request's `volume`, passed through untouched |
| `ioa_Period` | from `sampfreq` |

Volume never reaches the samples — Paula applies it — so two utterances that
differ only in `volume` are byte-identical streams with a different
`ioa_Volume`. That settles how the TypeScript should model it: volume is a
property of the write, not of the waveform.

`sampfreq` maps straight onto the Paula period:

| `sampfreq` | period | actual (PAL, 3546895 Hz) |
|---:|---:|---:|
| 5000 | 715 | 4961 |
| 10000 | 357 | 9935 |
| 22200 (default) | 161 | 22030 |
| 28000 | 127 | 27928 |

So the natural capture format is Paula's own — samples plus a period — and any
resampling is the consumer's business. `rate` changes the number of samples;
`pitch`, `sex` and `mode` change their content but not their count.

## The phoneme inventory

Discovered by asking rather than by decoding the table: `probe-phonemes.py`
speaks every one- and two-letter spelling and every `/X`, and keeps what the
device accepts. Acceptance alone over-counts — 385 of 728 candidates "work" on
33.2, because `BB` is just `B` then `B` — so the inventory is the tokens that
cannot be split into two accepted singles. That test is decisive here because
A, C, E, H, I, O, U and X are not phonemes on their own, so everything real has
a half that cannot stand alone.

| | |
|---|---:|
| 1.6, 31.13, 33.2, 36.9 | **61** phonemes |
| 37.7 | **55** |

The two sets are not nested. 37.7 dropped `/B`, `/M`, `/R`, `GH`, `GX`, `KH`,
`KX` and `UX`, and gained `LX` and `RX` — which is the same pair that crashes
the older engine, below. It corroborates the table read straight out of the
binary: the six syllabics are exactly the `ULUMUNILIMIN` string at hunk+0xf4c,
and the five specials exactly the `/H/M/B/R/C` in the table itself.

## A lone LX, NH or RX is fatal

On 1.6, 31.13, 33.2 and 36.9, speaking any one of those three on its own
never returns: the device runs off into address zero. Not a rig artefact —
all four builds do it identically, everything else in the inventory is fine,
and 37.7 handles all three (`LX` and `RX` speak, `NH` is rejected cleanly).

They are allophones the device presumably only ever expects to generate
internally. Inside a pair they are harmless, so the corpus includes them there
and excludes them alone.

## How many synthesizers are there really?

**Two.** The write stream — samples, channel, period, volume and cycle count —
is compared over the whole corpus, and separately over a subset at each end of
every parameter's range, because agreeing at the defaults alone is weak
evidence:

```
              full corpus         parameter sweep
              4,865 phrases       301 x 11 settings
1.6 31.13 33.2 36.9      0                      0
vs 37.7              4,864                  3,311
```

**1.6 through 36.9 are sample-identical**, 1985 to 1990, at every setting
tried including rate 40 and 400, pitch 65 and 320, both sexes, both modes and
sample rates from 5 kHz to 28 kHz. 37.7 differs on everything: the five phrases
it agrees on are the ones both reject.

The same shape as the translator, and it means the TypeScript needs one
synthesizer for four builds plus a second backend for 37.7 — not five.

A first pass over four phrases said the same thing; a second, before the
over-read below was understood, said *three* engines on the strength of 26
phrases out of 4,865. Both were the same corpus artefact. It is worth
recording that the wrong answer here was not obviously wrong.

## Reading past io_Length

The device does not stop where it is told to:

| build | bytes read past `io_Length` |
|---|---:|
| 1.6, 31.13 | **2** |
| 33.2, 36.9 | 0 |
| 37.7 | 1 |

So on 1.6 a short phoneme string preceded by a longer one is spoken with the
tail of its predecessor attached. `SAA4FAES` then `SHAH4` fails with "illegal
phoneme" while `SHAH4` alone is fine, because the buffer still reads
`SHAH4\0ES` and the `E` is not a phoneme.

This is the one axis on which 33.2 is not identical to 1.6, and it is about
input handling rather than synthesis — which is why the sweeps hand the device
a cleared buffer and measure this separately. A caller that passes a buffer
with stale bytes in it is relying on undefined behaviour, and on 1.6 it bites.

## Errors

`io_Error` is reported faithfully. An illegal phoneme gives **-20**, which is
worth knowing because it is easy to produce by accident: `/H` is a single
phoneme, so `/WER4LD` is not "world" with a stray slash, it is an unknown
phoneme `/W` and the device rejects the lot. A bare `HEH4LOW` fails the same
way, for the same reason.

## What the rig needed

Recorded because each was discovered by something breaking, not designed in.

**A6 must survive a device call.** The Amiga convention is that only D0, D1,
A0 and A1 are scratch. exec's `DoIO` points A6 at the device for `BeginIO` and
must put the caller's back. Getting this wrong is spectacular but not obvious:
the server task went on to call `FreeMem` through *audio.device's* jump table,
landed on padding, and slid through it into address zero.

**Waiting has to consume its signal.** `WaitIO` finding its request already
replied must still clear the reply port's signal bit, or the next `WaitIO`
returns instantly for a message that has not arrived — which showed up as
every other utterance producing no audio at all.

**Blocking and yielding are different.** A handler that blocks is re-entered
from the top when the task next runs, so its context is captured *before* the
trap's RTS. A handler that has finished and merely wants to give up the CPU is
captured after. Confusing the two either loses the call or repeats it.

## The synthesis pipeline

22KB of undocumented code is slow to read statically, so most of what follows
was found by **differential coverage**: the shim counts executions per address
(`Cpu.cover`), and a routine that runs for `AA4` but not `AA`, or vanishes when
`mode=1`, has named itself. Static reading then confirms what it does. Where a
claim below is inference rather than something checked against the running
device, it says so.

### Command dispatch

`BeginIO` is a jump table, not a chain of compares:

```
00036e  move.w ($1c,A1), D0      ; io_Command
000372  ble    $600              ; <= 0  -> error
000376  cmpi.w #$8, D0
00037a  bgt    $600              ; > 8   -> error
00037e  lsl.w  #2, D0
000380  lea    $69a.l, A0        ; the table
000386  movea.l (A0,D0.w), A0
00038a  jsr    (A0)
```

| command | handler |
|---|---|
| 1 `CMD_RESET` | `hunk+0x4e6` |
| 2 `CMD_READ` | `hunk+0x1ae` — the mouth-shape read |
| 3 `CMD_WRITE` | `hunk+0x290` — speak |
| 4 `CMD_UPDATE`, 5 `CMD_CLEAR` | `hunk+0x60c` (shared; a no-op returning success) |
| 6 `CMD_STOP` | `hunk+0x4a8` |
| 7 `CMD_START` | `hunk+0x46c` |
| 8 `CMD_FLUSH` | `hunk+0x510` |

`CMD_WRITE` opens by walking the device's request list at `devbase+0x36` for a
queued `CMD_READ` on the same unit and completing it — which is how the
mouth-shape stream is fed. It brackets that with `$dff09a` (INTENA) writes and
the `IDNestCnt` byte in ExecBase, i.e. Forbid/Disable inlined rather than
called.

### Which stage is which

`A5` is the per-unit workspace — the `0x30c` bytes `MakeLibrary` was asked for.
84 distinct offsets into it are referenced. Grouping routines by what changes
their execution count:

| routines | responds to | so it is |
|---|---|---|
| `0xf68`, `0x112c`, `0x11bc`, `0x12d8` | input length and content | phoneme parsing |
| `0x1412`, `0x21b8`, `0x220c`, `0x230c`, `0x23ce` | **only** a stress digit | stress handling |
| `0x25f8`, `0x2642`, `0x2864` | drop to **zero** when `mode=1` | natural-mode intonation |
| `0x2bc6` | 76 → 191 when a `.` or `?` is added | sentence-final contour |
| `0x2a6a`, `0x2a92`, `0x2aba`, `0x2d1c`, `0x2d54`, `0x2d86` | length, everything | frame generation |
| `0x52b4`–`0x57da` | output sample count | rendering and audio |

Two results worth stating plainly, because they shape the port:

**`rate`, `pitch`, `sampfreq` and `volume` change no branch at all** — coverage
is identical, instruction for instruction, at both extremes of each. They are
scalars into the same code.

**`sex` very nearly doesn't either**: `0x778` moves 91 → 93 and `0x15e0` by 3.
It is a parameter, not a separate voice.

### The renderer

The inner loop, at `hunk+0x548a`, is three formants summed through two tables:

```
005494  move.w D1, D5           ; F1 phase
005496  lsr.w  #4, D5
005498  move.w D3, D6           ; F1 amplitude
00549a  or.b   (A0,D5.w), D6    ; A0 = waveform, 64 entries
00549e  move.b (A1,D6.w), D7    ; A1 = amplitude x waveform -> sample
0054a2  move.l D2, D5           ; F2 and F3 phases, packed in one longword
0054a4  lsr.l  #4, D5
0054a6  andi.w #$fff, D5
0054aa  move.l D4, D6           ; F2 and F3 amplitudes, likewise packed
0054ac  or.b   (A0,D5.w), D6
0054b0  add.b  (A1,D6.w), D7
0054b4  swap   D5               ; the other half of each
0054b6  swap   D6
0054b8  or.b   (A0,D5.w), D6
0054bc  add.b  (A1,D6.w), D7
0054c0  move.b D7, (A3)+
0054c2  move.b D7, (A3)+        ; twice
```

with the phases advanced and wrapped as a pair:

```
005518  move.l #$3ff03ff, D7
00551e  add.w  ($0,A5), D1      ; F1 increment
005524  add.l  ($2,A5), D2      ; F2 and F3 increments, together
00552a  and.w  D7, D1           ; wrap to 10 bits
00552c  and.l  D7, D2
005534  adda.l #$40, A0         ; every 9 samples (11 if A5+0x26 is 0)
```

So: **three formants, 10-bit phase accumulators, a 64-entry waveform table
that is stepped forward 64 bytes at a time as the frame progresses**, and a
second table indexed by amplitude-and-waveform that does the multiply. For the
default voice `A0` starts at `hunk+0x4aae` and `A1` at `hunk+0x3106`.

**Voiced samples are computed at half the output rate and written twice.**
That is the `move.b D7,(A3)+` pair above, and it is not an inference:

| input | non-silent sample pairs | `s[2i] == s[2i+1]` |
|---|---:|---:|
| `AA4`, `IY4` | 3184, 2648 | **100.0%** |
| `S`, `SH`, `F` | 1171, 1110, 931 | 9.7%, 16.9%, 17.3% |
| `AA4S` | 4231 | 63.6% |

The unvoiced path is a different loop at `hunk+0x5610`, and it writes **once**
per iteration (`0054...` → `005648  move.b D7,(A3)+`). It adds a third table
`A4`, indexed by a counter at `A5+0x10` — the noise source — and tests bit 31
of the packed amplitude longword to decide whether to *also* sum a voiced
formant, which is what a voiced fricative needs.

So the device runs its voiced synthesis at roughly 11 kHz and its unvoiced at
roughly 22 kHz, whatever `sampfreq` says. Any port that computes every sample
at the output rate will not be sample-exact, and will not sound the same
either: the duplication is audible as the characteristic grain.

### The frame format

Eight bytes, from the loads at `hunk+0x5544` and `hunk+0x55d0`:

| | | | |
|---|---|---|---|
| +0 | F1 phase increment | +4 | F2 amplitude |
| +1 | F2 phase increment | +5 | F3 amplitude |
| +2 | F3 phase increment, doubled into a word | +6 | voicing |
| +3 | F1 amplitude | +7 | pitch period, in samples |

Bit 7 of +0 ends the array. A +6 of zero is fully voiced; otherwise bit 7 means
"sum a voiced formant as well" (a voiced fricative), bits 4-6 pick one of eight
fricative tables at `A5+0xa2`, and bits 0-3 are the noise amplitude.

`D0` carries two counters, one per half-word, and the code swaps between them:
the samples left in this frame (reloaded to `A5+0x24` each frame) and the
samples left in this pitch period (reloaded from +7). **Amplitudes are only
sampled at a pitch pulse**, so a frame whose period has not expired keeps the
previous pulse's levels — including a pulse that lands mid-frame.

Two things here are easy to get plausibly wrong. The increments are added as
one longword read from `A5+2`, so F2's word is the *high* half and F3's the
low, and the add is bracketed by swaps that land each on its own accumulator.
And `lsr.l #4` shifts the whole longword *before* the halves are separated, so
F3's low nibbles pass through F2's word and are masked off there. Both were
wrong in the first port and both produced output that looked reasonable.

### Unvoiced output is not doubled — it is two nibbles

The noise loop reads one byte from the fricative table and emits **two**
samples from it, low nibble then high (`hunk+0x5644` and `hunk+0x5654`), with
the voiced component added to each. So unvoiced runs at the output rate while
voiced runs at half it, and the incidental 10-17% equality measured earlier is
just two nibbles happening to match.

Three more things the noise path does, none of them guessable:

**The fricative index ping-pongs.** It walks up the 0x1e0-byte table, reverses
at 0 and at 0x1df, and walks back (`hunk+0x56b2`, step in `A5+0x12`). Wrapping
instead would put a discontinuity in the noise once per pass.

**A pure-noise frame edits the frame array.** For a voicing byte of 1..0x7f —
noise with no mixed bit — `hunk+0x5564` zeroes *this* frame's three amplitudes
and *the next frame's*, in place. Since amplitudes are only sampled at a pitch
pulse, a pulse landing on or after a fricative reads those zeros rather than
what the front end wrote. Leaving it out is invisible until a plosive.

**Pure noise never ticks the pitch counter** and never touches a phase
(`hunk+0x56dc`); it only counts the frame down. A mixed frame does tick it, but
advances F1 only and zeroes the F2/F3 pair each sample (`hunk+0x56ca`),
skipping the waveform stepping entirely.

### The noise path destroys the F2/F3 amplitudes

`D4` holds the two amplitudes packed into one longword — and `hunk+0x5610`,
the top of the noise loop, opens with `moveq #$0,D4`, reusing it as a scratch
index into the fricative table. So an unvoiced frame **wipes the F2 and F3
amplitudes**, and since amplitudes are reloaded only at a pitch pulse, every
voiced frame between a fricative and the next pulse runs with F1 alone.

That is not a rounding difference. In `J` it is 112 samples in which the real
device emits a flat tone stepping only when the waveform pointer advances —
runs of exactly 22 samples, `waveStep` × 2 — while a port that keeps its
amplitudes produces a moving waveform. It is why a vowel after a fricative
starts thin, and no amount of staring at the frame data suggests it: the
frames say F2 and F3 have amplitude, and the register holding them is simply
gone.

This one was found by tracing rather than by reading. `tools/trace-render.py`
single-steps the device and prints the output index at every pitch pulse
(`hunk+0x55b6`) and every frame decode (`hunk+0x5544`); laying that against the
same trace from the port showed the counters agreeing exactly, which ruled out
the whole class of explanations I had been working through and left the sample
computation as the only place to look.

### One instruction that the fixtures cannot check

`hunk+0x5586` sets bit 31 of `D6` — the flag the noise path tests to decide
whether to sum a voiced formant — with a `bset`, and there is **no `bclr`
anywhere in the routine**. The only thing that clears it is `move.l D4,D6` on
the voiced sample path (`hunk+0x54aa`). So it is sticky: after a voiced
fricative, every pure-noise frame up to the next voiced one still behaves as
mixed.

The port does what the instructions say. But **no captured utterance
distinguishes it**, and `VF`, `DHTH` and `ZHSH` are in the corpus specifically
to try: they put a pure-noise frame directly after a mixed one, and both
readings are still byte-identical over all 30 captures. It stays hidden because
`hunk+0x558c` clears `D3` on exactly those frames, so the voiced formant the
sticky bit sums is silent — and the amplitudes that a differently-timed pitch
pulse would load have been zeroed in the frame array anyway.

Recorded here because "verified against the device" is a claim this particular
line has not earned.

### The phoneme parser

`hunk+0xf68`, the first stage of the front half. It turns the input string into
three parallel byte arrays and everything downstream works from those:

| | |
|---|---|
| `A5+0x0e8` | the phoneme index, one byte each |
| `A5+0x2e8` | the stress digit as ASCII, or 0 |
| `A5+0x4e8` | flags set while scanning — bit 5 for `(`, bit 4 for `)` |

with `0xff` in all three as a terminator and the count in `A5+0x9a`. The first
two are the same memory the renderer later uses as its two audio buffers, so
the workspace is reused between stages and these have to be read at the
parser's exit rather than afterwards.

**The arrays start at index 4.** Slots 0-3 are a lead-in that later stages look
backwards into, and slot 2 is seeded with `0x15` (QX) before the scan. A port
that starts writing at zero gets plausible phonemes and wrong everything else.

Matching is against the 112 two-byte names at `hunk+0xe88`: two characters at
a time, falling back to one by masking the low byte off and rescanning. An
empty name slot is not padding — a diphthong or a stop occupies several
consecutive indices, one per frame it expands to, and only the first is named.
So a gap in the names is a phoneme more than one frame long.

Each phoneme also has an attribute longword at `hunk+0x2f08`, and there are
**102 of them, not 112**: the last ten names are the stress digits `0`-`9`,
which the parser peels off before any lookup. The table ends at `hunk+0x30a0`.
`tools/extract-phonemes.py` reads both out of the binary.

Three behaviours worth writing down, because each looks like a bug until you
check it against the device:

**Pauses collapse, asymmetrically.** A run of pause phonemes keeps the last,
so `AA4 . IH4` and `AA4. IH4` agree — but a plain space *after* a pause is
dropped rather than replacing it, and the overwritten slot keeps its stress
and flag bytes, because the loop only clears the slot after the one it wrote.

**A trailing space makes the utterance longer.** `hunk+0x10cc` drops it and
then *falls through* to the `-` append rather than choosing between them, so
`AA4 ` ends up one phoneme longer than `AA4` rather than one shorter.

**A lone pause produces silence, not a pause.** The same decrement has no
lower bound, so with nothing but `.` for input the write index walks back into
the lead-in and the length test at `hunk+0x1118` then rejects the whole
utterance. `.`, `-`, `,`, a single space and `()` all return zero.

There are three exits, and they are easy to confuse: `hunk+0x1122` succeeds,
`hunk+0x1120` returns "nothing at all", and `hunk+0x10ca` rejects. The
rejection reports the 1-based offset of the offending character rather than an
error code — and `hunk+0x10c2`, the label the branches actually target, is
three instructions before that offset is computed, so stopping there reads the
phoneme write index and gets a plausible wrong answer. The offset points at
the character itself for a stress digit or an unknown name, but *past* it for
an illegal phoneme, because `A0` is advanced before that test.

The port is `src/narrator/parse.ts`, byte-exact against the device on all 30
speech utterances and all 50 inputs in `fixtures/corpus/parse.txt`, rejections
and empty results included.

### The front half, stage by stage

`CMD_WRITE`'s synthesis path is a straight run of calls at `hunk+0x7fe`, each
handing the next a workspace rather than a value:

| call | routine | what it writes |
|---|---|---|
| `0x7fe` | `0xf68` | the three arrays — the parser, above |
| `0x810` | `0x112c` | nothing for simple input |
| `0x81c` | `0x12d8` | rewrite pass 1, rules at `hunk+0x968` |
| `0x826` | `0x11bc` | stress bytes: `0x80` and `0x80\|digit` |
| `0x82c` | `0x1e1c` | word pairs at `A5+0x5e`..`0x88` |
| `0x832` | `0x1ee0` | loop test, with `0x2160` as the body |
| `0x846` | `0x1be8` | durations, into the flag array |
| `0x852` | `0x12d8` | rewrite pass 2, rules at `hunk+0xae3` |
| `0x85c` | `0x1454` | drops the spaces, then lays out the frame array |
| `0x866` | `0x19bc` | contour codes, into the low nibble of the stress byte |
| `0x86c` | `0x29d8` | the frame array, in allocated memory |
| `0x884` | `0x52b4` | the renderer |

`tools/trace-stages.py` produces that attribution by diffing the workspace
across each boundary, and `tools/capture-stages.py` is the machine-readable
version the tests consume. Reading 22KB of 68k to find out which stage owns
which byte is the slow way round.

### The rewrite engine

`hunk+0x12d8`, run twice over the phoneme array with different tables. A rule
is variable length and matches a phoneme, its two neighbours, and up to three
groups of attribute tests; it can replace the phoneme and insert one before
and one after.

```
+0  phoneme to match, 0xff for any
+1  left neighbour,   0xff for any
+2  right neighbour,  0xff for any
+3  bits 0-3 length; bit 5 keep scanning this position; bit 6 skip an
    unstressed right neighbour; bit 7 skip an unstressed left neighbour
+4  replacement, 0xff to leave alone
+5  insert before, 0xff for none
+6  insert after,  0xff for none
+7. tests: bits 0-4 the bit, bit 5 invert, bit 6 test the attribute longword
    rather than the stress byte, bit 7 last test of the group
```

**A length of zero terminates the table, and `0xff` in byte 0 is a wildcard.**
Reading it the other way round stops table 1 six rules early at a rule that
happens to begin `0xff`, and the rules it silently drops are the ones that
insert glottal stops. A test *passes* when its bit is clear, which reads
backwards until you notice the caller branches on `bne`.

The insertion routine at `hunk+0x1412` inserts at `i+1` rather than at `i` and
leaves the cursor on what it inserted, which is why "insert before" is written
as decrement, insert, increment.

The two tables are real phonology, and worth reading as such:

**`hunk+0x968`, 32 rules — allophony.** `T` and `D` between vowels become the
flap `DX` ("butter"); `D` before `R` becomes `J` and `T` before `R` becomes
`CH` ("drive", "train"); `UL`/`UM`/`UN` become `AX L`/`AX M`/`AX N` and
`IL`/`IM`/`IN` likewise with `IX`; `L` becomes dark `LX`; `Z` devoices to `S`;
and several rules insert `Q`, a glottal stop, before a vowel.

**`hunk+0xae3`, 45 rules — frame expansion.** This is where a phoneme becomes
the several frames it is really made of. The diphthongs `EY`, `AY`, `OY`,
`OW`, `AW`, `UW` and `UX` each gain their second half, which is the *unnamed
slot immediately after them in the name table* — so the gaps in that table are
explained here. `G` and `K` split into front and back variants by vowel
context. And `P`/`T`/`K` gain a release whose identity depends on whether an
`S` precedes: aspirated normally, unaspirated after `S`. That is the
difference between "pin" and "spin", in a rule table from 1984.

`src/narrator/rewrite.ts` is the port, checked against the device's own arrays
either side of both passes for all 30 captured utterances. Ten of them change
in the first pass and eight in the second, so the rest are testing that rules
correctly decline to fire.

### The stress spreader

`hunk+0x11bc`, run after the first rewrite pass so it sees allophones rather
than what was typed. The parser leaves a stress digit on the single phoneme it
was written after; this turns that into something spread across a syllable.

It walks the array vowel by vowel — where "vowel" is attribute bit 0, except
that `LX` and `RX` are excluded by index (`0x1206`) despite having the bit —
and from the second vowel of a span onwards writes a descriptor forward to the
midpoint between the previous vowel and this one. At a space or a phrase-final
pause it closes the span, marks the vowel in the flag array, and for a pause
(but not a space) marks every phoneme from the vowel to the pause.

| bit | in | meaning |
|---|---|---|
| `0x80` | stress | the first phoneme of a spread |
| `0x40` | stress | a spread byte |
| `0x20` | stress | the source vowel carried a stress digit |
| `0x80` | flags | this phoneme is its syllable's vowel |
| `0x40` | flags | between the last vowel and a phrase-final pause |

Three things here are not what the code appears to say:

**The `ori.b #$80` at `0x124c` is outside the loop.** The `dbra` at `0x1258`
branches to `0x1252`, one instruction past it, so only the *first* byte of a
spread is marked. Reading it as the loop's top marks the whole span, which is
wrong on every word with more than one syllable and right on every word with
one — so `AA4` and the fricatives all still pass.

**The descriptor carries across spans.** `0x1290` clears only its `0x20` bit
before recomputing, so the `0x40` set in a previous span survives into the
next. It reads as one running value rather than one per syllable.

**A space leaves the attribute register stale.** `0x11e4` branches to the
boundary handler without looking the phoneme up, so the `btst #$19` at
`0x12a6` tests whatever preceded the space. That is exactly what makes a space
close a span without marking a phrase end, while `.` and `-` do.

`dbra` with a count of -1 means 65536 iterations, not none, so the port keeps
the 68k's loop shape rather than turning it into a `for`.

### The eight parameter arrays

`hunk+0x1e1c` is pure setup, and it gives away the shape of the rest: it points
nine registers at **eight 0x80-byte arrays** running from `A5+0x6e8` to
`A5+0xa68`, alongside the three phoneme arrays. Eight, and the frame is eight
bytes wide — the front half builds one array per frame field and `0x29d8`
interleaves them.

They are **not** indexed by frame. For `/HEH4LOW` only three entries are
filled, and three is the number of vowels in it (`QX`, `EH`, `OW` — the seeded
lead-in counts). The first three arrays for that word read:

```
arr0  110  134  135
arr1  110  140  136
arr2  110  115  110
```

110 is the default `pitch` parameter, and the triples are a pitch contour per
syllable: flat on the lead-in, up-and-over on the stressed `EH4`, falling away
on the final `OW`. So the pitch machinery works per syllable and a later stage
expands it across frames.

`tools/capture-stages.py` records all eight, plus `A5+0x20`..`0xb0`, at every
stage boundary.

### The last rule of each table is also its terminator

Byte 3's low nibble is a rule's length, and a length of zero ends the table.
But the last rule of **both** tables has a length nibble of zero and is still
a live rule, because the nibble is only read at `hunk+0x1316` — the path that
skips a rule that did **not** match. A rule that matches is applied without it
ever being looked at, and there is never a need to skip past the last rule, so
the terminator and the final rule are the same bytes.

The tests cannot be delimited by the length either: `hunk+0x13e4` reads them
until bit 7, three groups' worth, with no bound at all. Reading them that way
recovers the last rule and, on every other rule in both tables, agrees with
the nibble exactly — 79 rules, 79 agreements, which is what makes it safe.

Reading the length as a terminator instead costs each table its last rule:

| table | rule | effect |
|---|---|---|
| `0x968` | `WH` → `/H` `W` | the "which"/"witch" distinction, gone entirely |
| `0xae3` | `<57>` +after `<58>` | `CH`'s second continuation frame |

Neither shows up in a short corpus. The `CH` one surfaced on `STREH4NGKTH`
and nowhere else in 74 phrases, as a single missing phoneme.

### The duration model

`hunk+0x1520` reads a per-phoneme duration from a table at `hunk+0x3806`, and
adds `0x80` to the pointer when bit 4 of the stress byte is clear — so there
are **two tables, stressed and unstressed**, and bit 4 is the one the onset
marker and the spreader both set. Durations are in frames:

| | stressed | unstressed |
|---|---:|---:|
| `OY` | 34 | 13 |
| `AA` | 24 | 10 |
| `IY` | 19 | 6 |
| `AX` | 14 | 5 |
| `S` | 15 | 6 |
| `T` | 8 | 5 |
| `DX` | 4 | 2 |
| `,` | 36 | 36 |
| `-` | 24 | 24 |

Diphthongs are longest, the flap `DX` is shortest, and the punctuation
"phonemes" are pause lengths that ignore stress entirely.

Two entries read 0 in both tables and both are corroboration rather than
coincidence: the syllabics `UL`/`UM`/`UN`/`IL`/`IM`/`IN`, because the first
rewrite pass always expands them and they never reach this stage — and `NH`,
which is one of the three phonemes that crash the device when spoken alone.

`tools/extract-phonemes.py` reads both tables.

`hunk+0x1454` is itself a driver of seven sub-routines, so the stage trick
works one level down and `capture-stages.py --sub` breaks inside it. For
`/HEH4LOW` that shows `0x1970` doing the bulk of the work — it rewrites all
three arrays shifted to index 0 — `0x1492` touching only the two continuation
slots, and the other five doing nothing, so they want inputs this word does
not provide.

`0x1492` is read: it walks the array and, for phonemes whose attribute bit 21
is set — which is exactly the continuation slots rewrite pass 2 created —
copies the previous phoneme's stress and looks a duration up in the tables
above. `RX` gets a special case that averages its own duration with its
predecessor's and writes the result to both, and attribute bit 7 halves a
duration across two slots.

`0x1970` turned out not to be the duration assignment at all. It is a
compaction: it walks the three arrays and drops every phoneme whose attribute
bit 20 is set — the space and the bracket markers — copying the survivors down
to index 0. That is why the stage tracer sees it rewrite all three arrays. It
does **not** fix up `A5+0x9a`, so the count stays at the pre-compaction length
and every stage after this one walks to the `0xff` instead.

### `hunk+0x1454` is where phonemes become frames

`0x1586` is the hinge. It totals `flags[i] & 0x3f` over the whole array,
allocates eight bytes per frame plus one spare, and puts the pointer in
`A5+0x28` — so the frame array is built *here*, not in `0x29d8`. A second
allocation of one byte per frame goes in `A5+0x2c` when `A5+0xdb` says the
caller wants mouth shapes.

`0x15e0` then writes each phoneme's parameters into every frame it occupies,
from a contiguous block of 0x80-byte tables:

| table | frame bytes | what |
|---|---|---|
| `0x3506`, `0x3586`, `0x3606` | 0-2 | F1, F2, F3 phase increments |
| `0x3686`, `0x3706`, `0x3786` | 3-5 | their amplitudes |
| `0x3a06` | 6 | voicing |
| `0x50ae`, `0x512e`, `0x51ae` | 0-2 | the second voice's frequencies |

The frequencies are a vowel chart: `IY` is F1 25 / F2 203, `AA` is 65 / 106,
`UW` is 32 / 116 — high-front, low-back, high-back, exactly where they belong.
The second voice raises them and leaves the amplitudes and the voicing alone,
which is what `sex` actually does.

Three things fall out of this routine that are worth naming.

**Stress is mostly loudness.** A stressed phoneme gets 2 added to each of its
three amplitudes. Only the first is clamped, at `0x1f`; the other two are
allowed to wrap. That asymmetry is in the instructions, not a slip here.

**`.` and `?` borrow the formants of whatever preceded them** (`0x16ac`), so
the silence keeps the mouth where the speech left it rather than snapping to a
neutral shape.

**A stop's release is coloured by the vowel after it.** `0x1492` writes a code
3, 4, 5 or 6 into the low nibble of a continuation slot's stress byte, chosen
by the *following* phoneme's attribute bits 3, 5 and 6; `0x15e0` then shifts
that into bits 4-6 of the voicing byte, which is what picks one of the eight
fricative tables. Those attribute bits are vowel frontness and rounding — bit
3 on the front vowels and `Y`, bit 5 on the back and rounded ones, bit 6 on
the most rounded. So the burst of "key" and the burst of "coo" are different
tables, which is a real coarticulation effect and not a lookup convenience.

And `0x15e0`'s fill loop is `subq` then `dbra`, so a duration of **zero writes
65536 frames rather than none**. That is not a missing guard — it is why `NH`,
whose duration is 0 in both tables, crashes the device when it is the only
phoneme in an utterance. The other two crashing phonemes are `LX` and `RX`,
and `RX` is the one `0x1492` gives a special case to.

### Coarticulation, and where the SAM lineage shows

At this point every phoneme is a block of identical frames. The last two
sub-routines are what bend them into each other, and they use four more
0x80-byte tables from the same block — which are, name for name, the tables
SAM has:

| table | | |
|---|---|---|
| `0x3a86` | blend rank | which of two neighbours wins a boundary |
| `0x3b06` | blend weight | how far the loser is pulled towards it, in 1/32nds |
| `0x3906` | transition in | frames spent easing in |
| `0x3986` | transition out | frames spent easing out |

`0x172a` blends the first frame of each phoneme across the join. The ranks
decide the direction: punctuation ranks 31 and beats everything, `Z` ranks 20,
the vowels rank 2 and lose to nearly everything. So a vowel next to a
consonant takes the consonant's shape at the join, not the other way round —
which is the right way round for speech, because consonant place is what the
ear reads and vowels are what bends around it.

The three frequency bytes are only blended when both sides are non-zero.
Silence has no formant position, and interpolating towards it would sweep the
formants to nothing instead of just fading. The amplitudes have no such guard
and always cross-fade. A stop's release is exempt from the whole thing: the
burst is supposed to arrive abruptly.

`0x17d6` then marks the head and tail of each block as frames for `0x29d8` to
interpolate across — `0xfe` in the three amplitude bytes, zero in the three
frequency bytes. Lengths come from the two transition tables, again with the
higher-ranked neighbour deciding, and if the two ends will not both fit inside
the phoneme they are trimmed a frame at a time, at most twice; if they still
do not fit, the whole phoneme becomes one long transition.

Two special cases in it are worth naming. A sonorant whose neighbour is a stop
**keeps its amplitudes** through the transition — only the formants are
blanked — so the sound carries across the join instead of dipping to silence.
And a liquid or glide after a stop or a voiceless fricative gets a two-frame
head whatever the table said, which is the /l/ of "play" and the /r/ of
"price".

Stops are skipped by both routines. Their frames are a closure and a burst,
and neither is something to ease into.

### Durations are assigned by `hunk+0x1be8`, into the flag array

The main durations are set two stages earlier, and they are written into the
**flag** array rather than an array of their own: from `0x1be8` onwards
`flags[i] & 0x3f` is a frame count, and the spreader's `0x80` and `0x40` sit
above it untouched. That reuse is why the later stages appear to read
durations out of the wrong array.

The routine picks a point between the phoneme's stressed and unstressed table
entries. It accumulates a scale in 1/32nds, starting at exactly 32, and
multiplies in a factor for each thing it notices — `hunk+0x1e12` is
`D0 = (D0 * D1 + 16) >> 5`, so every factor rounds to nearest on its own:

| factor | when |
|---:|---|
| 45/32 | the phoneme is between the last vowel and a phrase-final pause |
| 45/32 | a liquid or nasal immediately before a pause |
| 27/32 | a vowel that is not its syllable's nucleus |
| 26/32 | a vowel inside a spread |
| 22/32 | a vowel outside any stressed syllable |
| 38/32 | a stressed vowel before a pause |
| 38/32 | a vowel before a **voiced** fricative or stop |
| 22/32 | a vowel before a **voiceless** stop |
| 27/32 | a vowel before an unstressed nasal |
| 27/32 | a consonant that does not follow a pause |
| 3/32 | an unstressed liquid or glide running into a vowel |
| 38/32, 22/32 | a vowel with a vowel after it, or before it |
| 16/32, 22/32 | a consonant in a cluster on both sides, or one |

Then `duration = floor + (ceiling - floor) * scale / 32`, where the floor is
halved first unless the phoneme is stressed or is a liquid or glide; and a
stressed vowel after a voiceless stop gets three frames back, which is the
aspiration being paid for.

Two of those are real phonetics rather than bookkeeping. The voiced/voiceless
split before an obstruent is the pre-voicing lengthening that makes "buzz"
longer than "bus" — same vowel, same stress, different neighbour. And the 3/32
on an unstressed liquid before a vowel is what makes `/R/` and `/L/` glide
into the vowel instead of standing as segments of their own.

The clamp at `0x1dfe` is dead code. Every factor is at most 45/32 and no path
applies more than two of the large ones, so the scale cannot exceed 63; run
the whole table at 63 and the largest result is 61 frames (`OY`, floor
halved), under the 63 the clamp tests for. It is ported anyway, because it is
what the routine says and because 37.7 may retune the tables.

### Fixtures that pass prove nothing about branches they do not reach

The stress spreader passed 27 of 30 captures with a real bug in it, because
only multi-syllable words went down the affected path. `tools/branch-coverage.py`
answers that directly: it counts the **device's** own visits to each decision
point in a routine, so a branch nothing reaches is a measured fact rather than
a hope.

Run against the duration routine, the renderer's 30-phrase corpus reached 19
of its 20 decision points, but five of them exactly once. `fixtures/corpus/stages.txt`
was written to fix that — real English words chosen per branch, because a
phonotactically impossible string can exercise a branch and still tell you
nothing — and every reachable point is now driven at least four times. Writing
it is also what exposed the missing rewrite rules above.

### The contour, and where the pitch actually lands

`hunk+0x19bc` is two calls. The first, `0x19c4`, throws away everything the
earlier stages left in the low nibble of the stress byte and puts three flags
there instead — the vowel (1), the phoneme the fall starts on (2), and the
last voiced phoneme before the fall runs out (4).

The second, `0x1a8e`, writes a pitch period into a *handful* of frames — the
ones those flags pinned — and leaves the rest at zero for `0x29d8` to
interpolate between. Every value is

    period = 1221000 / pitch / v

and 1,221,000 is exactly 11,100 x the default pitch of 110. It is an immediate
in the binary, loaded twice with the first load dead, so it assumes the
default sample rate: changing `sampfreq` does not move it. A larger `v` gives
a *shorter* period, so the four arrays hold frequencies and the frame holds a
period.

Per syllable it pins up to four points, from `arr0`..`arr3`:

| | |
|---|---|
| `arr0` | the peak, on the syllable's first frame |
| `arr2` | the low, on the last frame before the fall |
| `arr1` | the middle, placed by **how far the pitch has to travel** on each leg rather than at the halfway point in time, so a big early drop puts it early |
| `arr3` | bits 4-6, halved: a rise added back at the end of the voiced run |

When `arr3` is non-zero there is a third leg, and the fall is squeezed into the
first half of the run to make room for it — `n - n/2`, so an odd number of
frames rounds up. That third leg is the question intonation.

`mode` 1 skips all of it and writes one period into every frame, from a
hard-coded 110 rather than the `pitch` parameter it has already divided by.
That is the robot voice.

### `hunk+0x29d8` is a driver too

Eight sub-routines over the frame array, and `capture-stages.py --sub` now
breaks after each so they can be ported one at a time the way `0x1454` was:

| | |
|---|---|
| `0x2aba` x4 | fill runs of zero in bytes 0, 1, 2 and 7 |
| `0x2d54` | a seven-tap box filter over F2, and later over the pitch |
| `0x2d86` | a triangular kernel, `1 2 2 6 2 2 1`/16, over F3 |
| `0x2dca` | intrinsic pitch — see below |
| `0x2bc6` | re-marks a few frames, and clears a voicing byte |
| `0x2a4a` | fill runs of `0xfe` in bytes 3, 4 and 5 |
| `0x2d1c` | the amplitude gain curve at `hunk+0x2cfc` |
| `0x2ae0` | no effect on any captured utterance |
| `0x2e80` | the mouth-shape stream, when `A5+0xdb` asks for it |

The first and the sixth share one interpolator, `0x2a6a`. It walks a straight
line in 1/32nds: the endpoints are shifted up five bits, the step is
`(to - from) * 32 / frames` computed once with `divs.w`, and each frame shifts
the accumulator back down. The rounding is therefore a running one and the
last frame does not necessarily land exactly on the target.

What differs between the two callers is the hole marker, and the reason is
worth having. The frequency and pitch columns use **zero**, because a
frequency of zero is silence and a pitch of zero is meaningless — neither can
be a value anyone meant. The amplitude columns cannot use zero, because zero
*is* a real amplitude: it is silence, and a stop's closure is exactly that. So
they use `0xfe`, which is what `hunk+0x17d6` writes.

### Microprosody

`hunk+0x2dca` nudges each phoneme's pitch by what the phoneme *is*, and it is
the most linguistically literate thing in the device. The frame byte is a
period, so adding to it lowers the pitch.

| | |
|---|---|
| `B`, `D` | +10 — lower |
| voiceless stops, nasals, fricatives | −6 — higher |
| `Q`, the glottal stop | a flat 0xe6 |
| vowels, liquids, glides | `(F1 - 0x2b) / 4` |

Both effects are real and both are well documented. Voicing through a closure
needs a slack larynx, so voiced obstruents carry a lower F0 than voiceless
ones. And for vowels the shift is read straight out of **F1 in the frame the
device has already built** — high vowels have a low F1 and a high F0, low
vowels the other way round, so "beat" sits above "bat" on the same intended
note. Taking it from F1 rather than from a table of its own gets that for
free, and gets it right for the interpolated frames between phonemes too.

## Still open

- **How phonemes become frames.** The parser, both rewrite passes, the onset
  marker, the stress spreader and the duration assignment are done. What is
  left is the pitch machinery (`0x1ee0` and `0x2160`, filling the eight
  parameter arrays per syllable); the two coarticulation routines at the end
  of `0x1454` (`0x172a` and `0x17d6`, which bend each phoneme's block of
  identical frames into its neighbours and are the only reason the output is
  not a sequence of steady states); `0x19bc`, which masks the stress byte to
  its high nibble and writes a contour code 1..6 into the low one before
  calling `0x1a8e`; and seven of `0x29d8`'s eight sub-routines.
  `fixtures/golden/frames.json` already holds the frames the device produced
  for each captured utterance, so this has an oracle waiting for it the way
  the renderer did.
- **What the attribute bits mean.** 102 longwords, and the parser only tests
  four of them (0, 25, 26, 27). The rest are read by the stages above and are
  recorded by number rather than guessed at — several are clearly phonetic
  features (bit 15 on exactly R/L/RX/LX, bit 16 on exactly M/N/NX/NH, bit 12
  on the fricatives) but "clearly" is not the standard here.
- **The byte table at `hunk+0x30a0`**, 96 bytes between the attribute table
  and the renderer's amplitude table, in nibble-pair-looking values.
- **The mouth-shape stream** (`mouth_rb`), whose width/height nibbles are at
  `hunk+0x5798`. `CMD_READ` is the other half and the rig does not issue one.
- Whether the parameter sweep's one-axis-at-a-time grid hides anything. A
  difference that needs two extremes at once would not show up.
