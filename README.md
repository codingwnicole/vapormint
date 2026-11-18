<p align="center">
  <img src="assets/icon-256.png" width="160" height="160" alt="Vapormint" />
</p>

<h1 align="center">Vapormint</h1>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#the-brain">The Brain</a> ·
  <a href="#shortcuts">Shortcuts</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="#releases">Releases</a>
</p>

<p align="center">
  <b>Cross-platform desktop video sifting &amp; VapourSynth processing studio.</b><br/>
  Open a clip, watch the pixels decide the recipe, export an honest master.
</p>

---

## What it is

Vapormint is a darkroom for video. You point it at footage — a concert TS, a WEB-DL episode, a 4K facecam, a soft 720p upload — and it:

1. **Looks at the actual pixels**, not just the container tags, and tells you what's really there: interlacing, telecine cadence, noise, banding, HDR, softness.
2. **Writes an evidence-based recipe** back into the clip — conservative by design, the way the community's own tutorials say to do it.
3. **Renders it through a bundled VapourSynth runtime** so you can export without installing a single external tool.

No Python to set up. No FFmpeg to install. No plugin hunt. Everything ships inside the installer.

---

## Install

### Windows

1. Download **`VapormintSetup.exe`** from the [latest release](#releases).
2. If Windows SmartScreen warns ("Windows protected your PC"), click **More info** → **Run anyway**. The build is unsigned — that's why.
3. That's it. Python 3.12, FFmpeg, FFprobe, and the VapourSynth core + plugins are all bundled.

**System requirements:** Windows 10 / 11, x64, ~2 GB free disk. A GPU is **not** required; rendering is CPU-based.

### macOS (Apple Silicon)

1. Download **`Vapormint-darwin-arm64.dmg`** from the [latest release](#releases).
2. Open the DMG and drag Vapormint to Applications.
3. **Before launching**, open Terminal and run:
   ```bash
   sudo xattr -cr /Applications/Vapormint.app
   ```
   This removes the quarantine flag macOS adds to downloaded apps. Without it, Gatekeeper will say the app is "damaged" because the build is unsigned. You only need to do this once.
4. That's it. Python 3.12, FFmpeg, FFprobe, yt-dlp, and VapourSynth core + plugins are all bundled — same as Windows.

**System requirements:** macOS 15+, Apple Silicon (M1 or later). Intel Macs are not supported.

**Coming from LQ's Cutting Floor (native Swift app)?** Vapormint auto-imports your projects on first launch — originals stay in place, recipes and completed status carry over.

---

## Features

### Self-Tune (auto-preview)
Open a clip and Vapormint renders a 1-second preview from the current recipe, measures the pixels, and writes evidence-based fixes back into the recipe — automatically. Expand **"Why these settings?"** to see exactly what the analysis found: interlacing evidence, noise level, banding detection, sharpening rationale. **Re-tune** re-runs the analysis whenever you change something by hand.

### Source Guidance
Plain-language verdicts you can actually act on:
- *"Interlacing confirmed — deinterlacing is enabled."*
- *"Progressive (normal) footage — no deinterlacing needed."*
- *"Cadence not yet confirmed by sampling — self-tune will check the rendered preview for interlacing."*

Plus a **"What to look for"** checklist and a **Video stats** panel with every measured value.

### A24 / Freshman design system
- **Cormorant Garamond** (serif headings), **Inter** (body), **IBM Plex Mono** (timestamps & technical).
- Zero border-radius, zero box-shadows, zero gradients. Depth from value contrast and 1px hairlines.
- Three palette themes (Notflix, Wholou, Disnee Plus), each with dark + light variants.
- 15 CSS color tokens, 2 font family tokens — nothing hardcoded.

### Batch export queue
Mark multiple clips and render them all in one pass, sequentially, with per-clip progress and a live progress bar in the queue panel. Cancellable mid-batch.

### Thumbnailed clip list
Browse clips with thumbnail previews and filter by status (queued, reviewed, all) in the Process tab.

### Render receipts
Every export writes an **auditable receipt** — the exact recipe, source measurements, engine, output paths, and the generated `.vpy` script — so you can reproduce any master, forever.

### Honest pixel callouts
When the container says one thing and the pixels say another (e.g. "tagged progressive but combing detected"), Vapormint tells you in plain language instead of silently picking a side.

### Tool updates & auto-updater
- **Check for updates** from Settings — platform-aware, finds the right installer for your OS.
- **yt-dlp** can be updated in-place from Settings (the only tool that self-updates).
- **Report a bug / suggest a feature** from Settings (saved locally as JSON).
- Every console line and export/preview-tune failure logged to `diagnostics.log`.

---

<p align="center">
  <img src="docs/ui-review-home-dark-0.3.18-fixes.png" width="900" alt="Vapormint — home, dark theme" />
</p>

---

## The Brain

Every recipe suggestion comes from a measurement pipeline, not a preset. The rules below are distilled from community VapourSynth processing practice (methodology notes in [`docs/methodology.md`](docs/methodology.md)). The one thing practitioners agree on is the **order**:

```
Crop → Deinterlace → Debilinear → Denoise → Sharpen → Crop
         (if interlaced)  (if soft)  (grain first, never after sharpen)
```

| Source condition | Deinterlace | Debilinear | Denoise | Sharpen | Why |
|---|---|---|---|---|---|
| Interlaced TS/TP | **QTGMC Slow** | off | light | FineSharp 0.3–0.5 | "TS/TP must be deinterlaced before you clip it." |
| Telecine 3:2 / 2:2 | **QTGMC Quality** | off | light | FineSharp | Max motion fidelity for 24→30 pull-down. |
| Soft / low-res | off (prog) | **on** | moderate | VCFreq 0.3–0.4 | Debilinear makes upscaled footage sit soft, not outlined. |
| Clean 1080p WEB-DL | off | off | off/light | none | Good masters need almost nothing. Over-processing is the failure mode. |
| Noisy (low bitrate) | per scanType | off | **strong** | after denoise | Grain goes before any sharpening. |
| Banding (gradients, HDR) | per scanType | off | off | off + **deband** | Luma banding → deband, not denoise. |

**The golden rule** (enforced by the brain): *never sharpen before you denoise, and never auto-max anything.* The brain gives a safe **starting** recipe; your eyes make the final call.

---

## Shortcuts

| Key | Action |
|-----|--------|
| `I` / `O` | Mark In / Out |
| `Enter` | Queue the marked clip |
| `Space` | Play / Pause |
| `←` / `→` | Step one frame (hold `Shift` for one second) |

---

## Build from source

Requires Node.js (tested on Node 24) and npm.

```bash
git clone https://github.com/hxxliz/vapormint.git
cd vapormint
npm install
npm run check        # domain + sidebar self-tests
npm run typecheck    # tsc --noEmit
npm run check:mac    # Mac migration, update-release, and tool-update checks
npm run make         # produce installer for the current platform
```

**Windows:** The finished installer lands in `out/make/squirrel.windows/x64/VapormintSetup.exe`.

**macOS:** The DMG and ZIP land in `out/make/`. See [`README_MAC.txt`](README_MAC.txt) for Mac-specific build prerequisites and runtime assembly.

> **Line endings:** the repo enforces LF via `.gitattributes` (`* text=auto eol=lf`). The self-tests assert on multi-line source strings, so keep the sources LF — a CRLF checkout will break them.

---

## Releases

Releases live on [GitHub](https://github.com/hxxliz/vapormint/releases). Each release attaches platform-specific assets:

| Asset | Platform | What it is |
|-------|----------|-----------|
| `VapormintSetup.exe` | Windows | Squirrel installer. Run it, that's the whole install. |
| `Vapormint-<version>-full.nupkg` | Windows | Full Squirrel package (what the in-app updater consumes). |
| `Vapormint-darwin-arm64.dmg` | macOS | Disk image for Apple Silicon Macs. |
| `Vapormint-darwin-arm64-<version>.zip` | macOS | ZIP archive alternative. |

The app's **Check for updates** detects your platform and finds the right asset automatically via `findCompatibleRelease()`.

---

## What's in the box

The Windows installer bundles the whole toolchain, so you never touch a terminal:

- **Python 3.12** (Windows x64, embedded layout)
- **FFmpeg + FFprobe** (decode, frame sampling, export)
- **yt-dlp** (source downloads)
- **VapourSynth** core + the plugins the recipes use (QTGMC, KNLMeansCL, Finesharp, VCFreq, deband, descale, ...)
- The **Vapormint** app itself (Electron + React)

Both platforms bundle the full toolchain. On macOS, yt-dlp can also self-update from `~/Library/Application Support/Vapormint/tools/`.

---

## Project layout

| Path | Purpose |
|------|---------|
| `src/shared.ts` | Recipe model, the "brain" (evidence → recipe), receipts, self-tune |
| `src/media.ts` | Decode, sampling, export orchestration, runtime tool resolution |
| `src/main.ts` | Electron main: window, IPC, updater, feedback, diagnostics |
| `src/App.tsx` | The UI (darkroom) |
| `src/styles.css` | The design system (all colors are custom properties) |
| `src/mac-migration.ts` | macOS: import projects from native LQ's Cutting Floor |
| `src/tool-updates.ts` | macOS: SHA256-verified yt-dlp downloads |
| `src/update-release.ts` | Platform-aware release matching (`findCompatibleRelease`) |
| `runtime/win32-x64/` | Bundled Python + FFmpeg + VapourSynth (Windows) |
| `scripts/cf_analysis.py` | The pixel-analysis "brain" the recipes are derived from |
| `scripts/build-mac-runtime.sh` | Mac runtime assembly script |
| `docs/methodology.md` | Processing-chain methodology and decision tables |

---

## Changelog

### 2.3.0
- macOS Apple Silicon port (DMG + ZIP installers, bundled runtime, Mac menu bar)
- Native LQ's Cutting Floor project import on Mac (plist migration, recipe + completed status preserved)
- Platform-aware update checker (`findCompatibleRelease` — both installers on one release tag)
- SHA256-verified yt-dlp downloads on Mac
- In-app dependency updater (yt-dlp self-update from Settings)
- Thumbnailed clip list with status filters in Process tab
- Sidebar pipeline status fix (overflow, layout)
- Dynamic version from package.json (no more hardcoded version strings)
- Design system: A24/Freshman (Cormorant Garamond + Inter + IBM Plex Mono), three palette themes (Notflix, Wholou, Disnee Plus) with dark + light variants

### 2.1.0
- Export pipeline fixes: BestSource disk caching, deferred FFmpeg spawn, import-time pre-indexing
- Indexing progress in the UI
- In-place upgrade from LQ's Cutting Floor (auto-adopts existing projects)
- Runtime lockfile + reproducible build script
- In-app version info (Settings)
- UI polish: entrance animations, list stagger, mark feedback, skeleton pulse, theme crossfade, WCAG AA contrast fix
- Security hardening: IPC path validation on `receipt:read`, URL validation on `feedback:open`

### 2.0.0
- Self-Tune auto-preview with evidence-based recipe write-back
- Source Guidance: plain-language verdicts, checklists, video stats
- Batch export queue with per-clip progress + live progress bar
- Render receipts (auditable export records)
- Honest pixel callouts (tag-vs-pixel reconciliation)
- Auto-updater, feedback reports, `diagnostics.log`

<details>
<summary><b>0.3.x (LQ's Cutting Floor)</b></summary>

- 0.3.24 — YouTube bot-check recovery, browser-cookie downloads, Windows update helper, distributed source analysis
- 0.3.23 — Distributed source analysis + confidence-based guidance; new clips start with no auto-cleanup
</details>

---

<p align="center"><sub>
Vapormint — <i>the darkroom for video.</i><br/>
Open source. Bundled runtime. Honest pixels.
</sub></p>
