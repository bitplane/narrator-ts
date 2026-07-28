#!/usr/bin/env python3
"""Harvest narrator.device / translator.library from a tree of Workbench disk images.

Walks zips (which may nest: a zip of zips of ADFs), reads each ADF with the OFS/FFS
reader below, and pulls out every copy of the speech binaries.
Copies are deduped by sha256, so the output is one file per *distinct build*, not one
per disk. Each is tagged with the Amiga version string baked into it.

Usage: extract-devices.py <search-root>... -o <outdir>
"""
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path


WANTED = ('narrator.device', 'translator.library')
# Amiga convention: an embedded "\0$VER: name ver.rev (date)" or bare "name ver.rev (date)"
VER_RE = re.compile(rb'(narrator|translator)[ .]?(?:device|library)?\s+(\d+)\.(\d+)\s*\(([^)]*)\)')


class Adf:
    """OFS/FFS reader for standard 880K Amiga disk images."""

    BS = 512

    def __init__(self, data):
        self.d = data
        self.ffs = bool(data[3] & 1)

    def blk(self, n):
        return self.d[n * self.BS:(n + 1) * self.BS]

    @staticmethod
    def _u32(b, o):
        return int.from_bytes(b[o:o + 4], 'big')

    def name(self, b):
        return b[433:433 + b[432]].decode('latin-1')

    def chain(self, start):
        out, n = [], start
        while n:
            out.append(n)
            n = self._u32(self.blk(n), 496)
        return out

    def walk(self, blocknum=880, path='', depth=0):
        if depth > 12:
            return
        b = self.blk(blocknum)
        for i in range(72):
            for n in self.chain(self._u32(b, 24 + 4 * i)):
                eb = self.blk(n)
                st = int.from_bytes(eb[508:512], 'big', signed=True)
                nm = path + '/' + self.name(eb)
                if st == 2:
                    yield from self.walk(n, nm, depth + 1)
                elif st == -3:
                    yield (nm, self._u32(eb, 324), n)

    def read(self, blocknum):
        hdr = self.blk(blocknum)
        size = self._u32(hdr, 324)
        out, b = bytearray(), hdr
        while True:
            for i in range(self._u32(b, 8)):
                db = self.blk(self._u32(b, 24 + 4 * (71 - i)))
                out += db if self.ffs else db[24:]
            nxt = self._u32(b, 504)
            if not nxt:
                break
            b = self.blk(nxt)
        return bytes(out[:size])


def version_of(data):
    m = VER_RE.search(data)
    if not m:
        return None
    ver = f"{m.group(2).decode()}.{m.group(3).decode()}"
    return ver, m.group(4).decode('latin-1', 'replace').strip()


def iter_adfs(path, data, depth=0):
    """Yield (label, adf_bytes) from a zip tree or a bare .adf."""
    if depth > 4:
        return
    low = path.lower()
    if low.endswith('.adf'):
        yield path, data
        return
    if not zipfile.is_zipfile(io.BytesIO(data)):
        return
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            inner = info.filename.lower()
            if inner.endswith(('.adf', '.zip')):
                yield from iter_adfs(f'{path}!{info.filename}', z.read(info), depth + 1)


def main():
    args = sys.argv[1:]
    outdir = Path('fixtures/amiga')
    if '-o' in args:
        i = args.index('-o')
        outdir = Path(args[i + 1])
        args = args[:i] + args[i + 2:]
    outdir.mkdir(parents=True, exist_ok=True)

    found = {}  # sha256 -> record
    scanned = 0
    for root in args:
        # A root may be a directory to walk or a single archive; rglob on a
        # file yields nothing, which would silently scan zero disks.
        rp = Path(root)
        candidates = sorted(rp.rglob('*')) if rp.is_dir() else [rp]
        for p in candidates:
            if not p.is_file() or p.suffix.lower() not in ('.zip', '.adf'):
                continue
            try:
                blob = p.read_bytes()
            except OSError:
                continue
            for label, adf in iter_adfs(str(p), blob):
                if len(adf) < 512 * 880:
                    continue
                scanned += 1
                try:
                    a = Adf(adf)
                    entries = list(a.walk())
                except (IndexError, ValueError):
                    continue
                for nm, _size, blocknum in entries:
                    base = nm.rsplit('/', 1)[-1].lower()
                    if base not in WANTED:
                        continue
                    try:
                        data = a.read(blocknum)
                    except (IndexError, ValueError):
                        continue
                    if not data:
                        continue
                    h = hashlib.sha256(data).hexdigest()
                    if h in found:
                        found[h]['seen'] += 1
                        continue
                    ver = version_of(data)
                    found[h] = {
                        'name': base,
                        'version': ver[0] if ver else 'unknown',
                        'date': ver[1] if ver else '',
                        'size': len(data),
                        'sha256': h,
                        'from': label,
                        'path_on_disk': nm,
                        'seen': 1,
                    }
                    stem = base.replace('.', '_')
                    fn = outdir / f"{stem}-{found[h]['version']}-{h[:8]}.bin"
                    fn.write_bytes(data)
                    found[h]['file'] = fn.name

    records = sorted(found.values(), key=lambda r: (r['name'], r['version'], r['size']))
    (outdir / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'scanned {scanned} disk images, found {len(records)} distinct builds\n')
    for r in records:
        print(f"{r['name']:20} v{r['version']:6} {r['size']:7}  x{r['seen']:<4} {r['date']:16} {r['file']}")


if __name__ == '__main__':
    main()
