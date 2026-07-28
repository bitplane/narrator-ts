"""A fake audio.device that records what it is asked to play.

`narrator.device` is an ordinary audio.device client: it renders formant
samples into buffers and hands them to Paula through CMD_WRITE. Emulating
Paula itself would be pointless — the samples are already the thing we want,
and the DMA hardware only decides when they are heard. So this device captures
every write with the parameters that give it meaning (period, volume, channel)
and completes it.

That makes the capture *Paula-native*: 8-bit signed samples plus a period,
which is what the real chip consumes and what the TypeScript library takes as
its primitive. Resampling is a decision for the consumer, not for the rig.

Anything asked of it that is not understood raises by name, so an unhandled
audio command can never quietly turn into silence.
"""
from m68k import A1, D0
from tasks import (IO_COMMAND, IO_ERROR, IO_FLAGS, IO_UNIT, IOF_QUICK,
                   LN_TYPE, MN_REPLYPORT, NT_REPLYMSG)

# devices/audio.h. Most ADCMD_* continue from CMD_NONSTD (9), but
# ADCMD_ALLOCATE sits apart at 0x20 — it is the one command that may be issued
# before a unit exists, so it could not share the numbering.
CMD_RESET, CMD_READ, CMD_WRITE, CMD_UPDATE = 1, 2, 3, 4
CMD_CLEAR, CMD_STOP, CMD_START, CMD_FLUSH = 5, 6, 7, 8
CMD_NONSTD = 9
ADCMD_FREE, ADCMD_SETPREC, ADCMD_FINISH = CMD_NONSTD + 0, CMD_NONSTD + 1, CMD_NONSTD + 2
ADCMD_PERVOL, ADCMD_LOCK, ADCMD_WAITCYCLE = CMD_NONSTD + 3, CMD_NONSTD + 4, CMD_NONSTD + 5
ADCMD_ALLOCATE = 0x20

NAMES = {
    CMD_RESET: 'CMD_RESET', CMD_READ: 'CMD_READ', CMD_WRITE: 'CMD_WRITE',
    CMD_UPDATE: 'CMD_UPDATE', CMD_CLEAR: 'CMD_CLEAR', CMD_STOP: 'CMD_STOP',
    CMD_START: 'CMD_START', CMD_FLUSH: 'CMD_FLUSH',
    ADCMD_ALLOCATE: 'ADCMD_ALLOCATE', ADCMD_FREE: 'ADCMD_FREE',
    ADCMD_SETPREC: 'ADCMD_SETPREC', ADCMD_FINISH: 'ADCMD_FINISH',
    ADCMD_PERVOL: 'ADCMD_PERVOL', ADCMD_LOCK: 'ADCMD_LOCK',
    ADCMD_WAITCYCLE: 'ADCMD_WAITCYCLE',
}

# struct IOAudio, past the 32-byte IORequest. The 68-byte total matches the
# stride of the request array narrator.device 33.2 walks at hunk+0x56ea.
IOA_ALLOCKEY, IOA_DATA, IOA_LENGTH = 32, 34, 38
IOA_PERIOD, IOA_VOLUME, IOA_CYCLES = 42, 44, 46
IOA_SIZE = 68

# The Amiga's audio clock. PAL; a period of 1 would play this many samples a
# second, so the true rate of a write is CLOCK / period.
PAL_CLOCK = 3546895
NTSC_CLOCK = 3579545


class AudioError(RuntimeError):
    pass


class Write:
    """One CMD_WRITE, kept as Paula would receive it."""

    __slots__ = ('channel', 'samples', 'period', 'volume', 'cycles', 'seq')

    def __init__(self, channel, samples, period, volume, cycles, seq):
        self.channel = channel
        self.samples = samples          # bytes, 8-bit signed
        self.period = period
        self.volume = volume
        self.cycles = cycles
        self.seq = seq

    @property
    def rate(self):
        return PAL_CLOCK / self.period if self.period else 0.0

    def __repr__(self):
        return (f'<Write ch{self.channel} {len(self.samples)} samples '
                f'period {self.period} ({self.rate:.0f} Hz) vol {self.volume}>')


class FakeAudio:
    """audio.device: allocates channels, records writes, completes them."""

    def __init__(self, machine, clock=PAL_CLOCK):
        self.m = machine
        self.clock = clock
        self.writes = []
        self.commands = []              # (name, unit) in order, for the trace
        self.allocated = 0              # channel mask currently handed out
        self._seq = 0

        vectors = {lvo: (name, self._entry(name, fn)) for lvo, (name, fn) in {
            6: ('Open', self._open), 12: ('Close', self._close),
            18: ('Expunge', self._expunge), 24: ('Reserved', self._null),
            30: ('BeginIO', self._begin_io), 36: ('AbortIO', self._abort_io),
        }.items()}
        self.base = machine.make_library('audio.device', vectors)
        machine.cpu.w8(self.base + 8, 3)            # LN_TYPE = NT_DEVICE
        name = machine.alloc(16, 'audio.device name')
        machine.cpu.write(name, b'audio.device\0')
        machine.cpu.w32(self.base + 10, name)       # LN_NAME
        machine.cpu.w16(self.base + 20, 33)         # LIB_VERSION
        machine.devices['audio.device'] = self.base

    def _entry(self, name, fn):
        def handler(cpu):
            fn(cpu)
        handler.__name__ = f'audio.{name}'
        return handler

    # ------------------------------------------------------------- plumbing
    def _null(self, cpu):
        cpu.set(D0, 0)

    def _expunge(self, cpu):
        cpu.set(D0, 0)

    def _open(self, cpu):
        """Open(ioReq A1, unit D0, flags D1). Channel allocation happens here.

        A caller asks for channels by pointing ioa_Data at a list of allowed
        combinations and ioa_Length at its size; the device picks one that is
        free. With nothing else running, the first entry always is.
        """
        ioreq, cpu_ = cpu.get(A1), self.m.cpu
        length = cpu_.r32(ioreq + IOA_LENGTH)
        data = cpu_.r32(ioreq + IOA_DATA)
        if data and length:
            mask = cpu_.r8(data)
        else:
            # No allocation list: exec's audio.device leaves the unit alone and
            # the caller drives channels itself.
            mask = 0
        self.allocated |= mask
        cpu_.w32(ioreq + IO_UNIT, mask)
        cpu_.w16(ioreq + IOA_ALLOCKEY, 1)
        cpu_.w8(ioreq + IO_ERROR, 0)
        self.commands.append(('Open', mask))
        cpu.set(D0, 0)

    def _close(self, cpu):
        self.commands.append(('Close', 0))
        cpu.set(D0, 0)

    def _abort_io(self, cpu):
        self.commands.append(('AbortIO', 0))
        cpu.set(D0, 0)

    def _reply(self, cpu, ioreq, error=0):
        """Complete a request the asynchronous way.

        Always asynchronous, never IOF_QUICK: a caller that uses SendIO and
        WaitIO expects to find the request on its reply port, and one that uses
        DoIO copes with either. Doing it one way keeps the rig honest about
        which path the device actually takes.
        """
        cpu_ = self.m.cpu
        cpu_.w8(ioreq + IO_ERROR, error)
        cpu_.w8(ioreq + IO_FLAGS, cpu_.r8(ioreq + IO_FLAGS) & ~IOF_QUICK)
        cpu_.w8(ioreq + LN_TYPE, NT_REPLYMSG)
        reply = cpu_.r32(ioreq + MN_REPLYPORT)
        if reply:
            self.m.port(reply).put(ioreq)
        cpu.set(D0, error)

    # ------------------------------------------------------------- the work
    def _begin_io(self, cpu):
        ioreq, cpu_ = cpu.get(A1), self.m.cpu
        cmd = cpu_.r16(ioreq + IO_COMMAND)
        unit = cpu_.r32(ioreq + IO_UNIT)
        self.commands.append((NAMES.get(cmd, f'#{cmd}'), unit))

        if cmd == CMD_WRITE:
            n = cpu_.r32(ioreq + IOA_LENGTH)
            data = cpu_.r32(ioreq + IOA_DATA)
            self._seq += 1
            self.writes.append(Write(
                channel=unit,
                samples=cpu_.read(data, n) if data and n else b'',
                period=cpu_.r16(ioreq + IOA_PERIOD),
                volume=cpu_.r16(ioreq + IOA_VOLUME),
                cycles=cpu_.r16(ioreq + IOA_CYCLES),
                seq=self._seq))
            self._reply(cpu, ioreq)
            return

        if cmd in (ADCMD_ALLOCATE, ADCMD_LOCK):
            data = cpu_.r32(ioreq + IOA_DATA)
            length = cpu_.r32(ioreq + IOA_LENGTH)
            mask = cpu_.r8(data) if data and length else unit
            self.allocated |= mask
            cpu_.w32(ioreq + IO_UNIT, mask)
            cpu_.w16(ioreq + IOA_ALLOCKEY, 1)
            self._reply(cpu, ioreq)
            return

        if cmd == ADCMD_FREE:
            self.allocated &= ~unit
            self._reply(cpu, ioreq)
            return

        # Everything else is a control command with no state we model: the
        # samples are already captured, so stopping and starting a channel that
        # never actually plays is a no-op with a well-defined answer.
        if cmd in (CMD_RESET, CMD_UPDATE, CMD_CLEAR, CMD_STOP, CMD_START,
                   CMD_FLUSH, ADCMD_SETPREC, ADCMD_FINISH, ADCMD_PERVOL,
                   ADCMD_WAITCYCLE):
            self._reply(cpu, ioreq)
            return

        raise AudioError(f'audio.device: unhandled command {cmd} '
                         f'({NAMES.get(cmd, "unknown")}) on request {ioreq:#x}')

    # -------------------------------------------------------------- capture
    def pcm(self, channel=None):
        """The captured samples in write order, as one signed byte string."""
        return b''.join(w.samples for w in self.writes
                        if channel is None or w.channel & channel)

    def periods(self):
        return sorted({w.period for w in self.writes})

    def summary(self):
        if not self.writes:
            return 'no audio written'
        total = sum(len(w.samples) for w in self.writes)
        p = self.periods()
        rate = self.clock / p[0] if p and p[0] else 0
        return (f'{len(self.writes)} writes, {total} samples, '
                f'period(s) {p} -> {rate:.0f} Hz, '
                f'channels {sorted({w.channel for w in self.writes})}')
