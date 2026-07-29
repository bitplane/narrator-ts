# narrator.device

Offsets are **hunk**-relative (`hunk = file - 0x24`) and cite build 33.2
`1e9f46e0` unless stated otherwise.

This covers bringing the device up and getting audio out of it. The synthesis
pipeline itself — the ~22KB between `hunk+0x36e` and `hunk+0x5230` — is not
disassembled here yet.

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

## Still open

- The synthesis pipeline: `hunk+0x36e` onwards, ~22KB. Nothing here touches it.
- The mouth-shape stream (`mouth_rb`), whose width/height nibbles are at
  `hunk+0x5798`. Not yet captured by the rig at all.
- Whether the parameter sweep's one-axis-at-a-time grid hides anything. A
  difference that needs two extremes at once would not show up.
