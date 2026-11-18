> Historical handoff for 2.2.1. The current Mac build and known limitations are documented in [README_MAC.txt](README_MAC.txt). The updater dependency and placeholder URL below do not describe the current release workflow.

# Mac Port Instructions — Vapormint 2.2.1

Port the Windows v2.2.1 codebase to macOS. The source code (App.tsx, shared.ts,
preload.ts, styles.css, media.ts) is already cross-platform — this doc covers
only the platform-specific changes needed to build and run on Mac.

---

## 1. `forge.config.ts` — Replace makers and icon

The Windows config uses MakerSquirrel and `.ico`. Replace with DMG + ZIP:

```ts
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDmg } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'Vapormint',
    icon: 'assets/icon',  // Forge appends .icns on Mac, .ico on Windows
    extraResource: ['./runtime', './scripts', './assets'],
    // Ad-hoc signing (runs on your own machine without Apple Developer ID):
    osxSign: { identity: '-' },
    // For distribution, replace with Developer ID + notarization:
    // osxSign: { identity: 'Developer ID Application: Your Name' },
    // osxNotarize: { teamId: 'TEAM_ID', appleId: 'you@email.com', appleIdPassword: 'APP_PASSWORD' },
  },
  makers: [
    new MakerDmg({ name: 'Vapormint', icon: 'assets/icon.icns' }),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.mts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.mts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
  ],
};

export default config;
```

Install the makers:
```bash
npm install --save-dev @electron-forge/maker-dmg @electron-forge/maker-zip
```

You'll need `assets/icon.icns` alongside the existing `assets/icon.ico`.

---

## 2. `src/main.ts` — Guard Squirrel startup

The current code runs `if (squirrelStartup) app.quit();` unconditionally.
`electron-squirrel-startup` is a no-op on darwin but the guard should be
explicit:

```ts
if (squirrelStartup && process.platform === 'win32') app.quit();
```

---

## 3. `src/main.ts` — Mac menu bar

macOS apps need an explicit application menu for Cmd+C/V/X/A to work.
Add after `app.whenReady()`:

```ts
import { Menu } from 'electron';

if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', label: 'Vapormint' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}
```

---

## 4. `src/styles.css` — Titlebar padding

The Windows build uses `padding: 0 140px 0 20px` on `.titlebar` to clear
Electron's window controls overlay (~138px). On macOS the traffic lights are
on the left and much narrower (~70px). Use a platform class or media query:

```css
/* Mac: traffic lights are on the left */
.platform-darwin .titlebar { padding: 0 20px 0 80px; }
```

Set the class from `main.ts` when creating the window (or from the renderer
via `navigator.platform`). Alternatively, keep the current padding — it
works, it just wastes space on the right.

---

## 5. Runtime binaries — `runtime/darwin-arm64/`

`media.ts` already resolves tools via `process.platform` + `process.arch`:
```ts
path.join(process.resourcesPath, 'runtime', `${process.platform}-${process.arch}`)
```

Create the macOS runtime folder matching that convention:
```
runtime/
  darwin-arm64/           (Apple Silicon)
    python3               (or python/python3)
    ffmpeg
    ffprobe
    Lib/
      site-packages/
        vapoursynth/
          __init__.py
          ...
        vapoursynth-plugins/
          ...
    vspipe                (or inside Lib/site-packages/vapoursynth/)
```

For Intel Macs, use `darwin-x64/` instead (or both for universal support).

Sources:
- Python: python.org macOS installer or Homebrew, then copy the standalone tree
- FFmpeg/FFprobe: static builds from evermeet.cx or BtbN GitHub releases
- VapourSynth + vspipe: build from source or use Homebrew `vapoursynth`

The Windows `runtime/win32-x64/` folder is not needed on Mac and should not
be packaged (remove it or exclude it in the Mac forge config's
`extraResource`).

---

## 6. `local-media:` protocol — No changes needed

The custom `local-media:` protocol is registered in `main.ts` via
`protocol.registerSchemesAsPrivileged` and `protocol.handle`. It serves local
files with Range request support. This works identically on macOS — no changes
needed. The CSP in `index.html` already allows `local-media:` for `img-src`
and `media-src`.

---

## 7. `window-all-closed` — Already correct

The existing handler in `main.ts`:
```ts
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```
This is standard macOS behavior (app stays in dock when all windows close).

---

## 8. Code signing and Gatekeeper

**For personal use (your own Mac):**
- Ad-hoc signing (`osxSign: { identity: '-' }`) is enough.
- First launch: right-click → Open, or `xattr -cr /Applications/Vapormint.app`.

**For distribution:**
- Requires Apple Developer ID ($99/yr).
- Add `osxNotarize` to forge config (see step 1).
- Without notarization, Gatekeeper blocks the app for other users.

---

## 9. Auto-updater

The current Windows build uses `electron-squirrel-startup` for Squirrel
updates. On Mac, `electron-updater` (already a dependency) can use the
generic provider. Add a feed URL in `main.ts`:

```ts
import { autoUpdater } from 'electron-updater';
autoUpdater.setFeedURL({ provider: 'generic', url: 'https://your-cdn.com/updates/mac' });
```

The feed must host `latest-mac.yml` + the ZIP from `npm run make`.
Until a feed is set up, the "Check for updates" button will fail gracefully
("Update check failed").

---

## 10. Paths reference

| Item | macOS path |
|------|-----------|
| App bundle | `/Applications/Vapormint.app` |
| Resources | `Vapormint.app/Contents/Resources/` |
| Runtime tools | `Contents/Resources/runtime/darwin-arm64/` |
| Scripts | `Contents/Resources/scripts/cf_analysis.py` |
| User data | `~/Library/Application Support/Vapormint/` |
| Diagnostics log | `~/Library/Application Support/Vapormint/diagnostics.log` |
| Preferences | `~/Library/Application Support/Vapormint/preferences.json` |
| Project library | `~/Movies/Vapormint/` (default) |

---

## 11. What's already cross-platform (no changes needed)

These areas already work on both platforms:

- **Fonts**: Google Fonts (Cormorant Garamond, Inter, IBM Plex Mono) load via
  CDN — no platform fonts bundled. macOS fallback stack in CSS uses Georgia
  and system sans-serif.
- **CSS tokens**: All 15 color tokens + 2 font family tokens are
  platform-agnostic. Palette themes (Notflix, Wholou, Disnee Plus) with
  dark + light variants work unchanged.
- **ClipReel**: The homescreen clip reel (`loadReelClips` IPC) reads
  session.json files and constructs `local-media:` URLs from
  `pathToFileURL().href.replace('file:', 'local-media:')` — works on both
  platforms since `pathToFileURL` handles path separators.
- **Process killing**: `media.ts` already checks
  `process.platform === 'win32'` for `taskkill.exe` vs `child.kill()`.
- **Executable resolution**: `executableName()` appends `.exe` only on
  Windows.
- **All React UI**: App.tsx, shared.ts, preload.ts — pure cross-platform.

---

## 12. Build and verify

```bash
npm install
npm run typecheck
npm run make
```

Verify:
- [ ] App launches from the .dmg
- [ ] Cormorant Garamond + Inter + IBM Plex Mono render (not system fallback)
- [ ] Homescreen clip reel plays clips from all projects
- [ ] Dark/Light toggle and palette themes work
- [ ] Video playback via `local-media:` protocol works
- [ ] Import, clip, and export a short video
- [ ] Self-tune fires on clip selection
- [ ] Cmd+C/V/X/A work (menu bar)
- [ ] Diagnostics log appears in `~/Library/Application Support/Vapormint/`
- [ ] Window traffic lights (close/min/zoom) don't overlap UI
