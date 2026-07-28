"""A minimal exec.library for the oracle.

Only what the speech binaries actually reach for is implemented. Anything else
raises by name, so the set of requirements is discovered from the code rather
than guessed at in advance — and so an unimplemented call can never quietly
return a plausible zero into reference output.
"""
import struct

from m68k import A0, A1, A2, A3, A6, D0, D1, D2
from tasks import (IO_DEVICE, IO_ERROR, IO_FLAGS, IOF_QUICK, LN_PRI, LN_TYPE,
                   LVO_ABORTIO, LVO_BEGINIO, LVO_CLOSE, LVO_OPEN,
                   MN_REPLYPORT, NT_MESSAGE, NT_MSGPORT, NT_REPLYMSG)

# exec.library LVOs, negative offsets from the library base.
EXEC_LVO = {
    30: 'Supervisor', 72: 'InitCode', 78: 'InitStruct', 84: 'MakeLibrary',
    90: 'MakeFunctions', 96: 'FindResident', 102: 'InitResident', 108: 'Alert',
    114: 'Debug', 120: 'Disable', 126: 'Enable', 132: 'Forbid', 138: 'Permit',
    144: 'SetSR', 150: 'SuperState', 156: 'UserState', 162: 'SetIntVector',
    168: 'AddIntServer', 174: 'RemIntServer', 180: 'Cause', 186: 'Allocate',
    192: 'Deallocate', 198: 'AllocMem', 204: 'AllocAbs', 210: 'FreeMem',
    216: 'AvailMem', 222: 'AllocEntry', 228: 'FreeEntry', 234: 'Insert',
    240: 'AddHead', 246: 'AddTail', 252: 'Remove', 258: 'RemHead',
    264: 'RemTail', 270: 'Enqueue', 276: 'FindName', 282: 'AddTask',
    288: 'RemTask', 294: 'FindTask', 300: 'SetTaskPri', 306: 'SetSignal',
    312: 'SetExcept', 318: 'Wait', 324: 'Signal', 330: 'AllocSignal',
    336: 'FreeSignal', 342: 'AllocTrap', 348: 'FreeTrap', 354: 'AddPort',
    360: 'RemPort', 366: 'PutMsg', 372: 'GetMsg', 378: 'ReplyMsg',
    384: 'WaitPort', 390: 'FindPort', 396: 'AddLibrary', 402: 'RemLibrary',
    408: 'OldOpenLibrary', 414: 'CloseLibrary', 420: 'SetFunction',
    426: 'SumLibrary', 432: 'AddDevice', 438: 'RemDevice', 444: 'OpenDevice',
    450: 'CloseDevice', 456: 'DoIO', 462: 'SendIO', 468: 'CheckIO',
    474: 'WaitIO', 480: 'AbortIO', 486: 'AddResource', 492: 'RemResource',
    498: 'OpenResource', 504: 'RawIOInit', 510: 'RawMayGetChar',
    516: 'RawPutChar', 522: 'RawDoFmt', 528: 'GetCC', 534: 'TypeOfMem',
    540: 'Procure', 546: 'Vacate', 552: 'OpenLibrary', 558: 'InitSemaphore',
    564: 'ObtainSemaphore', 570: 'ReleaseSemaphore', 576: 'AttemptSemaphore',
    582: 'ObtainSemaphoreList', 588: 'ReleaseSemaphoreList',
    594: 'FindSemaphore', 600: 'AddSemaphore', 606: 'RemSemaphore',
    612: 'SumKickData', 618: 'AddMemList', 624: 'CopyMem', 630: 'CopyMemQuick',
    636: 'CacheClearU', 642: 'CacheClearE', 648: 'CacheControl',
    654: 'CreateIORequest', 660: 'DeleteIORequest', 666: 'CreateMsgPort',
    672: 'DeleteMsgPort', 678: 'ObtainSemaphoreShared', 684: 'AllocVec',
    690: 'FreeVec',
}

JMP_L = 0x4EF9

# MEMF_CLEAR
MEMF_CLEAR = 1 << 16


class ExecError(RuntimeError):
    pass


class Exec:
    """Builds the fake ExecBase and implements the calls the binaries make."""

    def __init__(self, machine):
        self.m = machine
        self.calls = []            # (name, d0, d1, a0, a1) for every call made
        self.libs_made = []
        self.added = []            # ('library'|'device', base) as they register
        # The trap every device call returns through, made on demand. What
        # each call is waiting for lives on the Task, not here: they nest.
        self._after = None
        vectors = {}
        for lvo, name in EXEC_LVO.items():
            impl = getattr(self, f'_{name}', None)
            vectors[lvo] = (name, self._wrap(name, impl))
        # ExecBase needs enough positive space for LIB_ + ExecBase fields;
        # 0x200 covers everything up to ex_MemHandlers.
        self.base = machine.make_library('exec.library', vectors, extra_neg=696)
        machine.cpu.w32(4, self.base)      # AbsExecBase
        # LN_TYPE = NT_LIBRARY(9), LIB_VERSION = 33
        machine.cpu.w8(self.base + 8, 9)
        machine.cpu.w16(self.base + 20, 33)
        # SoftVer/attnFlags left zero: a 68000 with no coprocessors, which is
        # what an A500 running this narrator actually is.

    def _wrap(self, name, impl):
        def handler(cpu):
            self.calls.append((name, cpu.get(D0), cpu.get(D1), cpu.get(A0), cpu.get(A1)))
            if impl is None:
                raise ExecError(f'exec.{name} called but not implemented')
            impl(cpu)
        return handler

    # ------------------------------------------------------------- memory
    def _AllocMem(self, cpu):
        size, flags = cpu.get(D0), cpu.get(D1)
        addr = self.m.alloc(size, f'AllocMem({size})', clear=bool(flags & MEMF_CLEAR))
        cpu.set(D0, addr)

    def _AllocVec(self, cpu):
        size, flags = cpu.get(D0), cpu.get(D1)
        addr = self.m.alloc(size + 8, f'AllocVec({size})', clear=bool(flags & MEMF_CLEAR))
        self.m.cpu.w32(addr, size)
        cpu.set(D0, addr + 8)

    def _FreeMem(self, cpu):
        pass       # the rig is a one-shot; never reclaim, so nothing dangles

    def _FreeVec(self, cpu):
        pass

    def _Allocate(self, cpu):
        size = cpu.get(D0)
        cpu.set(D0, self.m.alloc(size, 'Allocate'))

    def _Deallocate(self, cpu):
        pass

    def _AvailMem(self, cpu):
        cpu.set(D0, 0x00100000)

    def _CopyMem(self, cpu):
        src, dst, n = cpu.get(A0), cpu.get(A1), cpu.get(D0)
        self.m.cpu.write(dst, self.m.cpu.read(src, n))

    _CopyMemQuick = _CopyMem

    # ------------------------------------------------------ scheduling no-ops
    # Forbid/Permit and Disable/Enable bracket critical sections against
    # preemption and interrupts. This scheduler has neither — it only ever
    # switches inside Wait — so honouring them would change nothing.
    def _Forbid(self, cpu): pass
    def _Permit(self, cpu): pass
    def _Disable(self, cpu): pass
    def _Enable(self, cpu): pass
    def _CacheClearU(self, cpu): pass

    # ------------------------------------------------------------ scheduling
    @property
    def sched(self):
        return self.m.sched

    def _FindTask(self, cpu):
        """FindTask(NULL) is "the current task"; by name is not supported."""
        if cpu.get(A1):
            raise ExecError('FindTask by name is not implemented')
        cpu.set(D0, self.sched.current.node)

    def _AddTask(self, cpu):
        """AddTask(task A1, initialPC A2, finalPC A3), then let it start.

        The yield is not decoration. A server task's prologue is what makes its
        port usable — narrator.device's fills in mp_SigTask and mp_SigBit at
        hunk+0x5244 — and on a real machine it has long since run by the time a
        client opens the device. Without the yield, the first BeginIO posts to
        a port that still reads mp_SigTask = 0.
        """
        task = self.sched.add_task(cpu.get(A1), cpu.get(A2), cpu.get(A3))
        cpu.set(D0, task.node)
        self.sched.yield_now(f'AddTask({task.name})')

    def _RemTask(self, cpu):
        node = cpu.get(A1)
        task = self.sched.current if not node else self.sched.find(node)
        if task is not None:
            task.finished = True
        if task is self.sched.current:
            self.sched.block('RemTask')

    def _SetTaskPri(self, cpu):
        """SetTaskPri(task A1, pri D0) -> the old priority.

        Recorded but not acted on: this scheduler is round-robin over whatever
        is runnable, and priority only decides who wins when several are — a
        situation the rig never gets into, since it only ever switches on a
        block. narrator.device raises its server's priority while speaking.
        """
        node = cpu.get(A1) or self.sched.current.node
        old = self.m.cpu.r8(node + LN_PRI)
        self.m.cpu.w8(node + LN_PRI, cpu.get(D0) & 0xFF)
        cpu.set(D0, old - 256 if old > 127 else old)

    def _AllocSignal(self, cpu):
        bit = self.sched.alloc_signal(self.sched.current, cpu.get(D0))
        cpu.set(D0, bit & 0xFFFFFFFF)

    def _FreeSignal(self, cpu):
        self.sched.free_signal(self.sched.current, cpu.get(D0))

    def _SetSignal(self, cpu):
        """SetSignal(newSignals D0, mask D1) -> the old ones."""
        t = self.sched.current
        old, new, mask = t.sigrecvd, cpu.get(D0), cpu.get(D1)
        t.sigrecvd = (old & ~mask | new & mask) & 0xFFFFFFFF
        self.sched._sync(t)
        cpu.set(D0, old)

    def _Signal(self, cpu):
        task = self.sched.find(cpu.get(A1))
        if task is None:
            raise ExecError(f'Signal to unknown task {cpu.get(A1):#x}')
        self.sched.signal(task, cpu.get(D0))

    def _Wait(self, cpu):
        """Wait(mask D0) -> the bits that woke us.

        Blocking leaves the PC on this trap, so the task re-enters here when it
        is next scheduled and the test runs again. See tasks.py.
        """
        got = self.sched.wait(self.sched.current, cpu.get(D0))
        if got is None:
            self.sched.block('Wait')
        else:
            cpu.set(D0, got)

    # ------------------------------------------------------------- lists
    def _AddHead(self, cpu): pass
    def _AddTail(self, cpu): pass
    def _Remove(self, cpu): pass
    def _Enqueue(self, cpu): pass
    def _AddLibrary(self, cpu):
        # The library base arrives in A1. Recording it here is more reliable
        # than trusting the init routine's return value: translator.library
        # 33.2 returns -1, not its base.
        self.added.append(('library', cpu.get(A1)))

    def _AddDevice(self, cpu):
        """AddDevice(device A1). exec only enqueues it; the node may be bare.

        Registering it by its own LIB_NAME is a convenience so that OpenDevice
        can find it, but the name is not always there to be read: 33.2 fills
        the node before calling, while 36.9 and 37.7 leave LN_NAME wild and
        never set it at all. So the pointer is checked before it is followed,
        and the caller registers the name itself when this comes up empty.
        """
        base = cpu.get(A1)
        self.added.append(('device', base))
        name = self.m.cpu.r32(base + 10)
        if self.m.readable(name):
            self.m.devices[self.m.cpu.cstr(name).decode('latin-1')] = base
    def _SumLibrary(self, cpu): pass

    def _FindName(self, cpu):
        cpu.set(D0, 0)

    # ------------------------------------------------------ message passing
    def _AddPort(self, cpu):
        port = cpu.get(A1)
        self.m.cpu.w8(port + LN_TYPE, NT_MSGPORT)
        self.m.port(port)

    def _RemPort(self, cpu):
        self.m.ports.pop(cpu.get(A1), None)

    def _PutMsg(self, cpu):
        """PutMsg(port A0, message A1) — queue it and signal the owner."""
        msg = cpu.get(A1)
        self.m.cpu.w8(msg + LN_TYPE, NT_MESSAGE)
        self.m.port(cpu.get(A0)).put(msg)

    def _GetMsg(self, cpu):
        cpu.set(D0, self.m.port(cpu.get(A0)).get())

    def _ReplyMsg(self, cpu):
        """ReplyMsg(message A1) — back to mn_ReplyPort, or drop it.

        A message with no reply port is legitimate: exec marks it NT_FREEMSG
        and forgets it. Nothing here needs that, but a device may still send
        one, so it must not be an error.
        """
        msg = cpu.get(A1)
        self.m.cpu.w8(msg + LN_TYPE, NT_REPLYMSG)
        reply = self.m.cpu.r32(msg + MN_REPLYPORT)
        if reply:
            self.m.port(reply).put(msg)

    def _WaitPort(self, cpu):
        """WaitPort(port A0) -> the first message, without removing it."""
        port = self.m.port(cpu.get(A0))
        if port.queue:
            cpu.set(D0, port.queue[0])
            return
        got = self.sched.wait(self.sched.current, 1 << port.sigbit)
        if got is None:
            self.sched.block('WaitPort')
        # Woken but the queue is still empty: fall through to block again on
        # the next pass rather than returning a message that is not there.
        elif port.queue:
            cpu.set(D0, port.queue[0])
        else:
            self.sched.block('WaitPort')

    # ------------------------------------------------------------ device I/O
    #
    # A device's own routines want A6 pointing at *their* base, but the caller
    # expects exec to hand its A6 back untouched — the Amiga convention is that
    # only D0/D1/A0/A1 are scratch. Getting that wrong is not subtle in effect
    # and is very subtle to find: narrator.device's server task went on to call
    # FreeMem through the audio device's jump table, landed on padding, and
    # slid through it into address zero.
    #
    # So every device entry goes through _enter_device, which records the
    # caller's A6 and stacks a continuation that restores it. The continuation
    # is also where DoIO does its waiting and OpenDevice reads its result,
    # since both need to run *after* the device routine has returned.

    def _enter_device(self, cpu, fn, base, ioreq, kind=None):
        t = self.sched.current
        t.cont_stack.append([cpu.get(A6), kind, ioreq])
        if self._after is None:
            self._after = self.m.make_trap('exec.<device return>', self._after_device)
        self.m.chain(fn, self._after)
        cpu.set(A6, base)
        cpu.set(A1, ioreq)

    def _after_device(self, cpu):
        t = self.sched.current
        a6, kind, ioreq = t.cont_stack[-1]
        if kind == 'wait':
            cpu.set(A1, ioreq)
            self._WaitIO(cpu)
            if self.sched.switch_pending:
                return          # blocked; we will be re-entered to try again
        elif kind == 'open':
            err = cpu.r8(ioreq + IO_ERROR)
            cpu.set(D0, err - 256 if err > 127 else err)
        t.cont_stack.pop()
        cpu.set(A6, a6)

    def _device_of(self, cpu, what):
        ioreq = cpu.get(A1)
        base = self.m.cpu.r32(ioreq + IO_DEVICE)
        if not base:
            raise ExecError(f'{what} on request {ioreq:#x} with no io_Device')
        return ioreq, base

    def _OpenDevice(self, cpu):
        """OpenDevice(name A0, unit D0, ioReq A1, flags D1) -> error in D0.

        Sets io_Device before calling the device's own Open, as exec does, so
        that Open can find its base. What comes back is io_Error, *not* Open's
        D0 — devices leave all sorts of things there.
        """
        name = self.m.cpu.cstr(cpu.get(A0)).decode('latin-1')
        base = self.m.devices.get(name)
        if base is None:
            raise ExecError(f'OpenDevice({name!r}) but no such device is registered; '
                            f'have {sorted(self.m.devices)}')
        ioreq = cpu.get(A1)
        self.m.cpu.w32(ioreq + IO_DEVICE, base)
        self.m.cpu.w8(ioreq + IO_ERROR, 0)
        self._enter_device(cpu, self.m.cpu.r32(base - LVO_OPEN + 2), base, ioreq, 'open')

    def _CloseDevice(self, cpu):
        ioreq, base = self._device_of(cpu, 'CloseDevice')
        self._enter_device(cpu, self.m.cpu.r32(base - LVO_CLOSE + 2), base, ioreq)

    def _BeginIO(self, cpu):
        """Not an exec call — the device's own, reached through io_Device."""
        ioreq, base = self._device_of(cpu, 'BeginIO')
        self._enter_device(cpu, self.m.cpu.r32(base - LVO_BEGINIO + 2), base, ioreq)

    _SendIO = _BeginIO

    def _AbortIO(self, cpu):
        ioreq, base = self._device_of(cpu, 'AbortIO')
        self._enter_device(cpu, self.m.cpu.r32(base - LVO_ABORTIO + 2), base, ioreq)

    def _DoIO(self, cpu):
        """DoIO(ioReq A1): BeginIO, then wait for it unless it went quick."""
        ioreq, base = self._device_of(cpu, 'DoIO')
        cpu.w8(ioreq + IO_FLAGS, cpu.r8(ioreq + IO_FLAGS) | IOF_QUICK)
        self._enter_device(cpu, self.m.cpu.r32(base - LVO_BEGINIO + 2),
                           base, ioreq, 'wait')

    def _WaitIO(self, cpu):
        """WaitIO(ioReq A1) -> io_Error, once the request comes back.

        A request that completed quickly never reaches a reply port, so the
        quick flag is the first thing to test; otherwise block until the reply
        port holds this very request, and take it off the queue.

        Taking it also consumes the port's signal bit. Leaving the bit set is
        what made a second CMD_WRITE on the same request return instantly with
        nothing done: the following WaitIO saw a signal that had already been
        accounted for and never waited at all.
        """
        ioreq = cpu.get(A1)
        if cpu.r8(ioreq + IO_FLAGS) & IOF_QUICK:
            cpu.set(D0, cpu.r8(ioreq + IO_ERROR))
            return
        reply = self.m.cpu.r32(ioreq + MN_REPLYPORT)
        port = self.m.port(reply)
        if ioreq in port.queue:
            port.queue.remove(ioreq)
            if not port.queue:
                self.sched.consume(self.sched.current, 1 << port.sigbit)
            cpu.w8(ioreq + LN_TYPE, NT_MESSAGE)
            cpu.set(D0, cpu.r8(ioreq + IO_ERROR))
            return
        if self.sched.wait(self.sched.current, 1 << port.sigbit) is None:
            self.sched.block('WaitIO')

    def _CheckIO(self, cpu):
        """CheckIO(ioReq A1) -> the request if it is done, else zero."""
        ioreq = cpu.get(A1)
        if cpu.r8(ioreq + IO_FLAGS) & IOF_QUICK:
            cpu.set(D0, ioreq)
            return
        reply = self.m.cpu.r32(ioreq + MN_REPLYPORT)
        done = reply and ioreq in self.m.port(reply).queue
        cpu.set(D0, ioreq if done else 0)

    # ---------------------------------------------------------- InitStruct
    def _InitStruct(self, cpu):
        """The Amiga's table-driven struct initialiser.

        Command byte layout, verified by decoding translator.library 33.2's own
        table (at hunk offset 0x57e) and checking the result is a well-formed
        library node — LN_TYPE=9 (NT_LIBRARY), LN_NAME, LIB_VERSION=33,
        LIB_REVISION=2, LIB_FLAGS=6:

            bits 7-6  destination: 0 = carry on from here, 1 = 8-bit offset
                      follows, 2 = 16-bit offset follows, 3 = 24-bit offset
            bits 5-4  data size: 0 = long, 1 = word, 2 = byte
            bits 3-0  repeat count minus one

        Byte-sized runs pad to an even address afterwards, which is why
        INITBYTE emits `dc.b value,0`.
        """
        table, dest, size = cpu.get(A1), cpu.get(A2), cpu.get(D0)
        cpu_ = self.m.cpu
        if size:
            cpu_.clear(dest, size)
        if not table:
            return
        p = table
        offset = dest
        while True:
            cmd = cpu_.r8(p)
            p += 1
            if cmd == 0:
                break
            dmode = (cmd >> 6) & 3
            dtype = (cmd >> 4) & 3
            count = (cmd & 0x0F) + 1
            if dmode == 1:
                offset = dest + cpu_.r8(p); p += 1
            elif dmode == 2:
                offset = dest + cpu_.r16(p); p += 2
            elif dmode == 3:
                offset = dest + ((cpu_.r8(p) << 16) | cpu_.r16(p + 1)); p += 3
            if dtype == 3:
                raise ExecError(f'InitStruct: reserved data size in cmd {cmd:#x}')
            for _ in range(count):
                if dtype == 0:
                    cpu_.w32(offset, cpu_.r32(p)); p += 4; offset += 4
                elif dtype == 1:
                    cpu_.w16(offset, cpu_.r16(p)); p += 2; offset += 2
                else:
                    cpu_.w8(offset, cpu_.r8(p)); p += 1; offset += 1
            if dtype == 2 and (p - table) & 1:
                p += 1

    # ---------------------------------------------------------- MakeLibrary
    def _MakeLibrary(self, cpu):
        """MakeLibrary(vectors A0, structure A1, init A2, dataSize D0, segList D1)."""
        vectors, structure, init = cpu.get(A0), cpu.get(A1), cpu.get(A2)
        data_size, seglist = cpu.get(D0), cpu.get(D1)
        addrs = self._read_vectors(vectors)
        neg = len(addrs) * 6
        block = self.m.alloc(neg + max(data_size, 32), 'MakeLibrary')
        base = block + neg
        for i, target in enumerate(addrs):
            self.m.cpu.w16(base - 6 * (i + 1), JMP_L)
            self.m.cpu.w32(base - 6 * (i + 1) + 2, target)
        self.m.cpu.w16(base + 16, neg)       # LIB_NEGSIZE
        self.m.cpu.w16(base + 18, data_size)  # LIB_POSSIZE
        self.libs_made.append({'base': base, 'vectors': addrs, 'neg': neg,
                               'data_size': data_size, 'seglist': seglist,
                               'init': init, 'structure': structure})
        if structure:
            cpu.set(A1, structure)
            cpu.set(A2, base)
            cpu.set(D0, data_size)
            self._InitStruct(cpu)
        cpu.set(D0, base)
        if init:
            # init(libbase D0, segList A0, execBase A6) -> D0, and D0 is also
            # what MakeLibrary returns, so tail-calling gets the plumbing right.
            self.m.tail_call(init, d={D0: base}, a={A0: seglist, A6: self.base})

    def _MakeFunctions(self, cpu):
        target, vectors, dispatch = cpu.get(A0), cpu.get(A1), cpu.get(A2)
        addrs = self._read_vectors(vectors, relative_to=dispatch)
        for i, a in enumerate(addrs):
            self.m.cpu.w16(target - 6 * (i + 1), JMP_L)
            self.m.cpu.w32(target - 6 * (i + 1) + 2, a)
        cpu.set(D0, len(addrs) * 6)

    def _read_vectors(self, vectors, relative_to=0):
        """Either 32-bit absolute addresses, or 16-bit offsets when the table
        opens with 0xFFFF. Both forms terminate with all-ones."""
        cpu = self.m.cpu
        out = []
        if cpu.r16(vectors) == 0xFFFF:
            base = relative_to or vectors
            p = vectors + 2
            while True:
                w = cpu.r16(p)
                if w == 0xFFFF:
                    break
                out.append((base + struct.unpack('>h', struct.pack('>H', w))[0]) & 0xFFFFFFFF)
                p += 2
        else:
            p = vectors
            while True:
                a = cpu.r32(p)
                if a == 0xFFFFFFFF:
                    break
                out.append(a)
                p += 4
        return out
