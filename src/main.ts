import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { watch, type FSWatcher, createWriteStream, createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { importMacProjects } from './mac-migration';
import { findCompatibleRelease, findDmgAsset, type Release } from './update-release';
import { tmpdir } from 'node:os';
import { capture, executable, checkMacToolUpdates, updateMacTool, downloadPublicVideo, getRuntimeStatus, prepareSource, probeMedia, processClip, stopMediaProcesses, tunePreview } from './media';
import { buildReceipt, assertPublicVideoUrl, defaultRecipe, safeFileName, type DownloadBrowser, type ExportRequest, type FeedbackReport, type ProjectCard, type ReelClip, type StudioPreferences, type StudioSession, type StudioSource, type ToolVersionInfo, type UpdateInfo, type WorkspaceState } from './shared';

protocol.registerSchemesAsPrivileged([{ scheme: 'local-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.platform === 'win32' && squirrelStartup) app.quit();

// Redirect console.log/error/warn to a log file so diagnostics survive
const diagLogPath = path.join(app.getPath('userData'), 'diagnostics.log');
const diagStream = createWriteStream(diagLogPath, { flags: 'a' });
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
const origWarn = console.warn.bind(console);
console.log = (...args: unknown[]) => { origLog(...args); diagStream.write(new Date().toISOString() + ' [LOG] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n'); };
console.error = (...args: unknown[]) => { origErr(...args); diagStream.write(new Date().toISOString() + ' [ERR] ' + args.map(a => typeof a === 'object' ? (a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)) : String(a)).join(' ') + '\n'); };
console.warn = (...args: unknown[]) => { origWarn(...args); diagStream.write(new Date().toISOString() + ' [WRN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n'); };

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts']);
let mainWindow: BrowserWindow | null = null;
let exportController: AbortController | null = null;
let taskController: AbortController | null = null;
let activeSession: StudioSession | null = null;
const watchers = new Map<string, { watcher: FSWatcher; projectId: string }>();
const watchTimers = new Map<string, NodeJS.Timeout>();

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function showFatalError(title: string, error: unknown) {
  const message = `${errorMessage(error)}\n\nYour projects remain saved. Restart the app and try again.`;
  if (app.isReady()) dialog.showErrorBox(title, message);
  else console.error(title, message);
}

function stopBackgroundWork() {
  exportController?.abort();
  taskController?.abort();
  stopMediaProcesses();
  for (const timer of watchTimers.values()) clearTimeout(timer);
  watchTimers.clear();
  for (const { watcher } of watchers.values()) watcher.close();
  watchers.clear();
}

const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');
const legacySessionPaths = () => [
  path.join(app.getPath('userData'), 'current-session.json'),
  ...legacyAppDataPaths().map((p) => path.join(p, 'current-session.json')),
];
const defaultPreferences = (): StudioPreferences => ({
  libraryPath: path.join(app.getPath('documents'), "Vapormint", 'Projects'),
  downloadPath: path.join(app.getPath('videos'), "Vapormint", 'Downloaded Masters'),
  exportPath: path.join(app.getPath('videos'), "Vapormint", 'Finished Clips'),
  expertMode: false,
  theme: 'dark',
  onboardingComplete: false,
});
const fallbackPreferences = (): StudioPreferences => {
  const localAppData = process.env.LOCALAPPDATA;
  const root = path.join(localAppData && path.isAbsolute(localAppData) ? localAppData : app.getPath('userData'), "Vapormint");
  return {
    libraryPath: path.join(root, 'Projects'),
    downloadPath: path.join(root, 'Downloaded Masters'),
    exportPath: path.join(root, 'Finished Clips'),
    expertMode: false,
    theme: 'dark',
    onboardingComplete: false,
  };
};

const emptySession = (name = 'Untitled Vapormint'): StudioSession => ({
  version: 6, id: crypto.randomUUID(), name, created: new Date().toISOString(), updated: new Date().toISOString(), sources: [], clips: [], watchFolders: [],
});

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const data = JSON.stringify(value, null, 2);
  const tmp = file + '.tmp';
  // ponytail: rename can ENOENT on Windows (antivirus scans .tmp); fall back to direct write
  try { await writeFile(tmp, data, 'utf8'); await rename(tmp, file); } catch { await writeFile(file, data, 'utf8'); }
}

// ponytail: migrate from "LQ's Cutting Floor" on first launch
const legacyAppDataPaths = () => [
  path.join(app.getPath('appData'), "LQ's Cutting Floor"),
  path.join(app.getPath('appData'), 'LQ-Cutting-Floor'),
];

async function loadPreferences() {
  try { return { ...defaultPreferences(), ...JSON.parse(await readFile(preferencesPath(), 'utf8')) } as StudioPreferences; }
  catch {
    for (const legacy of legacyAppDataPaths()) {
      try {
        const old = JSON.parse(await readFile(path.join(legacy, 'preferences.json'), 'utf8'));
        return { ...defaultPreferences(), ...old } as StudioPreferences;
      } catch { /* Try next legacy path. */ }
    }
    if (process.platform === 'darwin') {
      const plist = path.join(app.getPath('home'), 'Library', 'Preferences', 'local.lq.cuttingfloor.plist');
      const readSetting = (key: string) => {
        try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim(); }
        catch { return ''; }
      };
      const oldDownloads = readSetting('ClipSiftDownloadsPath');
      const oldExports = readSetting('ClipSiftExportsPath');
      const appearance = readSetting('lqCuttingFloor.appearance');
      return { ...defaultPreferences(), ...(path.isAbsolute(oldDownloads) ? { downloadPath:oldDownloads } : {}), ...(path.isAbsolute(oldExports) ? { exportPath:oldExports } : {}), ...(/^(dark|light)$/i.test(appearance) ? { theme:appearance.toLowerCase() as StudioPreferences['theme'] } : {}) };
    }
    return defaultPreferences();
  }
}

async function ensurePreferenceFolders(preferences: StudioPreferences, fallback?: StudioPreferences) {
  const resolved = { ...preferences };
  for (const key of ['libraryPath', 'downloadPath', 'exportPath'] as const) {
    try { await mkdir(resolved[key], { recursive: true }); }
    catch (error) { if (!fallback) throw error; resolved[key] = fallback[key]; await mkdir(resolved[key], { recursive: true }); }
  }
  return resolved;
}

async function persistPreferences(preferences: StudioPreferences, allowFallback = false) {
  const resolved = await ensurePreferenceFolders(preferences, allowFallback ? fallbackPreferences() : undefined);
  await atomicJson(preferencesPath(), resolved);
  return resolved;
}

function normalizeSession(value: Partial<StudioSession>): StudioSession {
  const now = new Date().toISOString();
  return {
    version: 6,
    id: value.id ?? crypto.randomUUID(),
    name: value.name?.trim() || 'Untitled Vapormint',
    created: value.created ?? now,
    updated: value.updated ?? value.created ?? now,
    activeSourceId: value.activeSourceId,
    watchFolders: value.watchFolders ?? [],
    sources: (value.sources ?? []).map((source) => ({
      ...source,
      missing: source.missing ?? false,
      sourceAnalysis: {
        ...source.sourceAnalysis,
        format: source.sourceAnalysis.format ?? 'unknown', pixelFormat: source.sourceAnalysis.pixelFormat ?? 'unknown', bitDepth: source.sourceAnalysis.bitDepth ?? 8,
        bitrate: source.sourceAnalysis.bitrate ?? 0, colorTransfer: source.sourceAnalysis.colorTransfer ?? 'unknown', hdr: source.sourceAnalysis.hdr ?? 'Unknown',
        scanType: source.sourceAnalysis.scanType ?? 'Unknown', fieldOrder: source.sourceAnalysis.fieldOrder ?? 'unknown', variableFrameRate: source.sourceAnalysis.variableFrameRate ?? false,
        qualitySummary: source.sourceAnalysis.qualitySummary ?? `${source.sourceAnalysis.width}×${source.sourceAnalysis.height} · ${source.sourceAnalysis.fps.toFixed(3)} fps`,
      },
    })),
    clips: (value.clips ?? []).map((clip) => {
      const legacy = clip.recipe as typeof clip.recipe & { fadeIn?: boolean; fadeOut?: boolean };
      const aspectPreset = ({ '16:9': 'One-column landscape · 540×304', Square: 'One-column square · 540×540', 'Portrait 4:5': 'One-column portrait · 540×675', 'Tall 2:3': 'One-column tall portrait · 540×810', Classic: 'Custom' } as Record<string, typeof legacy.aspectPreset>)[legacy.aspectPreset] ?? legacy.aspectPreset;
      return { ...clip, recipe: { ...defaultRecipe(), ...legacy, aspectPreset, outputFormat: legacy.outputFormat === ('PNG Sequence' as typeof legacy.outputFormat) ? 'ProRes 422' : legacy.outputFormat, denoise: legacy.denoise === ('Quality' as typeof legacy.denoise) ? 'Fine detail' : legacy.denoise, fade: legacy.fade ?? legacy.fadeIn ?? legacy.fadeOut ?? false } };
    }),
  };
}

const projectFolder = (session: StudioSession, preferences: StudioPreferences) => path.join(preferences.libraryPath, session.id);
const sessionFile = (id: string, preferences: StudioPreferences) => path.join(preferences.libraryPath, id, 'session.json');

async function refreshSourceUrls(source: StudioSource) {
  let missing = false;
  try { await access(source.sourcePath); } catch { missing = true; }
  let playbackPath = source.playbackPath;
  if (playbackPath) try { await access(playbackPath); } catch { playbackPath = undefined; }
  let thumbnailUrl: string | undefined;
  if (source.thumbnailPath) try { await access(source.thumbnailPath); thumbnailUrl = pathToFileURL(source.thumbnailPath).href; } catch { /* No cached thumbnail. */ }
  const fileUrl = pathToFileURL(playbackPath ?? source.sourcePath).href.replace('file://', 'local-media://local');
  return { ...source, playbackPath, fileUrl, thumbnailUrl: thumbnailUrl?.replace('file://', 'local-media://local'), missing };
}

async function loadProject(id: string, preferences: StudioPreferences) {
  const session = normalizeSession(JSON.parse(await readFile(sessionFile(id, preferences), 'utf8')) as StudioSession);
  session.sources = await Promise.all(session.sources.map(refreshSourceUrls));
  return session;
}

async function writeProject(session: StudioSession, preferences: StudioPreferences) {
  const saved = { ...session, updated: new Date().toISOString() };
  await atomicJson(sessionFile(saved.id, preferences), saved);
  return saved;
}

async function projectCards(preferences: StudioPreferences): Promise<ProjectCard[]> {
  await mkdir(preferences.libraryPath, { recursive: true });
  const entries = await readdir(preferences.libraryPath, { withFileTypes: true });
  const cards = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      const session = normalizeSession(JSON.parse(await readFile(sessionFile(entry.name, preferences), 'utf8')) as StudioSession);
      const thumbnailPath = session.sources.find((source) => source.thumbnailPath)?.thumbnailPath;
      let thumbnailUrl: string | undefined;
      if (thumbnailPath) try { await access(thumbnailPath); thumbnailUrl = pathToFileURL(thumbnailPath).href.replace('file://', 'local-media://local'); } catch { /* Keep card text-only. */ }
      return { id: session.id, name: session.name, updated: session.updated, thumbnailUrl, sourceCount: session.sources.length, clipCount: session.clips.length, completedCount: session.clips.filter((clip) => clip.completed).length } satisfies ProjectCard;
    } catch { return undefined; }
  }));
  return cards.filter((card): card is Exclude<typeof card, undefined> => card !== undefined).sort((a, b) => b.updated.localeCompare(a.updated));
}

async function workspace(session: StudioSession, preferences: StudioPreferences): Promise<WorkspaceState> {
  return { session, preferences, projects: await projectCards(preferences) };
}

async function loadWorkspace() {
  let firstRun = false;
  try { await access(preferencesPath()); } catch { firstRun = true; }
  let preferences = await persistPreferences(await loadPreferences(), firstRun);
  if (process.platform === 'darwin') {
    const home = app.getPath('home');
    const roots = [path.join(home, 'Movies', "LQ's Cutting Floor Library"), path.join(home, 'Movies', 'ClipSift Studio Library'), path.join(home, 'Movies', 'ClipSift Library')];
    try {
      const plist = path.join(home, 'Library', 'Preferences', 'local.lq.cuttingfloor.plist');
      const custom = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ClipSiftLibraryPath', plist], { encoding:'utf8', stdio:['ignore','pipe','ignore'] }).trim();
      if (path.isAbsolute(custom)) roots.push(custom);
    } catch { /* The old app may not have selected a custom library. */ }
    const migration = await importMacProjects(roots, preferences.libraryPath);
    if (migration.errors.length) console.warn('Some Cutting Floor projects could not be imported:', migration.errors);
  }
  let cards = await projectCards(preferences);
  let session: StudioSession = emptySession();
  const selected = cards.find((card) => card.id === preferences.activeProjectId) ?? cards[0];
  if (selected) session = await loadProject(selected.id, preferences);
  else {
    for (const legacyPath of legacySessionPaths()) {
      try { session = normalizeSession(JSON.parse(await readFile(legacyPath, 'utf8')) as StudioSession); session = await writeProject(session, preferences); cards = await projectCards(preferences); break; }
      catch { /* Try next legacy path. */ }
    }
  }
  preferences = await persistPreferences({ ...preferences, activeProjectId: cards.length ? session.id : undefined });
  activeSession = session;
  configureWatchers(session, preferences);
  return { session, preferences, projects: cards };
}

async function createProject(name: string) {
  const preferences = await loadPreferences();
  const session = await writeProject(emptySession(name.slice(0, 100).trim() || 'Untitled Vapormint'), preferences);
  const nextPreferences = await persistPreferences({ ...preferences, activeProjectId: session.id });
  activeSession = session;
  configureWatchers(session, nextPreferences);
  return workspace(session, nextPreferences);
}

async function openProject(id: string) {
  const preferences = await loadPreferences();
  const session = await loadProject(id, preferences);
  const nextPreferences = await persistPreferences({ ...preferences, activeProjectId: id });
  activeSession = session;
  configureWatchers(session, nextPreferences);
  return workspace(session, nextPreferences);
}

async function renameProject(id: string, name: string) {
  const preferences = await loadPreferences();
  const project = await loadProject(id, preferences);
  const saved = await writeProject({ ...project, name: name.slice(0, 100).trim() || project.name }, preferences);
  if (activeSession?.id === id) activeSession = saved;
  return workspace(activeSession ?? saved, preferences);
}

async function deleteProject(id: string) {
  const preferences = await loadPreferences();
  const project = await loadProject(id, preferences);
  const confirmation = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: 'Delete project?',
    message: `Delete “${project.name}” from the Vapormint library?`,
    detail: 'The session, cached thumbnails, and playback copies will be removed. Original source videos and finished exports will not be deleted.',
    buttons: ['Delete project', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return null;
  const library = path.resolve(preferences.libraryPath);
  const target = path.resolve(library, id);
  if (path.dirname(target).toLowerCase() !== library.toLowerCase()) throw new Error('The selected project path is invalid and was not deleted.');
  await rm(target, { recursive: true, force: true });
  const remaining = await projectCards(preferences);
  if (activeSession?.id !== id) return workspace(activeSession ?? (remaining[0] ? await loadProject(remaining[0].id, preferences) : emptySession()), preferences);
  const next = remaining[0] ? await loadProject(remaining[0].id, preferences) : emptySession();
  const nextPreferences = await persistPreferences({ ...preferences, activeProjectId: remaining.length ? next.id : undefined });
  activeSession = next;
  configureWatchers(next, nextPreferences);
  return workspace(next, nextPreferences);
}

async function saveSession(session: StudioSession) {
  if (session.version !== 6 || !session.id) throw new Error('This project cannot be saved because its session document is invalid.');
  const preferences = await loadPreferences();
  activeSession = await writeProject(session, preferences);
  await persistPreferences({ ...preferences, activeProjectId: session.id });
  configureWatchers(activeSession, preferences);
}

async function loadReelClips(): Promise<ReelClip[]> {
  const preferences = await loadPreferences();
  const entries = await readdir(preferences.libraryPath, { withFileTypes: true }).catch(() => []);
  const clips: ReelClip[] = [];
  for (const entry of entries.filter((e) => e.isDirectory())) {
    try {
      const session = JSON.parse(await readFile(sessionFile(entry.name, preferences), 'utf8')) as StudioSession;
      for (const clip of session.clips) {
        const source = session.sources.find((s) => s.id === clip.sourceId);
        if (!source) continue;
        const filePath = source.playbackPath ?? source.sourcePath;
        try { await access(filePath); } catch { continue; }
        const url = pathToFileURL(filePath).href.replace('file://', 'local-media://local');
        const poster = source.thumbnailPath ? pathToFileURL(source.thumbnailPath).href.replace('file://', 'local-media://local') : undefined;
        clips.push({ url, poster, start: clip.start, end: clip.end });
      }
      if (!session.clips.length) {
        for (const source of session.sources) {
          const filePath = source.playbackPath ?? source.sourcePath;
          try { await access(filePath); } catch { continue; }
          const dur = source.sourceAnalysis?.duration ?? 0;
          if (dur <= 0) continue;
          const url = pathToFileURL(filePath).href.replace('file://', 'local-media://local');
          const poster = source.thumbnailPath ? pathToFileURL(source.thumbnailPath).href.replace('file://', 'local-media://local') : undefined;
          const count = Math.min(4, Math.max(1, Math.floor(dur / 10)));
          for (let i = 0; i < count; i++) { const start = Math.random() * Math.max(0, dur - 5); clips.push({ url, poster, start, end: Math.min(start + 5, dur) }); }
        }
      }
    } catch { /* Skip unreadable projects. */ }
  }
  return clips;
}

function sourceFiles(folder: string) {
  return readdir(folder, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())).map((entry) => path.join(folder, entry.name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
}

function episodeLabel(file: string, index: number, episodic: boolean) {
  const name = path.basename(file, path.extname(file));
  const match = name.match(/s\d{1,2}e\d{1,3}/i);
  return match?.[0].toUpperCase() ?? (episodic ? `S01E${String(index + 1).padStart(2, '0')}` : name);
}

const sendTaskProgress = (progress: { percent: number; message: string }) => mainWindow?.webContents.send('task:progress', progress);

async function importVideos(session: StudioSession, mode: 'files' | 'season' | 'watch') {
  const directory = mode !== 'files';
  const result = await dialog.showOpenDialog(mainWindow!, { title: mode === 'files' ? 'Import source videos' : mode === 'season' ? 'Import season folder' : 'Choose folder to watch', properties: directory ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: directory ? undefined : [{ name: 'Video', extensions: [...videoExtensions].map((extension) => extension.slice(1)) }] });
  if (result.canceled) return { sources: [] };
  const watchFolder = mode === 'watch' ? result.filePaths[0] : undefined;
  const files = directory ? await sourceFiles(result.filePaths[0]) : result.filePaths;
  const known = new Set(session.sources.map((source) => path.resolve(source.sourcePath).toLowerCase()));
  const fresh = files.filter((file) => !known.has(path.resolve(file).toLowerCase()));
  const preferences = await loadPreferences();
  const sources: StudioSource[] = [];
  taskController?.abort();
  const controller = new AbortController();
  taskController = controller;
  try {
    for (const [index, file] of fresh.entries()) sources.push(await prepareSource(file, episodeLabel(file, index, directory), projectFolder(session, preferences), sendTaskProgress, controller.signal));
  } finally {
    if (taskController === controller) taskController = null;
  }
  if (watchFolder) configureWatchers({ ...session, sources: [...session.sources, ...sources], watchFolders: [...new Set([...session.watchFolders, watchFolder])] }, preferences);
  return { sources, watchFolder };
}

async function scanWatchedFolder(folder: string, preferences: StudioPreferences, projectId: string) {
  const startingSession = activeSession?.id === projectId ? activeSession : await loadProject(projectId, preferences);
  if (!startingSession.watchFolders.includes(folder)) return;
  const known = new Set(startingSession.sources.map((source) => path.resolve(source.sourcePath).toLowerCase()));
  const files = (await sourceFiles(folder)).filter((file) => !known.has(path.resolve(file).toLowerCase()));
  if (!files.length) return;
  const sources: StudioSource[] = [];
  for (const [index, file] of files.entries()) sources.push(await prepareSource(file, episodeLabel(file, startingSession.sources.length + index, true), projectFolder(startingSession, preferences), sendTaskProgress));
  const latest = activeSession?.id === projectId ? activeSession : await loadProject(projectId, preferences);
  const existing = new Set(latest.sources.map((source) => path.resolve(source.sourcePath).toLowerCase()));
  const fresh = sources.filter((source) => !existing.has(path.resolve(source.sourcePath).toLowerCase()));
  const saved = await writeProject({ ...latest, sources: [...latest.sources, ...fresh] }, preferences);
  if (activeSession?.id === projectId) {
    activeSession = saved;
    mainWindow?.webContents.send('watch:sources', fresh);
  }
}

function configureWatchers(session: StudioSession, preferences: StudioPreferences) {
  const wanted = new Set(session.watchFolders);
  for (const [folder, active] of watchers) if (!wanted.has(folder) || active.projectId !== session.id) { active.watcher.close(); watchers.delete(folder); }
  for (const folder of wanted) if (!watchers.has(folder)) {
    try {
      const watcher = watch(folder, () => {
        const previous = watchTimers.get(folder);
        if (previous) clearTimeout(previous);
        watchTimers.set(folder, setTimeout(() => void scanWatchedFolder(folder, preferences, session.id).catch((error) => sendTaskProgress({ percent: 0, message: `Watch folder: ${error.message}` })), 1200));
      });
      watcher.on('error', (error) => { watcher.close(); watchers.delete(folder); sendTaskProgress({ percent: 0, message: `Watch folder: ${error.message}` }); });
      watchers.set(folder, { watcher, projectId: session.id });
    } catch (error) { sendTaskProgress({ percent: 0, message: `Could not watch ${folder}: ${error instanceof Error ? error.message : String(error)}` }); }
  }
}

async function downloadVideo(session: StudioSession, url: string, downloadFolder?: string, browser?: DownloadBrowser) {
  const publicUrl = assertPublicVideoUrl(url);
  const preferences = await loadPreferences();
  taskController?.abort();
  const controller = new AbortController();
  taskController = controller;
  try {
    sendTaskProgress({ percent: 1, message: 'Connecting to the public video source' });
    const sourcePath = await downloadPublicVideo(publicUrl, downloadFolder ?? session.downloadPath ?? preferences.downloadPath, controller.signal, (progress) => sendTaskProgress({ percent: Math.max(1, progress.percent * 0.65), message: progress.message }), browser);
    return await prepareSource(sourcePath, path.basename(sourcePath, path.extname(sourcePath)), projectFolder(session, preferences), (progress) => sendTaskProgress({ percent: 65 + progress.percent * 0.35, message: progress.message }), controller.signal);
  } finally {
    if (taskController === controller) taskController = null;
  }
}

async function savePreferences(preferences: StudioPreferences) {
  const saved = await persistPreferences({ ...defaultPreferences(), ...preferences });
  applyWindowTheme(saved.theme);
  if (activeSession) configureWatchers(activeSession, saved);
  return saved;
}

async function changeLibrary(session: StudioSession, libraryPath: string) {
  const preferences = await loadPreferences();
  const source = path.resolve(preferences.libraryPath);
  const target = path.resolve(libraryPath);
  if (source.toLowerCase() === target.toLowerCase()) return workspace(session, preferences);
  await mkdir(target, { recursive: true });
  const confirmation = await dialog.showMessageBox(mainWindow!, {
    type: 'question',
    title: 'Change project library',
    message: 'How should Vapormint use the new project library?',
    detail: 'Copy keeps the existing library as a backup. Switch only opens projects already stored in the selected folder.',
    buttons: ['Copy projects and switch', 'Switch without copying', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (confirmation.response === 2) return null;
  if (confirmation.response === 0) {
    const relativeTarget = path.relative(source, target);
    if (relativeTarget && !relativeTarget.startsWith(`..${path.sep}`) && relativeTarget !== '..') throw new Error('Choose a folder outside the current project library when copying.');
    if ((await readdir(target)).length) throw new Error('Choose an empty folder when copying the project library. Nothing was moved or overwritten.');
    for (const entry of await readdir(source)) await cp(path.join(source, entry), path.join(target, entry), { recursive: true, force: false, errorOnExist: true });
  }
  const nextPreferences = await persistPreferences({ ...preferences, libraryPath: target });
  const cards = await projectCards(nextPreferences);
  const selected = cards.find((card) => card.id === session.id) ?? cards[0];
  const next = selected ? await loadProject(selected.id, nextPreferences) : emptySession();
  const savedPreferences = await persistPreferences({ ...nextPreferences, activeProjectId: selected?.id });
  activeSession = next;
  configureWatchers(next, savedPreferences);
  return { session: next, preferences: savedPreferences, projects: cards };
}

async function chooseLocation(_kind: 'libraryPath' | 'downloadPath' | 'exportPath', current: string) {
  const titles = { libraryPath: 'Choose project library', downloadPath: 'Choose downloaded master location', exportPath: 'Choose finished clip location' };
  const result = await dialog.showOpenDialog(mainWindow!, { title: titles[_kind], defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}

async function uniqueOutput(folder: string, name: string, extension: string) {
  for (let suffix = 0; ; suffix += 1) {
    const candidate = path.join(folder, `${name}${suffix ? ` ${suffix + 1}` : ''}.${extension}`);
    try { await access(candidate); } catch { return candidate; }
  }
}

async function exportClip(request: ExportRequest) {
  try { await access(request.source.sourcePath); } catch { throw new Error(`The source for ${request.clip.name} moved or was deleted. Relink it before exporting.`); }
  const extension = request.clip.recipe.outputFormat === 'MP4' ? 'mp4' : 'mov';
  const prefs = await loadPreferences();
  const exportRoot = request.exportRoot || prefs.exportPath;
  console.log('[exportClip] exportRoot=', JSON.stringify(exportRoot), 'sourcePath=', JSON.stringify(request.source?.sourcePath), 'projectName=', JSON.stringify(request.projectName));
  const folder = path.join(exportRoot, safeFileName(request.projectName));
  await mkdir(folder, { recursive: true });
  const outputPath = await uniqueOutput(folder, safeFileName(request.clip.name), extension);
  exportController?.abort();
  const controller = new AbortController();
  exportController = controller;
  let lastPercent = 0;
  try {
    const result = await processClip(request, outputPath, controller.signal, (percent, message) => {
      lastPercent = Math.max(lastPercent, percent);
      mainWindow?.webContents.send('export:progress', { clipId: request.clip.id, percent: lastPercent, message });
    });
    const clipResult = { ...request.clip, completed: true, outputPath, processingEngine: result.engine, fallbackReason: result.fallbackReason, pngFramesPath: result.pngFramesPath, outputWarnings: result.warnings };
    // Persist a render receipt next to the master: the verifiable record of this job
    // (source, recipe, engine, outputs, warnings). Best-effort — a missing receipt
    // must not fail the export.
    try {
      // Name siblings after the actual output file ("Clip 01 2.mov" → "Clip 01 2.vpy"), as processClip does.
      const stem = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)));
      const vapourSynthScriptPath = request.clip.recipe.saveVapourSynthScript ? `${stem}.vpy` : undefined;
      const receipt = buildReceipt({ clip: clipResult, source: request.source, outputPath, engine: result.engine, fallbackReason: result.fallbackReason, pngFramesPath: result.pngFramesPath, warnings: result.warnings ?? [], vapourSynthScriptPath });
      const receiptPath = `${stem}.receipt.json`;
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
      clipResult.receiptPath = receiptPath;
    } catch { /* Receipt is a best-effort audit artifact; never block the master on it. */ }
    return clipResult;
  } finally {
    if (exportController === controller) exportController = null;
  }
}

function windowTheme(theme: StudioPreferences['theme']) {
  return theme === 'light'
    ? { background: '#ffffff', overlay: { color: '#ffffff', symbolColor: '#000000', height: 42 } }
    : { background: '#000000', overlay: { color: '#000000', symbolColor: '#ffffff', height: 42 } };
}

function applyWindowTheme(theme: StudioPreferences['theme']) {
  if (!mainWindow) return;
  const colors = windowTheme(theme);
  mainWindow.setBackgroundColor(colors.background);
  if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay(colors.overlay);
}

function createWindow(theme: StudioPreferences['theme'] = 'dark') {
  const colors = windowTheme(theme);
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 960, minHeight: 620, backgroundColor: colors.background, icon: path.join(__dirname, '../assets/icon.ico'), titleBarStyle: 'hidden', ...(process.platform === 'darwin' ? {} : { titleBarOverlay: colors.overlay }), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', (_event, details) => { if (details.reason !== 'clean-exit') showFatalError('Vapormint renderer stopped', details.reason); });
  const loading = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  void loading.catch((error) => showFatalError('Vapormint could not open', error));
}

process.on('uncaughtException', (error) => { showFatalError('Vapormint encountered an unexpected error', error); app.quit(); });
process.on('unhandledRejection', (error) => showFatalError('Vapormint could not complete an operation', error));

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
else void app.whenReady().then(async () => {
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  ipcMain.handle('workspace:load', loadWorkspace);
  ipcMain.handle('reel:clips', loadReelClips);
  ipcMain.handle('project:create', (_event, name: string) => createProject(name));
  ipcMain.handle('project:open', (_event, id: string) => openProject(id));
  ipcMain.handle('project:rename', (_event, id: string, name: string) => renameProject(id, name));
  ipcMain.handle('project:delete', (_event, id: string) => deleteProject(id));
  ipcMain.handle('session:save', (_event, session: StudioSession) => saveSession(session));
  ipcMain.handle('source:import', (_event, session: StudioSession, mode: 'files' | 'season' | 'watch') => importVideos(session, mode));
  ipcMain.handle('source:reanalyze', async (_event, sourcePath: string) => {
    taskController?.abort();
    const controller = new AbortController();
    taskController = controller;
    try {
      sendTaskProgress({ percent: 5, message: 'Sampling cadence, timing, color, and decode health' });
      const analysis = await probeMedia(sourcePath, controller.signal);
      sendTaskProgress({ percent: 100, message: 'Source guidance updated' });
      return analysis;
    } finally {
      if (taskController === controller) taskController = null;
    }
  });
  ipcMain.handle('source:download', (_event, session: StudioSession, url: string, downloadFolder?: string, browser?: DownloadBrowser) => downloadVideo(session, url, downloadFolder, browser));
  ipcMain.handle('preferences:save', (_event, preferences: StudioPreferences) => savePreferences(preferences));
  ipcMain.handle('library:change', (_event, session: StudioSession, libraryPath: string) => changeLibrary(session, libraryPath));
  ipcMain.handle('location:choose', (_event, kind: 'libraryPath' | 'downloadPath' | 'exportPath', current: string) => chooseLocation(kind, current));
  ipcMain.handle('runtime:status', getRuntimeStatus);
  ipcMain.handle('export:start', async (_event, request: ExportRequest) => {
    try { return await exportClip(request); } catch (e) { console.error('[export:start] FAILED', e); throw e; }
  });
  ipcMain.handle('receipt:read', async (_event, receiptPath: string) => {
    const resolved = path.resolve(receiptPath);
    const prefs = await loadPreferences();
    const allowed = [path.resolve(prefs.libraryPath), path.resolve(prefs.exportPath)];
    if (!allowed.some((root) => resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep) || resolved.toLowerCase() === root.toLowerCase()))
      throw new Error('Receipt path is outside the project library and export folders.');
    try {
      return JSON.parse(await readFile(resolved, 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('previewTune', async (_event, request: ExportRequest, settings) => {
    const prefs = await loadPreferences();
    const safeRequest = request.exportRoot ? request : { ...request, exportRoot: prefs.exportPath };
    console.log('[previewTune] exportRoot=', JSON.stringify(safeRequest.exportRoot), 'sourcePath=', JSON.stringify(safeRequest.source?.sourcePath));
    try {
      return await tunePreview(safeRequest, settings, new AbortController().signal, (percent, message) => { mainWindow?.webContents.send('previewTuneProgress', { percent, message }); });
    } catch (e) { console.error('[previewTune] FAILED', e); throw e; }
  });
  ipcMain.handle('task:cancel', () => { exportController?.abort(); taskController?.abort(); });

  // ---- Updates ----
  // This build ships via Squirrel (Update.exe + .nupkg + RELEASES), which has no
  // electron-builder `latest.yml` feed for electron-updater to read. So the in-app
  // check talks to the GitHub Releases API directly: it finds the newest non-draft
  // release, compares its tag to the running version, and deep-links to the release
  // page where VapormintSetup.exe lives. That is the standard pattern for Squirrel
  // apps that don't run a signed Squirrel feed server.
  const GITHUB_REPO = 'codingwnicole/vapormint';
  const RELEASE_PAGE = `https://github.com/${GITHUB_REPO}/releases`;
  const semver = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const isNewer = (a: string, b: string) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) > (y[i] ?? 0)) return true; if ((x[i] ?? 0) < (y[i] ?? 0)) return false; } return false; };
  let latestRelease: { tag: string; url: string; release?: Release } | null = null;
  const sendUpdate = (info: UpdateInfo) => mainWindow?.webContents.send('update:progress', info);

  ipcMain.handle('update:check', async () => {
    const current = app.getVersion();
    const reply = (info: UpdateInfo) => { sendUpdate(info); return info; };
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const releases = (await res.json()) as Release[];
      const stable = findCompatibleRelease(releases, process.platform, process.arch);
      if (!stable) return reply({ status: 'current', version: current, message: 'No compatible release is published for this platform yet.', percent: 0 });
      latestRelease = { tag: stable.tag_name, url: stable.html_url, release: stable };
      if (isNewer(stable.tag_name, current)) return reply({ status: 'available', version: stable.tag_name, message: `Version ${stable.tag_name} is available — click "Install update" to download it`, percent: 0 });
      return reply({ status: 'current', version: current, message: `You are on the latest version (${current})`, percent: 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply({ status: 'error', version: current, message: `Update check failed (${msg})`, percent: 0 });
    }
  });
  ipcMain.handle('update:apply', async () => {
    // Windows: hand the release's own Squirrel feed (RELEASES + .nupkg assets) to Electron's
    // autoUpdater, which drives the installed Update.exe: download, verify, stage, restart.
    // Only possible in a Squirrel install whose target release actually ships the feed.
    const squirrelInstalled = process.platform === 'win32' && app.isPackaged && existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe'));
    if (squirrelInstalled && latestRelease?.release?.assets?.some((asset) => asset.name === 'RELEASES')) {
      const { tag } = latestRelease;
      const reply = (info: UpdateInfo) => { sendUpdate(info); return info; };
      reply({ status: 'downloading', version: tag, message: `Downloading Vapormint ${tag} (about 350 MB) — keep working, you'll be asked to restart`, percent: 50 });
      await new Promise<void>((resolve) => {
        const done = () => { autoUpdater.removeAllListeners('update-downloaded'); autoUpdater.removeAllListeners('update-not-available'); autoUpdater.removeAllListeners('error'); resolve(); };
        autoUpdater.once('update-downloaded', async () => {
          done();
          reply({ status: 'downloaded', version: tag, message: `Vapormint ${tag} is ready — restart to finish updating`, percent: 100 });
          const { response } = await dialog.showMessageBox(mainWindow!, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, message: `Vapormint ${tag} is ready`, detail: 'Restart to finish updating. If you choose Later, it installs the next time Vapormint starts.' });
          if (response === 0) autoUpdater.quitAndInstall();
        });
        autoUpdater.once('update-not-available', () => { done(); reply({ status: 'current', version: app.getVersion(), message: `You are on the latest version (${app.getVersion()})`, percent: 0 }); });
        autoUpdater.once('error', (error) => { done(); reply({ status: 'error', version: tag, message: `Update failed: ${errorMessage(error)}`, percent: 0 }); });
        autoUpdater.setFeedURL({ url: `https://github.com/${GITHUB_REPO}/releases/download/${tag}` });
        autoUpdater.checkForUpdates();
      });
      return;
    }
    if (process.platform !== 'darwin' || !latestRelease?.release) {
      await shell.openExternal(latestRelease?.url ?? RELEASE_PAGE);
      return;
    }
    const dmg = findDmgAsset(latestRelease.release, process.arch);
    if (!dmg?.browser_download_url) { await shell.openExternal(latestRelease.url); return; }
    const reply = (info: UpdateInfo) => { sendUpdate(info); return info; };
    try {
      reply({ status: 'downloading', version: latestRelease.tag, message: 'Downloading update…', percent: 5 });
      const dmgPath = path.join(tmpdir(), dmg.name);
      const res = await fetch(dmg.browser_download_url);
      if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
      const total = Number(res.headers.get('content-length') || 0);
      let downloaded = 0;
      const fileStream = createWriteStream(dmgPath);
      let writeError: Error | undefined;
      fileStream.on('error', (error) => { writeError = error; }); // unhandled, a full disk would crash the app
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        if (writeError) throw writeError;
        fileStream.write(chunk);
        downloaded += chunk.length;
        if (total) reply({ status: 'downloading', version: latestRelease.tag, message: 'Downloading update…', percent: Math.round((downloaded / total) * 80) + 5 });
      }
      await new Promise<void>((resolve, reject) => fileStream.end(() => writeError ? reject(writeError) : resolve()));
      reply({ status: 'downloading', version: latestRelease.tag, message: 'Installing…', percent: 90 });
      const { stdout } = await capture('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountrandom', tmpdir()]);
      const mountLine = stdout.trim().split('\n').pop() ?? '';
      const mountPoint = mountLine.split('\t').pop()?.trim() ?? '';
      if (!mountPoint || !mountPoint.startsWith('/')) throw new Error('Could not mount DMG');
      try {
        const apps = (await readdir(mountPoint)).filter(f => f.endsWith('.app'));
        if (!apps.length) throw new Error('No .app found in DMG');
        const src = path.join(mountPoint, apps[0]);
        const dest = path.resolve(process.execPath, '../../..');
        // Copy beside the app first; only swap once the copy is complete, so a failed copy
        // never leaves the user with no Vapormint at all.
        const staged = `${dest}.update`;
        const old = `${dest}.old`;
        await rm(staged, { recursive: true, force: true });
        await rm(old, { recursive: true, force: true });
        await cp(src, staged, { recursive: true });
        await capture('xattr', ['-cr', staged]).catch(() => {});
        // Rename the running app aside instead of deleting it — macOS cannot
        // rm files that are memory-mapped by the running process (ENOTEMPTY).
        await rename(dest, old);
        await rename(staged, dest);
        await rm(old, { recursive: true, force: true }).catch(() => {});
      } finally { await capture('hdiutil', ['detach', mountPoint, '-force']).catch(() => {}); }
      await rm(dmgPath, { force: true }).catch(() => {});
      reply({ status: 'current', version: latestRelease.tag, message: 'Update installed — restart to use the new version', percent: 100 });
      const { response } = await dialog.showMessageBox(mainWindow!, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, message: `Vapormint ${latestRelease.tag} installed`, detail: 'Restart to use the new version.' });
      if (response === 0) { app.relaunch(); app.quit(); }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reply({ status: 'error', version: latestRelease?.tag ?? '', message: `Update failed: ${msg}`, percent: 0 });
    }
  });

  // ---- Tool updates ----
  // Check bundled yt-dlp and ffmpeg/ffprobe against upstream GitHub releases.
  // VapourSynth + plugins are not auto-updatable (complex native build).
  const toolLatestVersion = async (repo: string): Promise<string> => {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const { tag_name } = (await res.json()) as { tag_name: string };
    return tag_name;
  };

  ipcMain.handle('tools:check', async (): Promise<ToolVersionInfo[]> => {
    if (process.platform === 'darwin') return checkMacToolUpdates();
    const runtime = await getRuntimeStatus();
    const checks: Array<{ name: string; key: keyof NonNullable<typeof runtime.versions>; repo: string }> = [
      { name: 'yt-dlp', key: 'ytDlp', repo: 'yt-dlp/yt-dlp' },
      { name: 'ffmpeg', key: 'ffmpeg', repo: 'BtbN/FFmpeg-Builds' },
    ];
    return Promise.all(checks.map(async ({ name, key, repo }): Promise<ToolVersionInfo> => {
      const current = runtime.versions?.[key] ?? '';
      try {
        const latest = await toolLatestVersion(repo);
        // ponytail: naive string compare — good enough for YYYY.MM.DD (yt-dlp) and semver-ish tags
        const updateAvailable = !!current && !!latest && latest.replace(/^v/, '') !== current.replace(/^v/, '').split('-')[0];
        return { name, current, latest, updateAvailable, checkFailed: false, note: updateAvailable ? `${latest} available` : 'Up to date' };
      } catch {
        return { name, current, latest: '', updateAvailable: false, checkFailed: true, note: 'Version check failed (offline?)' };
      }
    }));
  });

  ipcMain.handle('tools:update', async (_event, name: string): Promise<{ ok: boolean; message: string; version?: string }> => {
    if (process.platform === 'darwin') { try { return await updateMacTool(name); } catch (error) { return {ok:false, message:errorMessage(error)}; } }
    // Only yt-dlp supports in-place self-update via its own --update flag.
    // ffmpeg requires downloading a build archive — not safe to swap while running.
    if (name !== 'yt-dlp') return { ok: false, message: `${name} cannot be updated in-place. Download a new build from the release page.` };
    try {
      const ytDlp = await executable('yt-dlp');
      const { stdout } = await capture(ytDlp, ['--update']);
      const version = stdout.match(/(\d{4}\.\d{2}\.\d{2})/)?.[1] ?? '';
      return { ok: true, message: stdout.trim(), version };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  // ---- Feedback ----
  ipcMain.handle('feedback:submit', async (_event, report: FeedbackReport) => {
    try {
      const dir = app.getPath('userData');
      const file = path.join(dir, `feedback-${report.createdAt.replace(/[:.]/g, '-')}.json`);
      await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
      return { ok: true, message: 'Feedback saved. Thank you!' };
    } catch (e) {
      return { ok: false, message: `Could not save feedback: ${String(e)}` };
    }
  });
  ipcMain.handle('feedback:open', async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('github.com'))
      throw new Error('Only HTTPS GitHub links can be opened.');
    await shell.openExternal(parsed.href);
  });

  protocol.handle('local-media', async (req) => {
    const filePath = decodeURIComponent(new URL(req.url).pathname).replace(/^\/([A-Z]:)/, '$1');
    if (!filePath.match(/\.(mp4|m4v|mkv|mov|avi|webm|ts|m2ts|mts|mpg|mpeg|wmv|flv|gif|png|jpg|jpeg|webp|bmp|tiff?)$/i)) return new Response('Forbidden', { status: 403 });
    const total = (await stat(filePath)).size;
    const range = req.headers.get('range')?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : total - 1;
    const mimeTypes: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, { status: range ? 206 : 200, headers });
  });
  createWindow((await loadPreferences()).theme);
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.show(); mainWindow?.focus(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void loadPreferences().then((preferences) => createWindow(preferences.theme)); });
}).catch((error) => showFatalError('Vapormint could not start', error));

app.on('before-quit', stopBackgroundWork);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
