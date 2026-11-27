#!/bin/sh
# Assemble the bundled x64 Linux runtime into runtime/linux-x64/ (same layout as darwin-arm64:
# python/ + python3/vspipe wrappers + ffmpeg/ffprobe/yt-dlp). Versions mirror runtime/lock.json.
set -eu
cd "$(dirname "$0")/.."
test "$(uname -m)" = x86_64 || { echo 'x86_64 is required for this runtime.' >&2; exit 1; }
root=runtime/linux-x64
if test -e "$root"; then echo "Move or back up $root before rebuilding it." >&2; exit 1; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$root"

# ponytail: python-build-standalone pin; bump the date tag to update
curl -fsSL 'https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz' | tar -xz -C "$root"
"$root/python/bin/python3" -m pip install --no-cache-dir --only-binary=:all: -q \
  vapoursynth==79 vapoursynth_bestsource==21.0 vapoursynth_bm3d==10.1 vapoursynth_bwdif==5.1 \
  vapoursynth_cas==3.0 vapoursynth_descale==12 vapoursynth_mvtools==29 vapoursynth_mvutensils==8 \
  vapoursynth_resize2==0.5.1 vapoursynth_vivtc==2.0 vapoursynth_znedi3==3.3 \
  vapoursynth_akarin==1.5.0 vapoursynth_vszip==22.1.0 \
  vsdeinterlace==0.9.3 vsjetpack==2.2.4 numpy psutil rich

# ponytail: BtbN "latest" 9.0 branch drifts within 9.0.x; mirror it as a release asset if bit-for-bit matters
curl -fsSL 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz' | tar -xJ -C "$tmp"
cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$root/"
curl -fsSL -o "$root/yt-dlp" 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux'

cp scripts/mac-runtime/python3 scripts/linux-runtime/vspipe "$root/"
chmod +x "$root/python3" "$root/vspipe" "$root/ffmpeg" "$root/ffprobe" "$root/yt-dlp"

"$root/ffmpeg" -version | head -1
"$root/yt-dlp" --version
"$root/vspipe" --info scripts/runtime-probe.vpy -
