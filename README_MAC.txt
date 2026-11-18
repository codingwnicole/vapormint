Vapormint 2.2.2 — Apple Silicon test build

This build supports Apple Silicon Macs running macOS 15 or later.
Extract the ZIP and move Vapormint.app to Applications. It is an unsigned,
non-notarized test build; macOS may warn before opening it.

The app includes its own FFmpeg, FFprobe, VapourSynth, Python, filters and
yt-dlp. Projects and preferences are stored separately from the application.
On first use, supported native Cutting Floor projects are imported as copies;
the original session files remain in place. Imported copies retain a backup
of their original session data. Review clip settings before processing.
This is an early Mac build: test with copies before relying on it for production.
An Intel Mac build is not included.

The source checkout's runtime/darwin-arm64 directory is ignored by git and
must be assembled separately for future builds. It incorporates the runtime
from the existing Cutting Floor installation plus the MVUtensils 8 plugin and
FFprobe libraries. Keep this runtime for reproducible local builds.

MAC UPDATES
-----------
The current Windows application checks GitHub Releases and opens the release
page for manual installation. This Mac build does the same, but only announces
releases with a compatible Mac asset. The repository currently has no Mac
release asset or automatic update feed. This test build is not notarized.
In Settings > About, check for yt-dlp updates and install an available release.
Vapormint verifies the official SHA-256 and version before switching to it;
the bundled copy remains available. FFmpeg, FFprobe, and VapourSynth are
updated with future Vapormint releases.

REBUILDING
----------
Install the existing Cutting Floor app, Homebrew FFprobe, and download the
macOS arm64 MVUtensils 8 wheel. Run:
  scripts/build-mac-runtime.sh /path/to/vapoursynth_mvutensils-8-macos-arm64.whl
Then run npm ci and npm run package on an Apple Silicon Mac. The script will
not overwrite an existing runtime. The runtime stays outside Git.
