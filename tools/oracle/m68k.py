"""ctypes binding for liboracle.so — a 68000 with flat RAM and host traps."""
import ctypes
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / 'build' / 'oracle' / 'liboracle.so'

# our register indices, matching reg_of() in shim.c
D0, D1, D2, D3, D4, D5, D6, D7 = range(8)
A0, A1, A2, A3, A4, A5, A6, A7 = range(8, 16)
PC, SR = 16, 17

TRAP_CB = ctypes.CFUNCTYPE(None, ctypes.c_uint32)


class CpuError(RuntimeError):
    pass


class Cpu:
    def __init__(self, ram_size=16 << 20, build=True):
        if build and not LIB.exists():
            subprocess.run(['make', '-C', str(ROOT / 'tools' / 'oracle')], check=True,
                           stdout=subprocess.DEVNULL)
        if not LIB.exists():
            raise CpuError(f'{LIB} missing — run: make -C tools/oracle')
        self.lib = ctypes.CDLL(str(LIB))
        self._decl()
        if self.lib.oracle_init(ram_size) != 0:
            raise CpuError('oracle_init failed')
        self.ram_size = ram_size
        self._cb = None

    def _decl(self):
        L = self.lib
        L.oracle_init.argtypes = [ctypes.c_uint32]
        L.oracle_init.restype = ctypes.c_int
        L.oracle_set_traps.argtypes = [ctypes.c_uint32, ctypes.c_uint32, TRAP_CB]
        L.oracle_write_block.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32]
        L.oracle_read_block.argtypes = [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_uint32]
        L.oracle_memset.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        L.oracle_get_reg.argtypes = [ctypes.c_int]
        L.oracle_get_reg.restype = ctypes.c_uint32
        L.oracle_set_reg.argtypes = [ctypes.c_int, ctypes.c_uint32]
        L.oracle_execute.argtypes = [ctypes.c_int]
        L.oracle_execute.restype = ctypes.c_int
        L.oracle_bad_addr.restype = ctypes.c_uint32
        L.oracle_disassemble.argtypes = [ctypes.c_char_p, ctypes.c_uint32]
        L.oracle_disassemble.restype = ctypes.c_int

    # ---- memory ----
    def write(self, addr, data):
        self.lib.oracle_write_block(addr, bytes(data), len(data))

    def read(self, addr, length):
        buf = ctypes.create_string_buffer(length)
        self.lib.oracle_read_block(addr, buf, length)
        return buf.raw

    def clear(self, addr, length, val=0):
        self.lib.oracle_memset(addr, val, length)

    def r8(self, a):
        return self.read(a, 1)[0]

    def r16(self, a):
        return int.from_bytes(self.read(a, 2), 'big')

    def r32(self, a):
        return int.from_bytes(self.read(a, 4), 'big')

    def w8(self, a, v):
        self.write(a, bytes([v & 0xFF]))

    def w16(self, a, v):
        self.write(a, (v & 0xFFFF).to_bytes(2, 'big'))

    def w32(self, a, v):
        self.write(a, (v & 0xFFFFFFFF).to_bytes(4, 'big'))

    def cstr(self, a, limit=4096):
        out = bytearray()
        for i in range(limit):
            c = self.r8(a + i)
            if not c:
                break
            out.append(c)
        return bytes(out)

    # ---- registers ----
    def get(self, i):
        return self.lib.oracle_get_reg(i)

    def set(self, i, v):
        self.lib.oracle_set_reg(i, v & 0xFFFFFFFF)

    def push32(self, v):
        sp = (self.get(A7) - 4) & 0xFFFFFFFF
        self.set(A7, sp)
        self.w32(sp, v)

    # ---- execution ----
    def set_traps(self, base, end, handler):
        self._cb = TRAP_CB(handler)   # keep a reference or ctypes frees it
        self.lib.oracle_set_traps(base, end, self._cb)

    def stop(self):
        self.lib.oracle_stop()

    def execute(self, cycles):
        return self.lib.oracle_execute(cycles)

    def stopped(self):
        return bool(self.lib.oracle_stopped())

    def bad(self):
        """(count, first_addr) of accesses outside RAM — always an emulation bug."""
        return self.lib.oracle_bad_count(), self.lib.oracle_bad_addr()

    def clear_bad(self):
        self.lib.oracle_clear_bad()

    def disasm(self, pc):
        buf = ctypes.create_string_buffer(256)
        n = self.lib.oracle_disassemble(buf, pc)
        return buf.value.decode('latin-1'), n
