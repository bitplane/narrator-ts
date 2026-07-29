#!/usr/bin/env python3
"""Drive the real narrator.device under emulation.

Unlike translator.library, this is not a routine you can call. Its init builds
a server task and `BeginIO` only posts a message to it, so speaking happens in
the window where the caller sits blocked in `WaitIO` — which is why the rig has
a scheduler (tasks.py) and a fake audio.device (audiodev.py).

    narrator.py -p '/HEH4LOW WER4LD' -o hello.wav
    narrator.py -t 'hello world'                  # via translator.library
    narrator.py -p '/HEH4LOW' --sex 1 --rate 200 --json

Output is Paula-native: 8-bit signed samples and the period they were written
with. The WAV is a convenience, and the period decides its sample rate.
"""
import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from amiga import AmigaError, Machine, load_binary       # noqa: E402
from audiodev import FakeAudio, PAL_CLOCK                # noqa: E402
from m68k import A0, A1, A6, D0, D1                      # noqa: E402
from tasks import (IO_COMMAND, IO_ERROR, MN_REPLYPORT,   # noqa: E402
                   MP_MSGLIST, MP_SIGBIT, MP_SIGTASK, NT_MSGPORT)

DEFAULT_DEV = 'fixtures/amiga/narrator_device-33.2-1e9f46e0.bin'

# struct narrator_rb, from devices/narrator.h: an IOStdReq (48 bytes) with the
# speech parameters bolted on.
NR_RATE, NR_PITCH, NR_MODE, NR_SEX = 48, 50, 52, 54
NR_CHMASKS, NR_NMMASKS, NR_VOLUME, NR_SAMPFREQ = 56, 60, 62, 64
NR_MOUTHS, NR_CHANMASK, NR_NUMCHAN = 66, 67, 68
NR_SIZE = 70

# IOStdReq, past the IORequest.
IO_ACTUAL, IO_LENGTH, IO_DATA, IO_OFFSET = 32, 36, 40, 44

# The device's own defaults, as documented for narrator.device.
DEFAULTS = {'rate': 150, 'pitch': 110, 'mode': 0, 'sex': 0,
            'volume': 64, 'sampfreq': 22200}

# Left/right channel pairs, the allocation list every narrator example uses.
CHANNEL_MASKS = bytes([3, 5, 10, 12])

# The phoneme input buffer. Cleared per utterance; see say().
INBUF = 4096


class Narrator:
    def __init__(self, path=DEFAULT_DEV, translator=None):
        self.m = Machine()
        self.execlib = self.m.install_exec()
        self.audio = FakeAudio(self.m)
        self.hunks = self.m.load_hunks(load_binary(path), 'narrator')
        self.convention, self.base = self._bring_up()
        self.translator = translator

        self.req = self.m.alloc(NR_SIZE, 'narrator_rb')
        self.reply = self._make_port('narrator-reply')
        self.masks = self.m.alloc(len(CHANNEL_MASKS), 'ch_masks')
        self.m.cpu.write(self.masks, CHANNEL_MASKS)
        self.inbuf = self.m.alloc(INBUF, 'phonemes')

    def _bring_up(self):
        """Three conventions, none of which can be assumed from the version.

        1.6 to 36.9 carry no RomTag at all: the loaded segment's entry point is
        itself the initialiser. 37.7 has one, but with flags 0x00 — a resident
        that is *not* RTF_AUTOINIT, so rt_Init is a routine to call rather than
        a table to read. Both end the same way, by calling AddDevice, so the
        base is taken from that rather than from a return value: 33.2 returns
        -1, exactly as its translator.library sibling does.
        """
        try:
            resident = self.m.find_resident(self.hunks)
        except AmigaError:
            resident = None

        if resident is not None and resident['flags'] & 0x80:
            info = self.m.autoinit_vectors(resident)
            base = self.m.alloc(max(info['data_size'], 64), 'narrator-base')
            for i, vec in enumerate(info['vectors']):
                self.m.cpu.w16(base - 6 * (i + 1), 0x4EF9)
                self.m.cpu.w32(base - 6 * (i + 1) + 2, vec)
            if info['init_fn']:
                self.m.call(info['init_fn'],
                            d={D0: base}, a={A0: 0, A6: self.execlib.base})
            self.m.devices['narrator.device'] = base
            return f"autoinit resident v{resident['version']}", base

        entry = resident['init'] if resident is not None else self.hunks[0].addr
        how = (f"resident v{resident['version']}" if resident is not None
               else 'segment-init')
        self.m.call(entry, d={D0: 0}, a={A0: self.hunks[0].addr,
                                         A6: self.execlib.base})
        bases = [b for kind, b in self.execlib.added if kind == 'device']
        if not bases:
            raise RuntimeError(f'{how}: init never called AddDevice')
        # 36.9 and 37.7 never fill in LN_NAME, so AddDevice could not register
        # them. We know what we loaded; say so, rather than leaving OpenDevice
        # unable to find a device that is plainly there.
        self.m.devices.setdefault('narrator.device', bases[-1])
        return how, bases[-1]

    def _make_port(self, label):
        """A reply port owned by the host task."""
        port = self.m.alloc(34, label)
        cpu = self.m.cpu
        cpu.w8(port + 8, NT_MSGPORT)
        bit = self.m.sched.alloc_signal(self.m.host_task, -1)
        cpu.w8(port + MP_SIGBIT, bit)
        cpu.w32(port + MP_SIGTASK, self.m.host_task.node)
        cpu.w32(port + MP_MSGLIST, port + MP_MSGLIST + 4)      # NewList
        cpu.w32(port + MP_MSGLIST + 8, port + MP_MSGLIST)
        self.m.port(port)
        return port

    # ------------------------------------------------------------- speaking
    def open(self):
        cpu = self.m.cpu
        cpu.clear(self.req, NR_SIZE)
        cpu.w32(self.req + MN_REPLYPORT, self.reply)
        cpu.w16(self.req + 18, NR_SIZE)                        # mn_Length
        cpu.w32(self.req + NR_CHMASKS, self.masks)
        cpu.w16(self.req + NR_NMMASKS, len(CHANNEL_MASKS))
        name = self.m.alloc(24, 'narrator.device name')
        cpu.write(name, b'narrator.device\0')
        err = self.m.call(self.m.execlib.base - 444 + 0, d={D0: 0, D1: 0},
                          a={A0: name, A1: self.req, A6: self.execlib.base})
        return err

    def say(self, phonemes, max_cycles=200_000_000, trailing=b'', **params):
        """CMD_WRITE the phoneme string and return the captured audio.

        `max_cycles` matters because some inputs do not come back: a lone `LX`,
        `NH` or `RX` sends 1.6 through 36.9 off to address zero. That is the
        device's own bug, reproduced rather than papered over — see
        research/02-narrator.md — so the caller needs a way to bound it.
        """
        cpu = self.m.cpu
        opts = dict(DEFAULTS, **{k: v for k, v in params.items() if v is not None})
        raw = phonemes.encode('latin-1', 'replace')
        # Wipe the whole buffer, not just terminate the string. The device
        # reads past io_Length — 1.6 by two bytes, 37.7 by one, 33.2 by none —
        # so leftovers from the previous utterance are live input. That is the
        # device's behaviour and is measured deliberately elsewhere; here it
        # would only make a corpus depend on the order it was run in.
        # `trailing` replaces the terminator with chosen bytes, starting
        # exactly at io_Length — which is how the over-read is measured
        # (tools/narrator-survey.py). By default it is just a NUL.
        cpu.clear(self.inbuf, INBUF)
        cpu.write(self.inbuf, raw + (trailing or b'\0'))

        cpu.w16(self.req + IO_COMMAND, 3)                      # CMD_WRITE
        cpu.w8(self.req + IO_ERROR, 0)
        cpu.w32(self.req + IO_DATA, self.inbuf)
        cpu.w32(self.req + IO_LENGTH, len(raw))
        cpu.w16(self.req + NR_RATE, opts['rate'])
        cpu.w16(self.req + NR_PITCH, opts['pitch'])
        cpu.w16(self.req + NR_MODE, opts['mode'])
        cpu.w16(self.req + NR_SEX, opts['sex'])
        cpu.w16(self.req + NR_VOLUME, opts['volume'])
        cpu.w16(self.req + NR_SAMPFREQ, opts['sampfreq'])
        cpu.w32(self.req + NR_CHMASKS, self.masks)
        cpu.w16(self.req + NR_NMMASKS, len(CHANNEL_MASKS))

        before = len(self.audio.writes)
        rc = self.m.call(self.m.execlib.base - 456, a={A1: self.req,
                                                       A6: self.execlib.base},
                         max_cycles=max_cycles)
        err = cpu.r8(self.req + IO_ERROR)
        if err > 127:
            err -= 256
        return {'rc': rc, 'io_Error': err, 'writes': self.audio.writes[before:]}

    def describe(self):
        used = ', '.join(dict.fromkeys(c[0] for c in self.execlib.calls))
        return (f'device base {self.base:#x}, convention {self.convention}\n'
                f'  tasks: {self.m.sched.tasks}\n'
                f'  exec calls so far: {used}')


def digest(writes):
    """A fingerprint of one utterance, as audio.device received it.

    Samples *and* the parameters that give them meaning: two streams with the
    same bytes on different channels, or at a different period, are not the
    same utterance. Hashing rather than storing keeps a survey of thousands of
    phrases small enough to diff; anything that differs can be re-run and
    compared sample by sample.
    """
    h = hashlib.sha256()
    for w in writes:
        h.update(f'{w.channel}:{w.period}:{w.volume}:{w.cycles}:'.encode())
        h.update(w.samples)
    return h.hexdigest()


def run_corpus(device, phrases, params=None, max_cycles=20_000_000, on_error=None):
    """Speak every phrase, yielding one record each.

    A crashing phrase takes the whole machine with it — there is no unwinding
    a 68k that has jumped to address zero — so the machine is rebuilt and the
    run continues. That costs a bring-up per crash, which is why crashes are
    recorded rather than skipped: they are results, and they are rare.
    """
    params = params or {}
    n = Narrator(device)
    if n.open():
        raise RuntimeError(f'{device}: narrator.device refused to open')
    for phrase in phrases:
        try:
            r = n.say(phrase, max_cycles=max_cycles, **params)
            yield {'in': phrase, 'err': r['io_Error'],
                   'writes': len(r['writes']),
                   'samples': sum(len(w.samples) for w in r['writes']),
                   'periods': sorted({w.period for w in r['writes']}),
                   'channels': sorted({w.channel for w in r['writes']}),
                   'sha': digest(r['writes'])}
        except (AmigaError, RuntimeError) as exc:
            if on_error:
                on_error(phrase, exc)
            yield {'in': phrase, 'err': None, 'writes': 0, 'samples': 0,
                   'periods': [], 'channels': [], 'sha': 'crash',
                   'crash': str(exc)[:80]}
            n = Narrator(device)
            n.open()


def write_wav(path, samples, rate):
    """8-bit mono. WAV's 8-bit format is unsigned; Paula's is signed."""
    pcm = bytes((s + 128) & 0xFF for s in samples)
    n = len(pcm)
    hdr = (b'RIFF' + struct.pack('<I', 36 + n) + b'WAVEfmt ' +
           struct.pack('<IHHIIHH', 16, 1, 1, int(rate), int(rate), 1, 8) +
           b'data' + struct.pack('<I', n))
    Path(path).write_bytes(hdr + pcm)


def corpus_mode(args):
    """Speak a whole file, one JSON object per line."""
    lines = [l.rstrip('\n') for l in
             Path(args.file).read_text(encoding='latin-1').splitlines()]
    lines = [l for l in lines if l.strip()]
    params = {k: getattr(args, k) for k in DEFAULTS
              if getattr(args, k) is not None}
    crashes = []
    sink = open(args.out, 'w') if args.out else sys.stdout
    n = 0
    for rec in run_corpus(args.device, lines, params,
                          on_error=lambda p, e: crashes.append(p)):
        sink.write(json.dumps(rec) + '\n')
        n += 1
    if args.out:
        sink.close()
    print(f'{n} phrases -> {args.out or "stdout"}'
          + (f'; {len(crashes)} crashed: {crashes[:5]}' if crashes else ''),
          file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-d', '--device', default=DEFAULT_DEV)
    ap.add_argument('-p', '--phonemes', help='speak a phoneme string directly')
    ap.add_argument('-t', '--text', help='translate first, then speak')
    ap.add_argument('-o', '--out', help='write a WAV here, or JSON lines with -f')
    ap.add_argument('-f', '--file', help='one phoneme string per line')
    ap.add_argument('--json', action='store_true', help='describe the writes')
    for name, default in DEFAULTS.items():
        ap.add_argument(f'--{name}', type=int, help=f'default {default}')
    args = ap.parse_args()

    if args.file:
        return corpus_mode(args)

    phonemes = args.phonemes
    if args.text:
        from translate import Translator
        phonemes, _ = Translator().translate(args.text)
    if not phonemes:
        ap.error('need -p or -t')

    n = Narrator(args.device)
    print(n.describe(), file=sys.stderr)
    err = n.open()
    print(f'OpenDevice -> {err}', file=sys.stderr)
    if err:
        raise SystemExit(f'narrator.device refused to open: {err}')

    result = n.say(phonemes, **{k: getattr(args, k) for k in DEFAULTS})
    print(f'{phonemes!r} -> io_Error {result["io_Error"]}', file=sys.stderr)
    print(n.audio.summary(), file=sys.stderr)

    if args.json:
        print(json.dumps([{'seq': w.seq, 'channel': w.channel,
                           'samples': len(w.samples), 'period': w.period,
                           'volume': w.volume, 'cycles': w.cycles,
                           'rate': round(w.rate)} for w in result['writes']],
                         indent=1))
    if args.out:
        writes = result['writes']
        if not writes:
            raise SystemExit('nothing was written to audio.device')
        # One channel's worth: the device writes the same samples to a left
        # and a right channel, so taking every channel would double them.
        first = writes[0].channel
        pcm = b''.join(w.samples for w in writes if w.channel == first)
        rate = PAL_CLOCK / writes[0].period if writes[0].period else 22200
        write_wav(args.out, [b - 256 if b > 127 else b for b in pcm], rate)
        print(f'wrote {args.out}: {len(pcm)} samples at {rate:.0f} Hz',
              file=sys.stderr)


if __name__ == '__main__':
    main()
