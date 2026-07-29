"""Just enough AmigaOS to run narrator.device and translator.library.

This is not an Amiga emulator. It is a load-and-call rig: it loads a hunk
binary, relocates it, and gives the 68k code somewhere to put its feet — a
memory allocator, an exec jump table, and a fake audio.device that records the
PCM it is asked to play instead of playing it.

Everything the Amiga code does that we cannot honour raises rather than
returning a plausible value, because the point of the exercise is to produce
reference output that can be trusted.
"""
import struct
from pathlib import Path

from m68k import Cpu, A0, A1, A6, A7, D0, D1, PC, SR
from tasks import Scheduler, TC_SIZE

# ---------------------------------------------------------------- memory map
HEAP_BASE = 0x00001000
HEAP_END = 0x00D00000
STACK_TOP = 0x00E00000
TRAP_BASE = 0x00F00000
TRAP_SIZE = 0x00010000
TRAP_END = TRAP_BASE + TRAP_SIZE
RAM_SIZE = 0x01000000

RTS = 0x4E75

# hunk block types
HUNK_CODE, HUNK_DATA, HUNK_BSS = 0x3E9, 0x3EA, 0x3EB
HUNK_RELOC32, HUNK_SYMBOL, HUNK_DEBUG, HUNK_END = 0x3EC, 0x3F0, 0x3F1, 0x3F2
HUNK_HEADER = 0x3F3
HUNK_RELOC32SHORT = 0x3FC

RTC_MATCHWORD = 0x4AFC


class AmigaError(RuntimeError):
    pass


class Hunk:
    __slots__ = ('index', 'kind', 'addr', 'size')

    def __init__(self, index, kind, addr, size):
        self.index, self.kind, self.addr, self.size = index, kind, addr, size


# The Musashi core is a process-global singleton — one register file, one RAM,
# shared by every Cpu handle — so a second Machine silently guts the first.
# Left undetected that is the worst kind of bug here: the older Machine goes on
# answering, with another binary's memory underneath it, and the fixtures are
# quietly wrong. So construction retires its predecessor and using a retired
# one raises. Run builds in separate processes to have two at once.
_live = None


class Machine:
    def __init__(self, ram_size=RAM_SIZE, trace=False):
        global _live
        if _live is not None:
            _live.retired = True
        _live = self
        self.retired = False
        self.cpu = Cpu(ram_size)
        self.trace = trace
        self.brk = HEAP_BASE
        self.allocs = {}
        self.traps = {}          # addr -> (name, handler)
        self._next_trap = TRAP_BASE
        self.log = []
        self.unhandled = []
        self.error = None
        # A trap page full of RTS: dispatch happens in the instruction hook,
        # then the RTS at that same address returns to the Amiga caller.
        self.cpu.write(TRAP_BASE, struct.pack('>H', RTS) * (TRAP_SIZE // 2))
        self.cpu.set_traps(TRAP_BASE, TRAP_END, self._on_trap)
        self.finished = False
        self._ret_magic = self.make_trap('<return>', self._on_return)
        self.exec_base = 0
        self.libraries = {}
        self.devices = {}
        # The host-driven context is a task like any other, with a real Task
        # struct, so FindTask has something to return and a device that posts
        # a message back to us resolves to a task the scheduler knows.
        self.fake_task = self.alloc(TC_SIZE, 'host-task')
        self.sched = Scheduler(self)
        self.host_task = self.sched.add_host_task()
        self.host_task.node = self.fake_task
        self.ports = {}          # address -> tasks.Port

    def install_exec(self):
        """Bring up the fake exec.library and publish it at AbsExecBase."""
        from execlib import Exec
        self.execlib = Exec(self)
        self.exec_base = self.execlib.base
        return self.execlib

    # ------------------------------------------------------------ allocation
    def alloc(self, size, label='', clear=True):
        size = (size + 7) & ~7
        addr = self.brk
        if addr + size > HEAP_END:
            raise AmigaError('out of emulated RAM')
        self.brk += size
        if clear:
            self.cpu.clear(addr, size)
        self.allocs[addr] = (size, label)
        return addr

    # ----------------------------------------------------------------- traps
    def make_trap(self, name, handler):
        """Reserve one address in the RTS page and bind a host handler to it."""
        addr = self._next_trap
        self._next_trap += 2
        if self._next_trap >= TRAP_END:
            raise AmigaError('trap page exhausted')
        self.traps[addr] = (name, handler)
        return addr

    def _on_trap(self, pc):
        entry = self.traps.get(pc)
        if entry is None:
            self.unhandled.append(pc)
            self.cpu.stop()
            return
        name, handler = entry
        if self.trace:
            self.log.append((name, self.cpu.get(D0), self.cpu.get(A0)))
        # ctypes prints and swallows exceptions raised inside a callback, so
        # letting one escape here would leave the CPU running past a call we
        # could not honour — the machine would keep going and produce
        # confident nonsense. Capture it, halt, and re-raise from call().
        try:
            handler(self.cpu)
        except BaseException as exc:      # noqa: BLE001 — deliberately everything
            self.error = exc
            self.cpu.stop()

    def _on_return(self, cpu):
        self.finished = True
        cpu.stop()

    def tail_call(self, addr, d=None, a=None):
        """Divert the trap's own RTS into `addr`, from inside a trap handler.

        Re-entering m68k_execute here would corrupt the core's state, so
        instead we push `addr` beneath the pending return address: the RTS at
        the trap site pops it and jumps to the callee, and the callee's own RTS
        then pops the original return address. The callee's D0 therefore
        becomes the trap's return value for free, which is exactly the
        contract MakeLibrary/init already has.
        """
        cpu = self.cpu
        sp = (cpu.get(A7) - 4) & 0xFFFFFFFF
        cpu.set(A7, sp)
        cpu.w32(sp, addr)
        for i, v in (d or {}).items():
            cpu.set(i, v)
        for i, v in (a or {}).items():
            cpu.set(i, v)

    def chain(self, *addrs):
        """Run `addrs` in order when the trap returns, then the real caller.

        `tail_call` diverts into one routine; this stacks several, so a handler
        can regain control *after* an Amiga routine it invoked. DoIO needs
        exactly that: call the device's BeginIO, then decide whether to wait.
        """
        for addr in reversed(addrs):
            self.tail_call(addr)

    def readable(self, addr):
        """Is `addr` somewhere the rig may safely peek at, host-side?

        The bad-access counter exists to catch the *Amiga* code reaching
        outside RAM. A Python-side read through a pointer that turns out to be
        junk would trip it too and be reported as an emulation fault, which is
        both wrong and very confusing — so bookkeeping asks first.
        """
        return HEAP_BASE <= addr < self.brk

    def port(self, addr):
        """The Port for a MsgPort address, remembering it on first sight.

        Devices initialise their ports by hand rather than through AddPort —
        narrator.device 33.2 does it at hunk+0x64 — so a port has to be
        adopted whenever one turns up rather than only when it is announced.
        """
        from tasks import Port
        p = self.ports.get(addr)
        if p is None:
            p = self.ports[addr] = Port(addr, self.sched, self.cpu)
        return p

    # ------------------------------------------------------------- libraries
    def make_library(self, name, vectors, extra_neg=0):
        """Build a fake library: negative jump table of 6-byte JMP.L stubs.

        `vectors` maps LVO (a positive offset, e.g. 30 for -30) to (name, handler).
        Returns the library base address.
        """
        neg = max(list(vectors) + [extra_neg, 6]) + 6
        neg = (neg + 7) & ~7
        block = self.alloc(neg + 256, f'lib:{name}')
        base = block + neg
        for lvo, (fname, handler) in vectors.items():
            target = self.make_trap(f'{name}.{fname}', handler)
            # JMP.L target  =  0x4EF9 <32-bit absolute>
            self.cpu.w16(base - lvo, 0x4EF9)
            self.cpu.w32(base - lvo + 2, target)
        self.libraries[name] = base
        return base

    # ------------------------------------------------------------ hunk loader
    def load_hunks(self, data, label='hunks'):
        """Load and relocate an Amiga hunk executable. Returns [Hunk]."""
        if len(data) < 8 or struct.unpack('>I', data[:4])[0] != HUNK_HEADER:
            raise AmigaError('not a hunk executable')
        o = 4
        # resident library name list, normally empty
        while True:
            n = struct.unpack('>I', data[o:o + 4])[0]
            o += 4
            if n == 0:
                break
            o += n * 4
        table_size, first, last = struct.unpack('>III', data[o:o + 12])
        o += 12
        sizes = []
        for _ in range(last - first + 1):
            raw = struct.unpack('>I', data[o:o + 4])[0]
            o += 4
            sizes.append((raw & 0x3FFFFFFF) * 4)

        hunks = []
        for i, sz in enumerate(sizes):
            addr = self.alloc(max(sz, 4), f'{label}#{i}')
            hunks.append(Hunk(i, None, addr, sz))

        idx = 0
        while o < len(data) and idx < len(hunks):
            (blk,) = struct.unpack('>I', data[o:o + 4])
            o += 4
            blk &= 0x3FFFFFFF
            h = hunks[idx]
            if blk in (HUNK_CODE, HUNK_DATA):
                (nlongs,) = struct.unpack('>I', data[o:o + 4])
                o += 4
                nbytes = nlongs * 4
                h.kind = 'code' if blk == HUNK_CODE else 'data'
                self.cpu.write(h.addr, data[o:o + nbytes])
                o += nbytes
            elif blk == HUNK_BSS:
                (nlongs,) = struct.unpack('>I', data[o:o + 4])
                o += 4
                h.kind = 'bss'
                self.cpu.clear(h.addr, nlongs * 4)
            elif blk == HUNK_RELOC32:
                while True:
                    (count,) = struct.unpack('>I', data[o:o + 4])
                    o += 4
                    if count == 0:
                        break
                    (target,) = struct.unpack('>I', data[o:o + 4])
                    o += 4
                    for _ in range(count):
                        (off,) = struct.unpack('>I', data[o:o + 4])
                        o += 4
                        cur = self.cpu.r32(h.addr + off)
                        self.cpu.w32(h.addr + off, (cur + hunks[target].addr) & 0xFFFFFFFF)
            elif blk == HUNK_RELOC32SHORT:
                while True:
                    (count,) = struct.unpack('>H', data[o:o + 2])
                    o += 2
                    if count == 0:
                        break
                    (target,) = struct.unpack('>H', data[o:o + 2])
                    o += 2
                    for _ in range(count):
                        (off,) = struct.unpack('>H', data[o:o + 2])
                        o += 2
                        cur = self.cpu.r32(h.addr + off)
                        self.cpu.w32(h.addr + off, (cur + hunks[target].addr) & 0xFFFFFFFF)
                if o & 2:
                    o += 2
            elif blk in (HUNK_SYMBOL, HUNK_DEBUG):
                if blk == HUNK_SYMBOL:
                    while True:
                        (n,) = struct.unpack('>I', data[o:o + 4])
                        o += 4
                        if n == 0:
                            break
                        o += n * 4 + 4
                else:
                    (n,) = struct.unpack('>I', data[o:o + 4])
                    o += 4 + n * 4
            elif blk == HUNK_END:
                idx += 1
            else:
                raise AmigaError(f'unhandled hunk block {blk:#x} at {o - 4:#x}')
        return hunks

    # ------------------------------------------------------------- residents
    def find_resident(self, hunks):
        """Locate the RomTag and decode it. Static parse — nothing is executed."""
        for h in hunks:
            if not h.size:
                continue
            blob = self.cpu.read(h.addr, h.size)
            pos = 0
            while True:
                i = blob.find(b'\x4a\xfc', pos)
                if i < 0:
                    break
                addr = h.addr + i
                match_tag = self.cpu.r32(addr + 2)
                if match_tag == addr:          # rt_MatchTag points at itself
                    return {
                        'addr': addr,
                        'end_skip': self.cpu.r32(addr + 6),
                        'flags': self.cpu.r8(addr + 10),
                        'version': self.cpu.r8(addr + 11),
                        'type': self.cpu.r8(addr + 12),
                        'pri': self.cpu.r8(addr + 13),
                        'name': self.cpu.cstr(self.cpu.r32(addr + 14)).decode('latin-1'),
                        'id': self.cpu.cstr(self.cpu.r32(addr + 18)).decode('latin-1'),
                        'init': self.cpu.r32(addr + 22),
                    }
                pos = i + 2
        raise AmigaError('no RomTag found')

    def autoinit_vectors(self, resident):
        """RTF_AUTOINIT (0x80): rt_Init points at {dataSize, vectors, struct, fn}.

        The vector table is either an array of 32-bit absolute addresses
        terminated by -1, or (when the first word is 0xFFFF) 16-bit offsets
        relative to the table itself.
        """
        if not resident['flags'] & 0x80:
            raise AmigaError('library is not RTF_AUTOINIT; needs real init')
        t = resident['init']
        data_size = self.cpu.r32(t)
        vec = self.cpu.r32(t + 4)
        init_struct = self.cpu.r32(t + 8)
        init_fn = self.cpu.r32(t + 12)
        out = []
        if self.cpu.r16(vec) == 0xFFFF:
            p = vec + 2
            while True:
                off = self.cpu.r16(p)
                if off == 0xFFFF:
                    break
                out.append((vec + struct.unpack('>h', struct.pack('>H', off))[0]) & 0xFFFFFFFF)
                p += 2
        else:
            p = vec
            while True:
                a = self.cpu.r32(p)
                if a == 0xFFFFFFFF:
                    break
                out.append(a)
                p += 4
        return {'data_size': data_size, 'vectors': out,
                'init_struct': init_struct, 'init_fn': init_fn}

    # ------------------------------------------------------------- execution
    def call(self, addr, d=None, a=None, max_cycles=200_000_000):
        """Call an Amiga routine on the host task, running until it returns.

        Other tasks run too, whenever this one blocks — a device's server task
        does all its work in the window where the caller is sitting in WaitIO.
        """
        if self.retired:
            raise AmigaError(
                'this Machine was retired when a later one was built — the 68k '
                'core is process-global. Use one Machine at a time, or run each '
                'binary in its own process.')
        cpu = self.cpu
        self.sched.restore(self.host_task)
        cpu.set(SR, 0x0000)               # user mode, interrupts enabled
        cpu.set(A7, STACK_TOP)
        for i, v in (d or {}).items():
            cpu.set(i, v)
        for i, v in (a or {}).items():
            cpu.set(i, v)
        cpu.push32(self._ret_magic)       # so the final RTS lands in our trap page
        cpu.set(PC, addr)
        self.finished = False
        self.error = None
        cpu.clear_bad()
        spent = 0
        while not self.finished and spent < max_cycles:
            spent += cpu.execute(100_000)
            if self.error is not None:
                err, self.error = self.error, None
                raise err
            if self.unhandled:
                raise AmigaError(f'jumped into unbound trap {self.unhandled[-1]:#x}')
            if self.sched.switch_pending:
                self.sched.switch_pending = False
                self.sched.switch()
        if not self.finished:
            raise AmigaError(f'routine did not return within {max_cycles} cycles')
        # Only the host task can reach the sentinel, so it is necessarily the
        # current one here and D0 below is its own.
        n, first = cpu.bad()
        if n:
            raise AmigaError(f'{n} access(es) outside RAM, first at {first:#x}')
        return cpu.get(D0)


def load_binary(path):
    return Path(path).read_bytes()
