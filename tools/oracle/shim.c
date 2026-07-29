/*
 * oracle shim — flat memory + a trap mechanism around the Musashi 68000 core.
 *
 * The trap trick: every emulated AmigaOS entry point is a 6-byte `JMP.L magic`
 * stub in a library's negative jump table, where `magic` lands inside a page
 * pre-filled with RTS (0x4E75). Musashi's instruction hook fires with the PC
 * before each instruction; when the PC is inside that page we dispatch to the
 * host, the host sets D0/A0/etc., and then the RTS sitting at that address
 * executes normally and returns to the Amiga caller.
 *
 * No PC surgery, no exception-vector games, and nothing that depends on the
 * emulator's internals — which matters, because a clever trap that subtly
 * corrupted state would show up as a wrong sample rather than as a crash.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "m68k.h"

/* --------------------------------------------------------------------- */

static uint8_t *g_ram;
static uint32_t g_ram_size;

static uint32_t g_trap_base, g_trap_end;
static void (*g_trap_cb)(uint32_t pc);

/* Set by the host from inside a trap handler to unwind out of m68k_execute. */
static int g_stop;
/* Anything the CPU touches outside RAM is a bug in the emulation, not in the
 * Amiga code — record it loudly rather than returning plausible zeroes. */
static uint32_t g_bad_addr;
static int g_bad_count;

/* Execution coverage: one counter per even address, over a window the host
 * chooses. 22KB of undocumented synthesis code is a lot to read statically,
 * and "which of it ran for input X, and not for input Y" narrows it fast.
 * Saturating so a hot inner loop cannot wrap and read as cold. */
static uint16_t *g_cov;
static uint32_t g_cov_base, g_cov_end;

void oracle_cover(uint32_t base, uint32_t end)
{
    free(g_cov);
    g_cov = NULL;
    g_cov_base = base;
    g_cov_end = end;
    if (end > base)
        g_cov = calloc((end - base) / 2 + 1, sizeof *g_cov);
}

void oracle_cover_reset(void)
{
    if (g_cov)
        memset(g_cov, 0, ((g_cov_end - g_cov_base) / 2 + 1) * sizeof *g_cov);
}

void oracle_cover_read(uint16_t *dst, uint32_t n)
{
    if (g_cov)
        memcpy(dst, g_cov, n * sizeof *g_cov);
}

void oracle_instr_hook(unsigned int pc)
{
    if (g_cov && pc >= g_cov_base && pc < g_cov_end) {
        uint16_t *slot = &g_cov[(pc - g_cov_base) / 2];
        if (*slot != 0xFFFF)
            (*slot)++;
    }
    if (pc >= g_trap_base && pc < g_trap_end && g_trap_cb) {
        g_trap_cb(pc);
        if (g_stop)
            m68k_end_timeslice();
    }
}

/* ------------------------------ memory -------------------------------- */

static inline int in_ram(uint32_t a, uint32_t n)
{
    return (uint64_t)a + n <= (uint64_t)g_ram_size;
}

static void bad(uint32_t a)
{
    if (!g_bad_count++)
        g_bad_addr = a;
}

unsigned int m68k_read_memory_8(unsigned int a)
{
    if (!in_ram(a, 1)) { bad(a); return 0; }
    return g_ram[a];
}

unsigned int m68k_read_memory_16(unsigned int a)
{
    if (!in_ram(a, 2)) { bad(a); return 0; }
    return ((unsigned)g_ram[a] << 8) | g_ram[a + 1];
}

unsigned int m68k_read_memory_32(unsigned int a)
{
    if (!in_ram(a, 4)) { bad(a); return 0; }
    return ((unsigned)g_ram[a] << 24) | ((unsigned)g_ram[a + 1] << 16) |
           ((unsigned)g_ram[a + 2] << 8) | g_ram[a + 3];
}

void m68k_write_memory_8(unsigned int a, unsigned int v)
{
    if (!in_ram(a, 1)) { bad(a); return; }
    g_ram[a] = (uint8_t)v;
}

void m68k_write_memory_16(unsigned int a, unsigned int v)
{
    if (!in_ram(a, 2)) { bad(a); return; }
    g_ram[a] = (uint8_t)(v >> 8);
    g_ram[a + 1] = (uint8_t)v;
}

void m68k_write_memory_32(unsigned int a, unsigned int v)
{
    if (!in_ram(a, 4)) { bad(a); return; }
    g_ram[a] = (uint8_t)(v >> 24);
    g_ram[a + 1] = (uint8_t)(v >> 16);
    g_ram[a + 2] = (uint8_t)(v >> 8);
    g_ram[a + 3] = (uint8_t)v;
}

unsigned int m68k_read_disassembler_8(unsigned int a) { return m68k_read_memory_8(a); }
unsigned int m68k_read_disassembler_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_disassembler_32(unsigned int a) { return m68k_read_memory_32(a); }

unsigned int m68k_read_immediate_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_immediate_32(unsigned int a) { return m68k_read_memory_32(a); }
unsigned int m68k_read_pcrelative_8(unsigned int a) { return m68k_read_memory_8(a); }
unsigned int m68k_read_pcrelative_16(unsigned int a) { return m68k_read_memory_16(a); }
unsigned int m68k_read_pcrelative_32(unsigned int a) { return m68k_read_memory_32(a); }

/* ------------------------------- host API ------------------------------ */

int oracle_init(uint32_t ram_size)
{
    free(g_ram);
    g_ram = calloc(1, ram_size);
    if (!g_ram)
        return -1;
    g_ram_size = ram_size;
    g_bad_addr = 0;
    g_bad_count = 0;
    m68k_set_cpu_type(M68K_CPU_TYPE_68000);
    m68k_init();
    m68k_pulse_reset();
    return 0;
}

void oracle_free(void)
{
    free(g_ram);
    g_ram = NULL;
    g_ram_size = 0;
}

void oracle_set_traps(uint32_t base, uint32_t end, void (*cb)(uint32_t))
{
    g_trap_base = base;
    g_trap_end = end;
    g_trap_cb = cb;
}

void oracle_write_block(uint32_t addr, const uint8_t *src, uint32_t len)
{
    if (in_ram(addr, len))
        memcpy(g_ram + addr, src, len);
    else
        bad(addr);
}

void oracle_read_block(uint32_t addr, uint8_t *dst, uint32_t len)
{
    if (in_ram(addr, len))
        memcpy(dst, g_ram + addr, len);
    else
        bad(addr);
}

void oracle_memset(uint32_t addr, int val, uint32_t len)
{
    if (in_ram(addr, len))
        memset(g_ram + addr, val, len);
    else
        bad(addr);
}

/* Register indices are ours, not Musashi's, so the Python side does not
 * silently break if the vendored enum is ever reordered. 0-7 D0-D7,
 * 8-15 A0-A7, 16 PC, 17 SR. */
static int reg_of(int i)
{
    static const int d[] = { M68K_REG_D0, M68K_REG_D1, M68K_REG_D2, M68K_REG_D3,
                             M68K_REG_D4, M68K_REG_D5, M68K_REG_D6, M68K_REG_D7,
                             M68K_REG_A0, M68K_REG_A1, M68K_REG_A2, M68K_REG_A3,
                             M68K_REG_A4, M68K_REG_A5, M68K_REG_A6, M68K_REG_A7,
                             M68K_REG_PC, M68K_REG_SR };
    if (i < 0 || i > 17)
        return M68K_REG_D0;
    return d[i];
}

uint32_t oracle_get_reg(int i) { return m68k_get_reg(NULL, reg_of(i)); }
void oracle_set_reg(int i, uint32_t v) { m68k_set_reg(reg_of(i), v); }

void oracle_stop(void)
{
    g_stop = 1;
}

/* Returns cycles actually consumed. g_stop is cleared here so each call to
 * execute starts from a clean slate. */
int oracle_execute(int cycles)
{
    g_stop = 0;
    return m68k_execute(cycles);
}

int oracle_stopped(void) { return g_stop; }
int oracle_bad_count(void) { return g_bad_count; }
uint32_t oracle_bad_addr(void) { return g_bad_addr; }
void oracle_clear_bad(void) { g_bad_count = 0; g_bad_addr = 0; }

/* Disassemble one instruction, for the annotation tooling. */
int oracle_disassemble(char *buf, uint32_t pc)
{
    return m68k_disassemble(buf, pc, M68K_CPU_TYPE_68000);
}
