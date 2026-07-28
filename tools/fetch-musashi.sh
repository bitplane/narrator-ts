#!/usr/bin/env bash
# Fetch the Musashi 68000 core. Vendored rather than reimplemented: the oracle's
# whole value is that its output is trustworthy, and a subtly wrong CPU would
# poison every golden fixture without ever announcing itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/musashi"
REV="${MUSASHI_REV:-master}"

if [ -f "$DEST/m68kcpu.c" ]; then
  echo "musashi already present at $DEST"
  exit 0
fi

mkdir -p "$ROOT/vendor"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetching Musashi ($REV)..."
curl -fsSL "https://github.com/kstenerud/Musashi/archive/$REV.tar.gz" -o "$tmp/m.tgz"
mkdir -p "$tmp/x"
tar -xzf "$tmp/m.tgz" -C "$tmp/x" --strip-components=1
mkdir -p "$DEST"
cp "$tmp/x"/*.c "$tmp/x"/*.h "$DEST/"
# m68kcpu.h includes softfloat unconditionally for the 040 FPU, even though we
# only ever run a 68000.
cp -r "$tmp/x/softfloat" "$DEST/"

echo "vendored to $DEST"
ls "$DEST"
