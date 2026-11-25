# LQ’s Cutting Floor — Changelog

## 2.3.5 — November 24, 2026

### Fixed

- Exports no longer carry the source's chapter track or 5.1 audio (now stereo), both suspects for Photoshop refusing to open clips.
- Self-tune no longer overwrites recipe edits when you leave and return to Process clips, and Export waits until self-tune finishes.
- Self-tune judges interlacing, banding, noise, and softness independently instead of nearly always choosing denoise only; interlace detection now works on real footage.
- Rotation is applied in FFmpeg compatibility exports and self-tune previews.
- Batch export locks the workspace, keeps going past a failed clip, and can be stopped from Find moments.
- Receipts are named after the actual output file and appear after single exports; the Engine Policy menu shows the clip's real setting; cancelling no longer shows an error.
- Mac updater: a full disk can no longer crash the app, and a failed copy can no longer remove the installed app.

### Added

- Windows in-app updates: "Install update" downloads and installs the new version, then asks to restart.
- "✦ self-tune applied this" marks on settings self-tune turned on.
- Sources with an empty analysis (imported from the old Mac app) analyze themselves when opened, plus an "Analyze N empty sources" button.

## 0.3.24 — September 25, 2026

### Fixed

- YouTube’s “Sign in to confirm you’re not a bot” response no longer leaves the user at a raw yt-dlp error.
- Failed authenticated downloads reopen the download setup instead of creating duplicate projects.
- Browser-cookie extraction failures now produce clear recovery instructions.

### Added

- Optional browser sign-in for YouTube and other yt-dlp-supported sites using Edge, Chrome, Firefox, or Brave.
- Browser cookies are read directly by yt-dlp for the requested download; Cutting Floor does not save or export them.
- A Windows update helper that locates the standard installation, verifies the release checksum and version, updates in place, and reopens the app.

### Source guidance

- Analysis now samples multiple locations across a source instead of relying only on its opening seconds.
- Guidance distinguishes metadata from measured cadence, frame-timing, color, freeze, and decode evidence.
- Findings include confidence levels and playback checks.
- Suggested recipes no longer automatically enable denoise, sharpening, restoration, debanding, inverse telecine, or motion interpolation without sufficient evidence.
- Existing projects can reanalyze sources to generate the improved guidance.

### Notes

- Public downloads still depend on the source website and yt-dlp. Authentication, DRM, regional restrictions, expired browser sessions, or website changes can still prevent individual downloads.
- Existing projects, source files, settings, and completed exports are preserved during installation updates.

## 0.3.23 — September 23, 2026

- Introduced distributed source analysis and confidence-based processing guidance.
- Added timestamp-based variable-frame-rate clues and safer color/cadence recommendations.
- Changed new clip recipes to begin without automatic cleanup filters.

