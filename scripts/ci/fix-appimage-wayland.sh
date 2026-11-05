#!/usr/bin/env bash
# Strip bundled libwayland-* from a Tauri AppImage so host Mesa/Wayland work
# on Arch/Manjaro/Fedora (EGL_BAD_PARAMETER). Re-pack with appimagetool.
set -euo pipefail

APPIMAGE_PATH="${1:?usage: fix-appimage-wayland.sh <AppImage> [output-path]}"
OUTPUT_PATH="${2:-$APPIMAGE_PATH}"

if [[ ! -f "$APPIMAGE_PATH" ]]; then
  echo "error: AppImage not found: $APPIMAGE_PATH" >&2
  exit 1
fi

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ABS_IN="$(cd "$(dirname "$APPIMAGE_PATH")" && pwd)/$(basename "$APPIMAGE_PATH")"
cp "$ABS_IN" "$WORK/input.AppImage"
chmod +x "$WORK/input.AppImage"

echo "==> Extracting AppImage"
cd "$WORK"
./input.AppImage --appimage-extract >/dev/null

ROOT="$WORK/squashfs-root"
if [[ ! -d "$ROOT" ]]; then
  echo "error: extraction failed (no squashfs-root)" >&2
  exit 1
fi

echo "==> Removing bundled Wayland libraries"
mapfile -t WAYLAND_LIBS < <(find "$ROOT" -type f \( -name 'libwayland-*.so*' -o -name 'libwayland-*.so' \) 2>/dev/null || true)
if [[ ${#WAYLAND_LIBS[@]} -eq 0 ]]; then
  echo "warning: no libwayland-* files found; AppImage may already be clean"
else
  printf '  removed: %s\n' "${WAYLAND_LIBS[@]}"
  rm -f "${WAYLAND_LIBS[@]}"
fi

# Prefer continuous appimagetool; falls back if already on PATH.
if ! command -v appimagetool >/dev/null 2>&1; then
  echo "==> Downloading appimagetool"
  curl -fsSL -o "$WORK/appimagetool" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$WORK/appimagetool"
  APPIMAGETOOL=("$WORK/appimagetool")
  # No FUSE on many CI runners.
  export APPIMAGE_EXTRACT_AND_RUN=1
else
  APPIMAGETOOL=(appimagetool)
fi

OUT_NAME="$(basename "$OUTPUT_PATH")"
# Extraction can leave owner-only modes. Make the packaged tree usable by other users.
chmod -R a+rX -- "$ROOT"
echo "==> Repacking -> $OUT_NAME"
ARCH=x86_64 "${APPIMAGETOOL[@]}" "$ROOT" "$WORK/$OUT_NAME"
chmod +x "$WORK/$OUT_NAME"

mkdir -p "$(dirname "$OUTPUT_PATH")"
cp -f "$WORK/$OUT_NAME" "$OUTPUT_PATH"
echo "==> Wrote $OUTPUT_PATH"
