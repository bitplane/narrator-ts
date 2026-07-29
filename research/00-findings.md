# What we know about the binaries

Every claim here cites an offset in a named build so it can be rechecked.
Builds are identified by version and the first 8 hex of their sha256, matching
the filenames written by `tools/extract-devices.py` into `fixtures/amiga/`.

## Available builds

Harvested from 222 Workbench disk images (`/home/gaz/Documents/amiga/workbench`),
deduped by sha256 — 12 distinct builds:

| file | version | date | size | disks |
|---|---|---|---|---|
| narrator.device | 1.6 | 10 Sep 1985 | 23152 | 4 |
| narrator.device | 31.13 | 23 Nov 1985 | 23280 | 5 |
| **narrator.device** | **33.2** | **5 Mar 1986** | **23280** | **28** |
| narrator.device | 36.9 | 17 May 1989 | 23136 | 2 |
| narrator.device | 37.7 | 22 May 1991 | 65760 | 10 |
| translator.library | 1.3 | 4 Sep 1985 | 10564 | 4 |
| translator.library | 31.7 | 23 Nov 1985 | 10592 | 4 |
| **translator.library** | **33.2** | **24 Jun 1986** | **10592** | **21** |
| translator.library | 34.3 | 24 Jun 1990 | 10584 | 7 |
| translator.library | 36.1 | 24 May 1989 | 10580 | 2 |
| translator.library | 37.1 | 15.1.91 | 10524 | 10 |

Two "33.2" translator builds appeared (`11997e3c`, `46e0a21e`), same version
string, different bytes. **`46e0a21e` is a corrupt dump, not a variant.** Its
rule region (`0x800`-`0x1128`) is 0% printable where the good build's is 100% —
zeroed sectors. It came from a single disk against 20 for the good copy. It is
excluded, and both `extract-rules.py` and the oracle reject it by signature
rather than by name.

**First target: 33.2 for both** — the Amiga 500 / Workbench 1.2-1.3 voice and
the most widely shipped build of the pair. The library covers every version,
though; see `01-translator.md` for how few distinct *behaviours* those builds
actually amount to.

## narrator.device 33.2 (`1e9f46e0`)

Amiga hunk executable, `HUNK_HEADER` `0x3f3`, three hunks sized
`0x1624 / 0 / 0` longwords — i.e. one 22,672-byte code+data hunk and two empty
(BSS) hunks.

Authorship, and why it matters:

- `0xaf1` — `MARK BARTON`
- `0xaff` — `JOSEPH KATZ`

Mark Barton wrote Software Automatic Mouth (SAM) for the C64/Apple II, which
has been thoroughly reverse-engineered. The Amiga narrator is by the same
hand, and the family resemblance is visible in the data:

- `0xec2` — phoneme name table, two bytes per entry, in recognisably SAM order:
  `IY IH EH AE AA AH AO UH AX IX ER UX QX OH RX LX EY AY OY AW OW UW WH R L W
  Y M N NX NH DX Q S SH F TH Z ZH V DH CH J /H /M /B /R /C B D G GX GH P T K
  KX KH`, then `UL UM UN IL IM IN`, then the stress digits `0`-`9`.
- `0xf70` — `ULUMUNILIMIN`, SAM's syllabic-consonant rewrite set.

**But the constants are not SAM's.** Checked and *not* present anywhere in the
binary: SAM's `freq1data`, `freq2data`, and phoneme-length tables, in whole or
as 15-byte subsequences. The Amiga version was retuned for ~22kHz output
(SAM runs around 4.7kHz) and adds features SAM never had — natural vs robotic
F0 contours, male/female, and per-frame mouth width/height.

So the existing SAM reimplementations are a map of the *algorithm* — reciter →
prep/rewrite → phoneme-to-frame expansion → transition smoothing → cascade
render — and not a source of numbers. Every constant must come out of this
binary.

## File offsets vs hunk offsets

Offsets in this document are **file** offsets unless stated otherwise. The
disassembler (`tools/oracle/disasm.py`) reports **hunk** offsets, because those
are what a runtime address maps back to. For both 33.2 binaries the hunk-0 data
begins at file `0x24`, so:

    hunk_offset = file_offset - 0x24

Verified by locating the first 16 bytes of loaded hunk 0 back in the file.

## translator.library 33.2

Barely a program: roughly 2KB of code around ~8KB of plain-text rule data.

- `0x766` — the NRL wildcard alphabet `#*.$%&@^+:?_ `
- `0x774` — `IHEHAAAEIYAOAHEROHEYAYOYAWOWUW`, a phoneme list used by the rules
- `0x775`(ish) — a 28-entry big-endian offset table (one bucket per letter plus
  punctuation/digits), first entry `0x70`, last `0x1f35`
- `0x801` — the rule text itself, classic NRL/Elovitz letter-to-sound format:

  ```
   [A. ]=EH3Y. \ [A] =AH`[A] =AH\ [ARE] =AAR` [AND] =AEND` [AS] =AEZ`
  [A]DAP=AX\ [AR]O=AXR\[AR]#=EHR\ ^[AS]#=EYS\[A]WA=AX\[AW]=AO\
  ```

The rule *data* therefore extracts wholesale, and only the matcher — a few
hundred bytes of 68k — needs reimplementing. This half can be made byte-exact
cheaply, which is why it goes first: it proves the oracle harness on an easy
target before the harness has to carry the synthesizer.

### Rule table layout

- `0x792` (hunk `0x76e`) — 28 big-endian longword offsets, **relative to the
  start of the offset table itself**. First is `0x70`, which lands exactly at
  the end of the table; last is `0x1f35`. 26 buckets for A-Z plus two more,
  presumably punctuation and digits — not yet confirmed which is which.
- `0x802` onward — the rule text, one bucket per letter.

Rules are pure ASCII; there are **no high-bit-set bytes anywhere in the
region**, so the terminator is not a set-bit marker. Two terminators appear,
`\` (`0x5C`) and `` ` `` (`0x60`). Both end a rule, and the difference is
semantic — it gates the stress pass. Resolved from the disassembly; the full
account is in `01-translator.md`.

### Where Translate lives

Entry point at hunk `0x134`, reached via the library base's `-30` vector.
It builds a 0x86-byte stack frame, zeroes a 27-longword scratch area to spaces
(`move.l #$20202020`), and sets `A4` to a work buffer at hunk `0x642`.

## Version split: why 37.7 is out of scope

`narrator.device` 37.7 (`e28300e0`, 22 May 1991, Kickstart 2.04 / Amiga 500
Plus) carries the same `MARK BARTON` / `JOSEPH KATZ` strings but is a genuine
rewrite:

- 65,760 bytes against 23,280 — nearly 3x
- the SAM-order phoneme name table at `0xec2` is **absent**
- `ULUMUNILIMIN` is **absent**

33.2 and 36.9 (`8956153f`) are the same engine as each other — same table
layout at the same relative offsets, near-identical size. 37.7 is not: it is
a second implementation, and porting it would be starting again.

It is **not a target**. 1.6, 31.13, 33.2 and 36.9 are sample-identical over
4,865 phrases and every parameter extreme, so 33.2 already covers four of the
five shipped builds. The fifth is not worth a second synthesizer.
