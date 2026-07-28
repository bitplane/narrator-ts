#!/usr/bin/env python3
"""Drive the real translator.library under emulation.

Handles both library conventions these builds use — see _bring_up().

translator.library's LVOs are the four standard ones plus Translate:

    -6 Open  -12 Close  -18 Expunge  -24 Reserved  -30 Translate

    Translate(A0 = input, D0 = length, A1 = output buffer, D1 = buffer size)
    -> D0 = 0 on success, or -(characters not translated)

Usage:
    translate.py "some text"                 # one phrase
    translate.py -f words.txt -o out.jsonl   # a corpus, one JSON object per line
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from amiga import AmigaError, Machine, load_binary  # noqa: E402
from m68k import A0, A1, A6, D0, D1     # noqa: E402

DEFAULT_LIB = 'fixtures/amiga/translator_library-33.2-11997e3c.bin'
OUT_SIZE = 4096


class Translator:
    def __init__(self, path=DEFAULT_LIB):
        self.m = Machine()
        self.execlib = self.m.install_exec()
        data = load_binary(path)
        self.hunks = self.m.load_hunks(data, 'translator')
        self.convention, self.libbase, self.translate_addr = self._bring_up()
        self.inbuf = self.m.alloc(4096, 'in')
        self.outbuf = self.m.alloc(OUT_SIZE, 'out')

    def _bring_up(self):
        """Two library conventions appear across these builds.

        1.3 through 36.1 are pre-resident: the loaded segment's entry point is
        itself the initialiser, calling MakeLibrary and AddLibrary and (in
        33.2's case) returning -1 rather than the base, so the base is taken
        from the AddLibrary it performs on the way out.

        37.1 is a proper RTF_AUTOINIT resident, so its vector table is read
        straight from the RomTag.

        Both are supported rather than one being special-cased, because the
        library has to cover every version.
        """
        LVO_TRANSLATE = 30
        try:
            resident = self.m.find_resident(self.hunks)
        except AmigaError:
            resident = None

        if resident is not None:
            info = self.m.autoinit_vectors(resident)
            vectors = info['vectors']
            if len(vectors) <= LVO_TRANSLATE // 6 - 1:
                raise RuntimeError(f'only {len(vectors)} vectors in RomTag')
            base = self.m.alloc(max(info['data_size'], 64), 'translator-base')
            return f"resident v{resident['version']}", base, vectors[LVO_TRANSLATE // 6 - 1]

        self.m.call(self.hunks[0].addr, a={A6: self.execlib.base})
        bases = [b for kind, b in self.execlib.added if kind == 'library']
        if not bases:
            raise RuntimeError('library init never called AddLibrary')
        base = bases[-1]
        return 'segment-init', base, self.m.cpu.r32(base - LVO_TRANSLATE + 2)

    def describe(self):
        made = self.execlib.libs_made[-1] if self.execlib.libs_made else {}
        used = ', '.join(dict.fromkeys(c[0] for c in self.execlib.calls))
        return (f'library base {self.libbase:#x}, '
                f"{len(made.get('vectors', []))} vectors\n"
                f'  Translate at {self.translate_addr:#x} '
                f'(hunk+{self.translate_addr - self.hunks[0].addr:#x})\n'
                f'  convention: {self.convention}\n'
                f'  exec calls during init: {used}')

    def translate(self, text):
        raw = text.encode('latin-1', 'replace')
        self.m.cpu.write(self.inbuf, raw + b'\0')
        self.m.cpu.clear(self.outbuf, OUT_SIZE)
        rc = self.m.call(self.translate_addr,
                         d={D0: len(raw), D1: OUT_SIZE},
                         a={A0: self.inbuf, A1: self.outbuf, A6: self.libbase})
        if rc & 0x80000000:
            rc -= 1 << 32
        return self.m.cpu.cstr(self.outbuf, OUT_SIZE).decode('latin-1'), rc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('text', nargs='*')
    ap.add_argument('-l', '--lib', default=DEFAULT_LIB)
    ap.add_argument('-f', '--file', help='one input phrase per line')
    ap.add_argument('-o', '--out', help='write JSON lines here')
    args = ap.parse_args()

    t = Translator(args.lib)
    print(t.describe(), file=sys.stderr)

    if args.file:
        lines = [l.rstrip('\n') for l in Path(args.file).read_text(encoding='latin-1').splitlines()]
        lines = [l for l in lines if l.strip()]
    else:
        lines = args.text or ['hello world']

    sink = open(args.out, 'w') if args.out else None
    for line in lines:
        phon, rc = t.translate(line)
        if sink:
            sink.write(json.dumps({'in': line, 'out': phon, 'rc': rc}) + '\n')
        else:
            print(f'{line!r} -> {phon!r}  (rc={rc})')
    if sink:
        sink.close()
        print(f'wrote {len(lines)} entries to {args.out}', file=sys.stderr)


if __name__ == '__main__':
    main()
