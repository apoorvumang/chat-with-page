#!/usr/bin/env bash
# Vendor the shared libs headless Chromium needs but that aren't installed
# system-wide, WITHOUT root. Downloads the .deb packages with `apt-get download`
# (no root required), extracts the .so files into ./_libs/flat, and leaves them
# for e2e.mjs to pick up automatically via LD_LIBRARY_PATH.
#
# Run this once if `npm run test:e2e` complains about libgbm.so.1.
set -euo pipefail

cd "$(dirname "$0")"
DEST="$PWD/_libs"
FLAT="$DEST/flat"

# Already vendored? Nothing to do.
if [ -f "$FLAT/libgbm.so.1" ]; then
  echo "libs already present in $FLAT"
  exit 0
fi

mkdir -p "$DEST/debs" "$FLAT"
cd "$DEST/debs"

# libgbm1 pulls in libwayland-server0; add more here if Chromium reports others.
PKGS="libgbm1 libwayland-server0"
echo "downloading: $PKGS"
apt-get download $PKGS

for d in *.deb; do
  dpkg-deb -x "$d" "$DEST/extracted"
done

find "$DEST/extracted" -name '*.so*' -exec cp -Pv {} "$FLAT/" \; >/dev/null
echo "vendored libs into $FLAT:"
ls -1 "$FLAT"
