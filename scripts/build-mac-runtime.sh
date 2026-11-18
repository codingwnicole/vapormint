#!/bin/sh
# Assemble an Apple Silicon development runtime from the installed legacy app.
set -eu
cd "$(dirname "$0")/.."
legacy_app=${VAPORMINT_LEGACY_APP:-}
if [ -z "$legacy_app" ]; then legacy_app="/Applications/LQ's Cutting Floor 3.0.app"; fi
legacy="$legacy_app/Contents/Resources"
wheel=${1:?Usage: scripts/build-mac-runtime.sh /path/to/vapoursynth_mvutensils-8-macos-arm64.whl}
case "$wheel" in /*) ;; *) wheel="$PWD/$wheel" ;; esac
test "$(uname -m)" = arm64 || { echo 'Apple Silicon is required for this runtime.' >&2; exit 1; }
test -f "$wheel" && test -x "$legacy/ffmpeg-arm64" || { echo 'Legacy app or plugin wheel missing.' >&2; exit 1; }
root=runtime/darwin-arm64
if test -e "$root"; then echo "Move or back up $root before rebuilding it." >&2; exit 1; fi
mkdir -p "$root"
ditto "$legacy/VapourSynthRuntime-arm64/python" "$root/python"
cp "$legacy/ffmpeg-arm64" "$root/ffmpeg"
cp "$legacy/yt-dlp" "$root/yt-dlp"
cp scripts/mac-runtime/python3 scripts/mac-runtime/vspipe "$root/"
chmod +x "$root/python3" "$root/vspipe"
unzip -oq "$wheel" -d "$root/python/lib/python3.12/site-packages"
python3 scripts/mac-runtime/bundle-ffprobe.py "$(command -v ffprobe)"
"$root/ffprobe" -version >/dev/null
"$root/vspipe" --info scripts/runtime-probe.vpy -
