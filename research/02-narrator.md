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

## Still open

- **How phonemes become frames** — the duration model, and how `rate` and
  stress scale it. The routines are identified; their contents are not. This is
  the whole front half of the synthesizer.
- **The mouth-shape stream** (`mouth_rb`), whose width/height nibbles are at
  `hunk+0x5798`. `CMD_READ` is the other half and the rig does not issue one.
- Whether the parameter sweep's one-axis-at-a-time grid hides anything. A
  difference that needs two extremes at once would not show up.
