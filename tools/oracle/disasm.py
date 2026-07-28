#!/usr/bin/env python3
"""Disassemble a loaded Amiga binary, annotating exec/library calls.

Loading through the same hunk loader the oracle uses means addresses in the
listing match addresses in a trace, which is the whole point — a finding
written down as "the rate clamp at +0x1a2c" has to be checkable later.

Usage: dis.py <binary> [start_offset] [count]
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from amiga import Machine, load_binary  # noqa: E402
from execlib import EXEC_LVO            # noqa: E402


ABS = re.compile(r'\$([0-9a-fA-F]+)(?=\.l\b|\b)')


def annotate(text, hunks):
    """Two annotations that make a listing checkable months later.

    Absolute addresses are rewritten as `hunk+offset`, because the runtime
    address depends on where the loader happened to put the hunk, while the
    offset is a property of the binary and can be cited in a NOTE. And
    `jsr (-84,A6)` becomes `exec.MakeLibrary` when A6 is plausibly ExecBase.
    """
    if ',A6)' in text and '(-' in text:
        try:
            lvo = int(text.split('(-')[1].split(',A6)')[0], 0)
            name = EXEC_LVO.get(lvo)
            if name:
                text += f'    ; exec.{name}'
        except (ValueError, IndexError):
            pass

    def sub(m):
        v = int(m.group(1), 16)
        for h in hunks:
            if h.size and h.addr <= v < h.addr + h.size:
                return f'{m.group(0)}<{h.index}+{v - h.addr:#x}>'
        return m.group(0)

    return ABS.sub(sub, text)


def main():
    path = sys.argv[1]
    start = int(sys.argv[2], 0) if len(sys.argv) > 2 else 0
    count = int(sys.argv[3], 0) if len(sys.argv) > 3 else 40

    m = Machine()
    hunks = m.load_hunks(load_binary(path), Path(path).stem)
    base = hunks[0].addr
    print(f'# {path}')
    print(f'# hunks: ' + ', '.join(
        f'#{h.index} {h.kind} @{h.addr:#x} size {h.size:#x}' for h in hunks))
    pc = base + start
    for _ in range(count):
        text, n = m.cpu.disasm(pc)
        raw = m.cpu.read(pc, n).hex(' ')
        print(f'{pc - base:06x}  {raw:<24}  {annotate(text, hunks)}')
        pc += n or 2


if __name__ == '__main__':
    main()
