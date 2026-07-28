"""Cooperative multitasking for the oracle: tasks, signals and message ports.

`narrator.device` is not a library you can call. Its init creates a *server
task* (`AddTask` at hunk+0xba of 33.2) which sits in the classic exec loop —
`Wait` for a signal, `GetMsg` from its port, do the work, reply — and `BeginIO`
merely posts a message to it. Nothing happens without a scheduler, so there is
one here.

It is cooperative, and deliberately so: switches happen only where exec would
block anyway, so there is no timer, no preemption and no interrupt. That makes
a run reproducible, which is the whole point of the rig.

## How a switch works without touching the emulator

Musashi's instruction hook fires with the PC *before* the instruction there
runs, and every emulated exec call is an RTS in the trap page (see shim.c). So
when a handler decides to block, the RTS at that address has not executed yet
and `PC` still points at the trap. Saving the register file at that moment
captures the task *about to call exec* — restoring it later re-enters the same
handler, which re-checks its condition and either blocks again or returns.

`m68k_end_timeslice` lets the current instruction finish, so the RTS does run
once more after the handler returns and clobbers PC and A7. That is harmless:
the context was saved before it, and the registers are about to be overwritten
by whichever task runs next.

No PC surgery, no re-entering `m68k_execute` from inside a callback, and no
dependency on emulator internals.
"""
import struct

from m68k import A7, PC, SR

# struct Task. Offsets confirmed against narrator.device 33.2's own init,
# which writes tc_SPReg/SPLower/SPUpper at +0x36/+0x3a/+0x3e (hunk+0xa0-0xae).
TC_NODE, TC_FLAGS, TC_STATE = 0, 14, 15
TC_SIGALLOC, TC_SIGWAIT, TC_SIGRECVD = 18, 22, 26
TC_SPREG, TC_SPLOWER, TC_SPUPPER = 54, 58, 62
TC_SIZE = 92

# struct Node: ln_Succ, ln_Pred, ln_Type, ln_Pri, ln_Name.
LN_TYPE, LN_PRI, LN_NAME = 8, 9, 10
NT_TASK, NT_MSGPORT, NT_MESSAGE, NT_REPLYMSG = 1, 4, 5, 6

# struct MsgPort, and struct Message inside it.
MP_FLAGS, MP_SIGBIT, MP_SIGTASK, MP_MSGLIST = 14, 15, 16, 20
MN_REPLYPORT, MN_LENGTH = 14, 18

# struct IORequest, laid on top of a Message. narrator.device's server task
# reads io_Command from `($1c,A1)` (hunk+0x528a), which fixes it at 28.
IO_DEVICE, IO_UNIT, IO_COMMAND, IO_FLAGS, IO_ERROR = 20, 24, 28, 30, 31
IOF_QUICK = 1 << 0

# A device's jump table: the four library vectors, then its own two.
LVO_OPEN, LVO_CLOSE, LVO_EXPUNGE = 6, 12, 18
LVO_BEGINIO, LVO_ABORTIO = 30, 36

# The bits exec keeps for itself; AllocSignal hands out from 16 upwards.
SIGF_RESERVED = 0x0000FFFF

NREG = 18       # D0-D7, A0-A7, PC, SR


class TaskError(RuntimeError):
    pass


class Task:
    """One 68k execution context.

    `node` is the Amiga `struct Task` this stands for, or 0 for the host-driven
    context that `Machine.call` runs on. Signal state lives here rather than in
    the struct, and is mirrored back into it so that code which peeks at
    tc_SigRecvd sees the truth.
    """

    def __init__(self, name, node=0, regs=None):
        self.name = name
        self.node = node
        self.regs = list(regs) if regs else [0] * NREG
        self.sigalloc = SIGF_RESERVED
        self.sigrecvd = 0
        self.sigwait = 0
        self.waiting = False
        self.finished = False
        # Set when the context was captured inside a trap handler, before that
        # handler's RTS ran. See block() versus yield_now().
        self.saved = False
        # Where this task blocked, for the deadlock report. Nothing else.
        self.blocked_in = None
        # Device calls in flight on this task, innermost last: each is
        # (caller's A6, what to do on return, the request). A stack, and
        # per-task, because these nest — narrator.device's server issues its
        # own DoIO to audio.device while its caller is still inside one.
        self.cont_stack = []

    def __repr__(self):
        state = 'finished' if self.finished else (
            f'wait({self.sigwait:#x} in {self.blocked_in})' if self.waiting else 'ready')
        return f'<Task {self.name} {state}>'

    @property
    def runnable(self):
        return not self.finished and (not self.waiting or bool(self.sigrecvd & self.sigwait))


class Scheduler:
    """Round-robin over runnable tasks, switching only where exec blocks."""

    def __init__(self, machine):
        self.m = machine
        self.tasks = []
        self.current = None
        self.switch_pending = False
        # Every switch, for the trace: (from, to, why).
        self.switches = []

    # ----------------------------------------------------------------- tasks
    def add_host_task(self, name='host'):
        t = Task(name)
        self.tasks.append(t)
        self.current = t
        return t

    def add_task(self, node, initial_pc, final_pc, name=''):
        """exec's AddTask.

        The finalPC is pushed onto the task's own stack, so an RTS from the
        entry point ends the task — and so anything the creator pre-pushed sits
        at 4(A7). narrator.device relies on exactly that: its init pushes the
        device base, and the server task reads it back from `($4,A7)`.
        """
        cpu = self.m.cpu
        sp = cpu.r32(node + TC_SPREG) or cpu.r32(node + TC_SPUPPER)
        sp = (sp - 4) & 0xFFFFFFFF
        cpu.w32(sp, final_pc)
        cpu.w32(node + TC_SPREG, sp)
        cpu.w8(node + LN_TYPE, NT_TASK)

        regs = [0] * NREG
        regs[A7] = sp
        regs[PC] = initial_pc
        regs[SR] = 0x0000                       # user mode, interrupts enabled
        name = name or self._name_of(node) or f'task@{node:#x}'
        t = Task(name, node, regs)
        t.final_pc = final_pc
        self.tasks.append(t)
        self._sync(t)
        return t

    def _name_of(self, node):
        p = self.m.cpu.r32(node + LN_NAME)
        return self.m.cpu.cstr(p).decode('latin-1', 'replace') if p else ''

    def find(self, node):
        for t in self.tasks:
            if t.node == node:
                return t
        return None

    # --------------------------------------------------------------- signals
    def alloc_signal(self, task, wanted):
        """AllocSignal(-1) takes the lowest free bit; a specific bit is taken
        as asked. Returns -1 if none is available, as exec does."""
        if wanted == 0xFFFFFFFF or wanted < 0:
            free = ~task.sigalloc & 0xFFFFFFFF
            if not free:
                return -1
            bit = (free & -free).bit_length() - 1
        else:
            bit = wanted
            if task.sigalloc >> bit & 1:
                return -1
        task.sigalloc |= 1 << bit
        task.sigrecvd &= ~(1 << bit) & 0xFFFFFFFF
        self._sync(task)
        return bit

    def free_signal(self, task, bit):
        task.sigalloc &= ~(1 << bit) & 0xFFFFFFFF
        self._sync(task)

    def signal(self, task, mask):
        task.sigrecvd |= mask & 0xFFFFFFFF
        self._sync(task)

    def wait(self, task, mask):
        """The blocking half of exec's Wait. Returns the bits, or None to block.

        Called from a trap handler, possibly more than once for the same Wait:
        blocking leaves the PC on the trap, so the task re-enters here when it
        is next scheduled.
        """
        got = task.sigrecvd & mask
        if got:
            task.sigrecvd &= ~got & 0xFFFFFFFF
            task.waiting = False
            task.sigwait = 0
            self._sync(task)
            return got
        task.waiting = True
        task.sigwait = mask & 0xFFFFFFFF
        self._sync(task)
        return None

    def consume(self, task, mask):
        """Take signal bits without blocking. Returns the ones that were set.

        The counterpart to wait() for a caller that has already found what it
        was going to wait for — WaitIO discovering its request is back. Without
        this the bit lingers, and the *next* wait on it returns at once for a
        message that has not arrived.
        """
        got = task.sigrecvd & mask
        task.sigrecvd &= ~mask & 0xFFFFFFFF
        self._sync(task)
        return got

    def _sync(self, task):
        """Mirror signal state into the Amiga struct, for code that reads it."""
        if not task.node:
            return
        cpu = self.m.cpu
        cpu.w32(task.node + TC_SIGALLOC, task.sigalloc)
        cpu.w32(task.node + TC_SIGWAIT, task.sigwait)
        cpu.w32(task.node + TC_SIGRECVD, task.sigrecvd)

    # -------------------------------------------------------------- switching
    def block(self, why):
        """Give up the CPU with the exec call *unfinished*.

        The context is captured here, before the trap's RTS runs, so the PC
        still points at the trap: when this task is scheduled again it re-enters
        the same handler and re-tests its condition.
        """
        self.current.blocked_in = why
        self.save_current()
        self.current.saved = True
        self.switch_pending = True
        self.m.cpu.stop()

    def yield_now(self, why='yield'):
        """Give up the CPU with the exec call *finished*.

        No save here: the RTS still has to run, and the registers are captured
        after it, in the run loop. So this task resumes at the instruction after
        the call rather than repeating it.
        """
        self.current.blocked_in = why
        self.switch_pending = True
        self.m.cpu.stop()

    def save_current(self):
        cpu = self.m.cpu
        self.current.regs = [cpu.get(i) for i in range(NREG)]

    def restore(self, task):
        cpu = self.m.cpu
        for i, v in enumerate(task.regs):
            cpu.set(i, v)
        # A running task is by definition not waiting. Clearing it here rather
        # than in each handler keeps the invariant in one place: a handler that
        # blocks again will set it again on the way out.
        task.waiting = False
        task.sigwait = 0
        self._sync(task)
        self.current = task

    def switch(self):
        """Pick the next runnable task and make it current. Returns it."""
        if not self.current.saved:
            self.save_current()
        self.current.saved = False
        n = len(self.tasks)
        start = self.tasks.index(self.current)
        for k in range(1, n + 1):
            cand = self.tasks[(start + k) % n]
            if cand.runnable:
                if cand is not self.current:
                    self.switches.append((self.current.name, cand.name,
                                          self.current.blocked_in))
                self.restore(cand)
                return cand
        raise TaskError('deadlock: every task is blocked\n  ' +
                        '\n  '.join(repr(t) for t in self.tasks))


class Port:
    """A message port. Messages are held host-side and mirrored on demand.

    exec keeps them on mp_MsgList and callers walk that list; nothing in the
    speech binaries does, so the list header is left as the device initialised
    it and the queue lives here where it can be inspected.
    """

    def __init__(self, addr, sched, cpu):
        self.addr = addr
        self.sched = sched
        self.cpu = cpu
        self.queue = []

    @property
    def sigbit(self):
        return self.cpu.r8(self.addr + MP_SIGBIT)

    @property
    def sigtask(self):
        return self.cpu.r32(self.addr + MP_SIGTASK)

    def put(self, msg):
        self.queue.append(msg)
        task = self.sched.find(self.sigtask)
        if task is None:
            raise TaskError(f'PutMsg to port {self.addr:#x}: '
                            f'mp_SigTask {self.sigtask:#x} is not a known task')
        self.sched.signal(task, 1 << self.sigbit)

    def get(self):
        return self.queue.pop(0) if self.queue else 0
