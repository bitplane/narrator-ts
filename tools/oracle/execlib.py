"""A minimal exec.library for the oracle.

Only what the speech binaries actually reach for is implemented. Anything else
raises by name, so the set of requirements is discovered from the code rather
than guessed at in advance — and so an unimplemented call can never quietly
return a plausible zero into reference output.
"""
import struct

from m68k import A0, A1, A2, A6, D0, D1, D2

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
    def _Forbid(self, cpu): pass
    def _Permit(self, cpu): pass
    def _Disable(self, cpu): pass
    def _Enable(self, cpu): pass
    def _CacheClearU(self, cpu): pass

    def _SetSignal(self, cpu):
        cpu.set(D0, 0)

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
        self.added.append(('device', cpu.get(A1)))
    def _SumLibrary(self, cpu): pass

    def _FindName(self, cpu):
        cpu.set(D0, 0)

    def _FindTask(self, cpu):
        cpu.set(D0, self.m.fake_task)

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
