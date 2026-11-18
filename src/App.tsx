import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import appIcon from '../assets/icon.png';
import {
  aspectPresets,
  aspectRatio,
  applyLook,
  assertPublicVideoUrl,
  createClip,
  deinterlaceChoices,
  formatTime,
  fitCropToAspect,
  joinTouchingClips,
  looks,
  masterSizes,
  moveCrop,
  outputDimensions,
  outputFormats,
  orientedSourceDimensions,
  pixelAdvice,
  previewSettingsForEvidence,
  previewSettingsToRecipePatch,
  runPreviewLoop,
  readyWithRecipe,
  setCropEdge,
  suggestedRecipePatch,
  suggestedRecipes,
  sourceGuidanceItems,
  sourceVerdict,
  type ClipRecipe,
  type DownloadBrowser,
  type ExportProgress,
  type ProjectCard,
  type PreviewSettings,
  type RuntimeStatus,
  type RenderReceipt,
  type SessionClip,
  type StudioSession,
  type StudioSource,
  type StudioLook,
  type StudioPreferences,
  type TaskProgress,
  type ToolVersionInfo,
  type UpdateInfo,
  type ViewName,
} from './shared';

const nav: Array<[ViewName, string]> = [
  ['home', 'Home'],
  ['find', 'Find moments'],
  ['process', 'Process clips'],
  ['settings', 'Settings'],
];

const welcomeSteps = [
  { eyebrow: 'WELCOME', title: 'The moments worth keeping.', symbol: '◇', body: 'Vapormint is a local video processor. Import a file, a folder, or a link. Your originals are never touched — every edit lives in the project.', note: 'All processing runs locally with the bundled VapourSynth toolchain.' },
  { eyebrow: 'STEP 1 · FIND', title: 'Review, then cut.', symbol: '⌕', body: 'Play the source. Scrub the timeline, step frame by frame, set In and Out points, and add the range to the queue.', note: 'Space play · ← → frame · Shift+← → second · I / O mark · Enter queue' },
  { eyebrow: 'STEP 2 · PROCESS', title: 'Frame it. Self-tune runs automatically.', symbol: '▱', body: 'Select a clip and Vapormint measures the source, renders a short preview, and writes evidence-based fixes into the recipe. Review the results, adjust anything that looks off, then export.', note: 'Deinterlacing, denoise, and sharpen are set from what the pixels actually need. Hover any setting for an explanation.' },
  { eyebrow: 'STEP 3 · EXPORT', title: 'One click. Watch it render.', symbol: '↗', body: 'Pick the output folder and export. Progress, elapsed time, and the active phase stay visible. Stop removes incomplete work without touching finished files.', note: 'Strict mode never silently swaps a codec. Optional PNG extraction comes from the processed master.' },
] as const;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
type SaveState = 'saving' | 'saved' | 'error';

function useElapsed(startedAt?: number) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return elapsed;
}

export default function App() {
  const [session, setSession] = useState<StudioSession>();
  const [view, setView] = useState<ViewName>('home');
  const [markIn, setMarkIn] = useState<number>();
  const [markOut, setMarkOut] = useState<number>();
  const [playhead, setPlayhead] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(true);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueFilter, setQueueFilter] = useState<'all' | 'ready' | 'completed'>('all');
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [status, setStatus] = useState('Ready');
  const [progress, setProgress] = useState<ExportProgress>();
  const [taskProgress, setTaskProgress] = useState<TaskProgress>();
  const [runtime, setRuntime] = useState<RuntimeStatus>({ ffmpeg: false, ffprobe: false, vspipe: false, ytDlp: false, vapourSynthPlugins: false });
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [preferences, setPreferences] = useState<StudioPreferences>();
  const [exportRootOverride, setExportRootOverride] = useState<string>();
  const [exportStartedAt, setExportStartedAt] = useState<number>();
  const [tuning, setTuning] = useState(false);
  const [tuneStatus, setTuneStatus] = useState('');
  const [tuneResult, setTuneResult] = useState<{ converged: boolean; rounds: number; fixes: string[] } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; message: string } | null>(null);
  const [taskStartedAt, setTaskStartedAt] = useState<number>();
  const [taskKind, setTaskKind] = useState<'download' | 'import'>();
  const [downloadSetup, setDownloadSetup] = useState<{ url: string; name: string; downloadPath: string; exportPath: string; browser: DownloadBrowser; projectId?: string }>();
  const [projectDialog, setProjectDialog] = useState<{ mode: 'create' | 'rename'; id?: string; name: string }>();
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeStep, setWelcomeStep] = useState(0);
  const [loadingError, setLoadingError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; message: string }>();
  const [undo, setUndo] = useState<{ session: StudioSession; selectedClipId?: string }>();
  const [saveState, setSaveState] = useState<SaveState>('saved');
  // Update notify: set by the background check on launch and by any manual check.
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<StudioSession | undefined>(undefined);
  const modal = useRef<HTMLElement | null>(null);
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const loaded = useRef(false);
  const exportElapsed = useElapsed(exportStartedAt);
  const taskElapsed = useElapsed(taskStartedAt);
  const busy = Boolean(exportStartedAt || taskStartedAt);
  sessionRef.current = session;

  const reportError = useCallback((error: unknown) => {
    const message = errorMessage(error);
    setStatus(message);
    setUndo(undefined);
    setNotice({ kind: 'error', message });
  }, []);

  useEffect(() => {
    Promise.all([window.cuttingFloor.loadWorkspace(), window.cuttingFloor.runtimeStatus()]).then(([workspace, tools]) => {
      setSession(workspace.session);
      setProjects(workspace.projects);
      setPreferences(workspace.preferences);
      setShowWelcome(!workspace.preferences.onboardingComplete);
      setRuntime(tools);
      setSelectedClipId(workspace.session.clips[0]?.id);
      loaded.current = true;
    }).catch((error: Error) => { setLoadingError(error.message); reportError(error); });
    const stopExport = window.cuttingFloor.onExportProgress(setProgress);
    const stopTask = window.cuttingFloor.onTaskProgress((next) => { setTaskProgress(next); setStatus(next.message); });
    const stopWatch = window.cuttingFloor.onWatchSources((sources) => setSession((current) => current ? { ...current, sources: [...current.sources, ...sources.filter((source) => !current.sources.some((item) => item.sourcePath === source.sourcePath))] } : current));
    return () => { stopExport(); stopTask(); stopWatch(); };
  }, [reportError]);

  // Update notify: once the app is open, quietly ask the GitHub Releases API whether
  // a newer release exists. If one does, a banner appears (below the titlebar). The
  // check is fire-and-forget; a failure (offline, etc.) is surfaced only if the user
  // later clicks "Check for updates". We delay ~2.5s so the check doesn't compete
  // with the initial workspace/runtime load for bandwidth and CPU.
  useEffect(() => {
    if (!loaded.current) return;
    const stopUpdate = window.cuttingFloor.onUpdateProgress((info) => setUpdateInfo(info));
    const timer = window.setTimeout(() => { void window.cuttingFloor.checkForUpdates(); }, 2500);
    return () => { stopUpdate(); window.clearTimeout(timer); };
  }, [loaded.current]);

  useEffect(() => {
    if (!session || !loaded.current || (!projects.length && !session.sources.length && !session.clips.length && session.name === 'Untitled Vapormint')) return;
    setSaveState('saving');
    const timer = window.setTimeout(() => window.cuttingFloor.saveSession(session).then(() => setProjects((current) => {
      const card: ProjectCard = { id: session.id, name: session.name, updated: new Date().toISOString(), thumbnailUrl: session.sources.find((source) => source.thumbnailUrl)?.thumbnailUrl, sourceCount: session.sources.length, clipCount: session.clips.length, completedCount: session.clips.filter((clip) => clip.completed).length };
      setSaveState('saved');
      return [card, ...current.filter((item) => item.id !== card.id)];
    })).catch((error) => { setSaveState('error'); reportError(error); }), 250);
    return () => window.clearTimeout(timer);
  }, [projects.length, reportError, session]);

  const activeSource = useMemo(
    () => session?.sources.find((source) => source.id === session.activeSourceId) ?? session?.sources[0],
    [session],
  );
  const selectedClip = session?.clips.find((clip) => clip.id === selectedClipId) ?? session?.clips[0];
  const selectedSource = session?.sources.find((source) => source.id === selectedClip?.sourceId);
  const duration = activeSource?.sourceAnalysis.duration ?? 0;
  const fps = activeSource?.sourceAnalysis.fps || 30;

  useEffect(() => {
    setMarkIn(undefined);
    setMarkOut(undefined);
    setPlayhead(0);
  }, [activeSource?.id, duration]);

  useEffect(() => { setExportRootOverride(undefined); }, [session?.id]);

  const seekRaf = useRef(0);
  const scrubbing = useRef(false);
  const seek = useCallback((seconds: number) => {
    const next = Math.max(0, Math.min(duration, seconds));
    setPlayhead(next);
    cancelAnimationFrame(seekRaf.current);
    seekRaf.current = requestAnimationFrame(() => { if (video.current) video.current.currentTime = next; });
  }, [duration]);

  const queueClip = useCallback(() => {
    if (!session || !activeSource) return;
    if (markIn === undefined || markOut === undefined) {
      setStatus('Set both Mark In and Mark Out before entering a clip.');
      return;
    }
    const clip = createClip(activeSource, markIn, markOut, session.clips.length + 1);
    setSession({ ...session, clips: [...session.clips, clip] });
    setSelectedClipId(clip.id);
    setStatus(`${clip.name} entered into the queue`);
    setQueueCollapsed(false);
    setMarkIn(undefined);
    setMarkOut(undefined);
  }, [activeSource, markIn, markOut, session]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (view !== 'find' || !activeSource) return;
      const target = event.target as HTMLElement;
      const isEditing = target.matches('input:not([type="range"]), select, textarea, [contenteditable="true"]');
      if (isEditing) return;
      if (event.code === 'KeyI') { event.preventDefault(); if (target.matches('button')) target.blur(); setMarkIn(playhead); setStatus(`Mark In set at ${formatTime(playhead)}`); }
      else if (event.code === 'KeyO') { event.preventDefault(); if (target.matches('button')) target.blur(); setMarkOut(playhead); setStatus(`Mark Out set at ${formatTime(playhead)}`); }
      else if (event.code === 'Enter') {
        if (target.matches('button, summary, a') && !target.closest('.mark-controls')) return;
        event.preventDefault();
        queueClip();
      }
      else if (event.ctrlKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight') && session) {
        event.preventDefault();
        const index = session.sources.findIndex((source) => source.id === activeSource.id);
        const next = Math.max(0, Math.min(session.sources.length - 1, index + (event.code === 'ArrowLeft' ? -1 : 1)));
        setSession({ ...session, activeSourceId: session.sources[next]?.id });
      } else if (event.ctrlKey && (event.code === 'ArrowUp' || event.code === 'ArrowDown') && session && session.clips.length) {
        event.preventDefault();
        const index = Math.max(0, session.clips.findIndex((clip) => clip.id === selectedClipId));
        const next = Math.max(0, Math.min(session.clips.length - 1, index + (event.code === 'ArrowUp' ? -1 : 1)));
        setSelectedClipId(session.clips[next].id);
      }
      else if (event.code === 'Space') {
        if (target.matches('button, summary, a')) return;
        event.preventDefault();
        if (video.current?.paused) void video.current.play(); else video.current?.pause();
      } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        if (target.matches('button')) target.blur();
        seek(playhead + (event.code === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 1 / fps));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSource, fps, playhead, queueClip, seek, selectedClipId, session, view]);

  const importVideos = async (mode: 'files' | 'season' | 'watch' = 'files') => {
    if (!session || busy) return;
    setTaskKind('import');
    setTaskStartedAt(Date.now());
    setTaskProgress({ percent: 0, message: mode === 'watch' ? 'Choosing a watched folder' : 'Choosing source video' });
    try {
      setStatus('Inspecting source metadata…');
      const { sources, watchFolder } = await window.cuttingFloor.importVideos(session, mode);
      if (!sources.length && !watchFolder) return setStatus('Import cancelled');
      setSession((current) => current?.id === session.id ? { ...current, sources: [...current.sources, ...sources], activeSourceId: current.activeSourceId ?? sources[0]?.id, watchFolders: watchFolder ? [...new Set([...current.watchFolders, watchFolder])] : current.watchFolders } : current);
      if (sources.length) setView('find');
      setStatus(sources.length ? `${sources.length} source${sources.length === 1 ? '' : 's'} imported` : 'Watch folder enabled');
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) reportError(error);
      else setStatus('Import cancelled; original files were not changed.');
    } finally { setTaskStartedAt(undefined); setTaskKind(undefined); }
  };

  const reanalyzeActiveSource = async () => {
    if (!session || !activeSource || busy) return;
    setTaskKind('import');
    setTaskStartedAt(Date.now());
    setTaskProgress({ percent: 0, message: 'Preparing distributed source analysis' });
    try {
      const sourceAnalysis = await window.cuttingFloor.reanalyzeSource(activeSource.sourcePath);
      setSession((current) => current?.id === session.id ? { ...current, sources: current.sources.map((source) => source.id === activeSource.id ? { ...source, sourceAnalysis } : source) } : current);
      setStatus('Source guidance updated');
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) reportError(error);
      else setStatus('Source analysis cancelled. Existing guidance was preserved.');
    } finally { setTaskStartedAt(undefined); setTaskKind(undefined); }
  };

  const prepareDownload = (url: string) => {
    if (!preferences || busy) return false;
    try {
      const publicUrl = assertPublicVideoUrl(url);
      setDownloadSetup({ url: publicUrl, name: 'Downloaded Video', downloadPath: preferences.downloadPath, exportPath: preferences.exportPath, browser: 'none' });
      return true;
    } catch (error) { reportError(error); return false; }
  };

  const chooseDownloadFolder = async (kind: 'downloadPath' | 'exportPath') => {
    if (!downloadSetup) return;
    try {
      const path = await window.cuttingFloor.chooseLocation(kind, downloadSetup[kind]);
      if (path) setDownloadSetup((current) => current && { ...current, [kind]: path });
    } catch (error) { reportError(error); }
  };

  const downloadVideo = async () => {
    if (!downloadSetup || !downloadSetup.name.trim()) return;
    const setup = downloadSetup;
    const { url, name, downloadPath, exportPath, browser, projectId } = setup;
    setDownloadSetup(undefined);
    setTaskProgress({ percent: 0, message: 'Preparing download' });
    setTaskKind('download');
    setTaskStartedAt(Date.now());
    let project = projectId && session?.id === projectId ? { ...session, downloadPath, exportPath } : undefined;
    try {
      if (!project) {
        const workspace = await window.cuttingFloor.createProject(name.trim());
        project = { ...workspace.session, downloadPath, exportPath };
        setProjects(workspace.projects);
        setPreferences(workspace.preferences);
      }
      setSession(project);
      await window.cuttingFloor.saveSession(project);
      setTaskProgress({ percent: 0, message: 'Preparing download' });
      setStatus('Starting source download…');
      const source = await window.cuttingFloor.downloadVideo(project, url, downloadPath, browser);
      setSession({ ...project, sources: [source], activeSourceId: source.id });
      setView('find');
      setStatus(`${source.displayName} downloaded and imported`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') setStatus('Download cancelled; the new project remains available.');
      else {
        const message = errorMessage(error);
        if (/browser sign-in|sign-in could not be read/i.test(message)) {
          setDownloadSetup({ ...setup, projectId: project?.id });
          setStatus('Download needs browser sign-in');
          setUndo(undefined);
          setNotice({ kind: 'info', message: message.replace(/^.*?Error:\s*/i, '') });
        } else reportError(error);
      }
    } finally { setTaskStartedAt(undefined); setTaskKind(undefined); }
  };

  const applyWorkspace = (workspace: Awaited<ReturnType<typeof window.cuttingFloor.loadWorkspace>>) => {
    setUndo(undefined); setNotice(undefined); setSession(workspace.session); setProjects(workspace.projects); setPreferences(workspace.preferences); setSelectedClipId(workspace.session.clips.find((clip) => !clip.completed)?.id ?? workspace.session.clips[0]?.id); setView('home');
  };

  const createProject = async (name: string) => {
    try { applyWorkspace(await window.cuttingFloor.createProject(name)); }
    catch (error) { reportError(error); }
  };

  const openProject = async (id: string) => {
    try {
      const workspace = await window.cuttingFloor.openProject(id);
      applyWorkspace(workspace);
      setView(workspace.session.sources.length ? 'find' : 'home');
    }
    catch (error) { reportError(error); }
  };

  const renameProject = async (id: string, name: string) => {
    try { applyWorkspace(await window.cuttingFloor.renameProject(id, name.trim())); }
    catch (error) { reportError(error); }
  };

  const deleteProject = async (id: string) => {
    try {
      const workspace = await window.cuttingFloor.deleteProject(id);
      if (workspace) applyWorkspace(workspace);
    } catch (error) { reportError(error); }
  };

  const updateClip = (clipId: string, patch: Partial<SessionClip>) => {
    if (!session) return;
    setSession((current) => current ? { ...current, clips: current.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) } : current);
  };

  const updateRecipe = (patch: Partial<ClipRecipe>) => {
    if (!selectedClip) return;
    const clipId = selectedClip.id;
    setSession((current) => current ? { ...current, clips: current.clips.map((clip) => clip.id === clipId ? readyWithRecipe(clip, { ...clip.recipe, ...patch }) : clip) } : current);
  };

  const applyRecipeToOtherClips = () => {
    if (!session || !selectedClip) return;
    const count = session.clips.filter((clip) => clip.id !== selectedClip.id && !clip.completed).length;
    if (!count) return;
    setUndo({ session, selectedClipId });
    setSession({ ...session, clips: session.clips.map((clip) => clip.id === selectedClip.id || clip.completed ? clip : readyWithRecipe(clip, { ...selectedClip.recipe })) });
    setNotice({ kind: 'info', message: `Recipe copied to ${count} unfinished clip${count === 1 ? '' : 's'}.` });
    setStatus(`Recipe copied to ${count} unfinished clip${count === 1 ? '' : 's'}`);
  };

  const removeClip = (clipId: string) => {
    if (!session || busy) return;
    const clips = session.clips.filter((clip) => clip.id !== clipId);
    setUndo({ session, selectedClipId });
    setSession({ ...session, clips });
    setSelectedClipId(clips[0]?.id);
    setNotice({ kind: 'info', message: 'Clip removed from the project queue.' });
  };

  const moveClip = (clipId: string, delta: number) => {
    if (!session || busy) return;
    const clips = [...session.clips];
    const from = clips.findIndex((clip) => clip.id === clipId);
    const to = Math.max(0, Math.min(clips.length - 1, from + delta));
    if (from === to) return;
    [clips[from], clips[to]] = [clips[to], clips[from]];
    setSession((current) => current?.id === session.id ? { ...current, clips } : current);
  };

  const markUnfinished = (clipId: string) => { if (!session || busy) return; setUndo({ session, selectedClipId }); updateClip(clipId, { completed: false, outputPath: undefined, pngFramesPath: undefined, processingEngine: undefined, fallbackReason: undefined, outputWarnings: undefined }); setNotice({ kind: 'info', message: 'Clip returned to Ready; previous exports remain on disk.' }); setStatus('Clip returned to Ready; previous exports remain on disk.'); };
  const resetCompleted = () => { if (!session || busy) return; setUndo({ session, selectedClipId }); setSession({ ...session, clips: session.clips.map((clip) => clip.completed ? { ...clip, completed: false, outputPath: undefined, pngFramesPath: undefined, processingEngine: undefined, fallbackReason: undefined, outputWarnings: undefined } : clip) }); setNotice({ kind: 'info', message: 'Completed clips returned to Ready; previous exports remain on disk.' }); };
  const clearUnfinished = () => {
    if (!session || busy) return;
    const clips = session.clips.filter((clip) => clip.completed);
    if (clips.length === session.clips.length) return;
    setUndo({ session, selectedClipId });
    setSession({ ...session, clips });
    if (!clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId(clips[0]?.id);
    setNotice({ kind: 'info', message: 'Ready clips cleared from the project queue.' });
  };
  const joinRanges = () => {
    if (!session || busy) return;
    const clips = joinTouchingClips(session.clips, (sourceId) => 1 / (session.sources.find((source) => source.id === sourceId)?.sourceAnalysis.fps || 30));
    if (clips.length === session.clips.length) return setStatus('No touching clips to join.');
    setUndo({ session, selectedClipId });
    setSession({ ...session, clips });
    if (!clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId(clips[0]?.id);
    setNotice({ kind: 'info', message: 'Touching clips joined.' });
  };

  const exportSelected = async () => {
    if (!selectedClip || !preferences || !session || busy) return;
    const source = session?.sources.find((item) => item.id === selectedClip.sourceId);
    if (!source) return setStatus('The source for this clip is unavailable.');
    const projectId = session.id;
    const clipId = selectedClip.id;
    const exportedRecipe = selectedClip.recipe;
    try {
      setProgress({ clipId: selectedClip.id, percent: 0, message: 'Preparing export' });
      setExportStartedAt(Date.now());
      setStatus('Starting VapourSynth…');
      const completed = await window.cuttingFloor.exportClip({ source, clip: selectedClip, projectName: session.name, exportRoot: exportRootOverride ?? session.exportPath ?? preferences.exportPath });
      if (completed) {
        const latestClip = sessionRef.current?.id === projectId ? sessionRef.current.clips.find((clip) => clip.id === clipId) : undefined;
        const recipeChanged = Boolean(latestClip && JSON.stringify(latestClip.recipe) !== JSON.stringify(exportedRecipe));
        setSession((current) => {
          if (!current || current.id !== projectId) return current;
          return { ...current, clips: current.clips.map((clip) => {
            if (clip.id !== clipId) return clip;
            return { ...clip, completed: !recipeChanged, outputPath: completed.outputPath, processingEngine: completed.processingEngine, fallbackReason: completed.fallbackReason, pngFramesPath: completed.pngFramesPath, outputWarnings: completed.outputWarnings };
          }) };
        });
        setExportRootOverride(undefined);
        const warning = completed.outputWarnings?.[0];
        setStatus(recipeChanged ? `Exported ${completed.name} with the previous recipe; current changes remain Ready.` : warning ?? `Exported ${completed.name}`);
        if (warning) { setUndo(undefined); setNotice({ kind: 'info', message: warning }); }
        const index = session.clips.findIndex((clip) => clip.id === completed.id);
        const next = [...session.clips.slice(index + 1), ...session.clips.slice(0, index)].find((clip) => !clip.completed);
        if (next) setSelectedClipId(next.id);
      } else setStatus('Export cancelled');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') setStatus('Export cancelled; incomplete output removed and completed work preserved.');
      else reportError(error);
    } finally { setExportStartedAt(undefined); }
  };

  const tuneSelected = async () => {
    if (!selectedClip || !preferences || !session || busy || tuning) return;
    const source = session?.sources.find((item) => item.id === selectedClip.sourceId);
    if (!source) return setStatus('The source for this clip is unavailable.');
    const projectId = session.id;
    try {
      setTuning(true);
      setTuneStatus('Rendering first preview');
      setTuneResult(null);
      const stop = window.cuttingFloor.onPreviewTuneProgress((prog) => setTuneStatus(prog.message));
      let round = 0;
      const renderAndAnalyze = async (settings: PreviewSettings) => {
        round += 1;
        setTuneStatus(`Round ${round} · rendering preview`);
        return window.cuttingFloor.tunePreview({ source, clip: selectedClip, projectName: session.name, exportRoot: exportRootOverride ?? session.exportPath ?? preferences.exportPath }, settings);
      };
      const initialEvidence = { combPixels: source.sourceAnalysis.combPixels ?? 0, distinctLumaLevels: source.sourceAnalysis.distinctLumaLevels ?? 256, neighborDiff: source.sourceAnalysis.noise ?? 0 };
      const result = await runPreviewLoop(previewSettingsForEvidence(initialEvidence), 5, renderAndAnalyze);
      stop();
      const patch = previewSettingsToRecipePatch(result.settings);
      updateRecipe(patch);
      // Update the source's pixel evidence so Source Guidance reflects what
      // self-tune actually measured on rendered preview pixels.
      const lastAnalysis = result.rounds.at(-1);
      if (lastAnalysis) {
        const srcId = source.id;
        setSession((current) => current ? { ...current, sources: current.sources.map((s) => s.id === srcId ? { ...s, sourceAnalysis: { ...s.sourceAnalysis, combPixels: lastAnalysis.evidence.combPixels, distinctLumaLevels: lastAnalysis.evidence.distinctLumaLevels, noise: lastAnalysis.evidence.neighborDiff } } : s) } : current);
      }
      const fixes = Object.entries({ deinterlace: result.settings.deinterlace, deband: result.settings.deband, denoise: result.settings.denoise, sharpen: result.settings.sharpen }).filter(([, on]) => on).map(([k]) => k);
      setTuneResult({ converged: result.converged, rounds: result.rounds.length, fixes });
      setTuneStatus(result.converged ? `Converged after ${result.rounds.length} round${result.rounds.length === 1 ? '' : 's'}` : `Stopped after ${result.rounds.length} rounds (no further improvement)`);
      setStatus(fixes.length ? `Self-tune applied: ${fixes.join(', ')}. Review the recipe, then export.` : 'Self-tune found no fix needed — the preview already measured clean.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') setTuneStatus('Self-tune cancelled');
      else reportError(error);
    } finally { setTuning(false); setTuneStatus(''); }
  };

  const exportAll = async () => {
    if (!session || !preferences || busy) return;
    const readyClips = session.clips.filter((clip) => !clip.completed);
    if (!readyClips.length) return;
    const projectId = session.id;
    let done = 0;
    try {
      for (let i = 0; i < readyClips.length; i += 1) {
        const clip = readyClips[i];
        const source = session.sources.find((item) => item.id === clip.sourceId);
        if (!source) continue;
        setBatchProgress({ done, total: readyClips.length, message: `Rendering ${clip.name}` });
        const result = await window.cuttingFloor.exportClip({ source, clip, projectName: session.name, exportRoot: exportRootOverride ?? session.exportPath ?? preferences.exportPath });
        done += 1;
        if (sessionRef.current?.id === projectId) {
          setSession((current) => (current && current.id === projectId ? { ...current, clips: current.clips.map((c) => (c.id === clip.id ? { ...c, completed: true, outputPath: result.outputPath, processingEngine: result.processingEngine, fallbackReason: result.fallbackReason, receiptPath: result.receiptPath, outputWarnings: result.outputWarnings, pngFramesPath: result.pngFramesPath } : c)) } : current));
        }
      }
      setStatus(`Batch export finished — ${done} of ${readyClips.length} clips rendered.`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') setStatus(`Batch export stopped — ${done} of ${readyClips.length} clips completed.`);
      else reportError(error);
    } finally {
      setBatchProgress(null);
    }
  };

  const chooseExportFolder = async () => {
    if (!preferences) return;
    try {
    const folder = await window.cuttingFloor.chooseLocation('exportPath', exportRootOverride ?? session?.exportPath ?? preferences.exportPath);
      if (folder) setExportRootOverride(folder);
    } catch (error) { reportError(error); }
  };

  const savePreferences = async (next: StudioPreferences) => {
    setSaveState('saving');
    try { setPreferences(await window.cuttingFloor.savePreferences(next)); setSaveState('saved'); }
    catch (error) { setSaveState('error'); reportError(error); }
  };

  const closeWelcome = () => {
    setShowWelcome(false);
    setWelcomeStep(0);
    void savePreferences({ ...preferences!, onboardingComplete: true });
  };

  const submitProjectDialog = async () => {
    if (!projectDialog?.name.trim()) return;
    const dialog = projectDialog;
    setProjectDialog(undefined);
    if (dialog.mode === 'create') await createProject(dialog.name.trim());
    else if (dialog.id) await renameProject(dialog.id, dialog.name.trim());
  };

  const modalKey = showWelcome ? 'welcome' : downloadSetup ? 'download' : projectDialog ? 'project' : undefined;

  useEffect(() => {
    if (!modalKey) return;
    modalReturnFocus.current = document.activeElement as HTMLElement;
    window.setTimeout(() => modal.current?.querySelector<HTMLElement>('[autofocus], input, button, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showWelcome) closeWelcome();
        else if (downloadSetup) setDownloadSetup(undefined);
        else setProjectDialog(undefined);
        return;
      }
      if (event.key !== 'Tab' || !modal.current) return;
      const focusable = [...modal.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); modalReturnFocus.current?.focus(); };
  }, [modalKey]);

  if (loadingError) return <div className="startup-error" role="alert"><img src={appIcon} alt="" /><h1>Vapormint could not open</h1><p>{loadingError}</p><button className="primary" onClick={() => window.location.reload()}>Try again</button><small>Your projects remain saved.</small></div>;
  if (!session || !preferences) return <div className="loading" role="status" aria-live="polite">Opening Vapormint…</div>;
  const modalOpen = Boolean(modalKey);

  return <div className={`app-shell theme-${preferences.theme ?? 'dark'}${preferences.palette && preferences.palette !== 'default' ? ` palette-${preferences.palette}` : ''}`}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="titlebar" aria-hidden={modalOpen} inert={modalOpen ? true : undefined}>
      <div className="wordmark"><img src={appIcon} alt="" /><span>VAPORMINT</span></div>
      <nav className="nav-links" aria-label="Main navigation">{nav.map(([name, label]) => <button key={name} disabled={busy} className={view === name ? 'active' : ''} aria-current={view === name ? 'page' : undefined} onClick={() => setView(name)}>{label}</button>)}</nav>
      <div className="project-name"><i>{session.name}</i></div>
      <div className="title-theme" role="group" aria-label="Theme"><button aria-pressed={preferences.theme !== 'light'} className={preferences.theme !== 'light' ? 'active' : ''} onClick={() => void savePreferences({ ...preferences, theme: 'dark' })}>Dark</button><button aria-pressed={preferences.theme === 'light'} className={preferences.theme === 'light' ? 'active' : ''} onClick={() => void savePreferences({ ...preferences, theme: 'light' })}>Light</button></div>
      <button className="menu-button" onClick={() => setProjectDialog({ mode: 'create', name: 'Untitled Vapormint' })}>+ Menu</button>
    </header>

    {updateInfo && !updateDismissed && (updateInfo.status === 'available' || updateInfo.status === 'error') && <div className={`update-banner${updateInfo.status === 'error' ? ' update-banner-error' : ''}`} role="status" aria-live="polite"><span className="update-banner-mark" aria-hidden="true">{updateInfo.status === 'error' ? '!' : '✦'}</span><div className="update-banner-copy"><b>{updateInfo.status === 'error' ? 'Update check failed' : `Version ${updateInfo.version} is available`}</b><small>{updateInfo.status === 'error' ? updateInfo.message : 'A new release of Vapormint is out — grab it from the release page.'}</small></div>{updateInfo.status === 'error' ? <button className="update-banner-retry" onClick={() => { setUpdateDismissed(false); setUpdateInfo(undefined); void window.cuttingFloor.checkForUpdates(); }}>Retry</button> : <button className="update-banner-cta" onClick={() => void window.cuttingFloor.applyUpdate()}>Get update</button>}<button className="update-banner-dismiss" aria-label="Dismiss update notice" title="Dismiss until the next launch" onClick={() => setUpdateDismissed(true)}>×</button></div>}

    <aside className="sidebar" aria-hidden={modalOpen} inert={modalOpen ? true : undefined}>
      <img className="rail-logo" src={appIcon} alt="Vapormint" />
      <nav>{nav.map(([name, label]) => <button disabled={busy} title={busy ? 'Finish or stop the active task before changing workspaces.' : label} aria-label={label} aria-current={view === name ? 'page' : undefined} key={name} className={view === name ? 'active' : ''} onClick={() => setView(name)}><NavIcon name={name} /></button>)}</nav>
      <div className="runtime-rail" title={runtime.error ?? 'Bundled local pipeline ready'} aria-label={`Bundled pipeline: ${runtime.error ?? 'all required tools ready'}`}>{[runtime.ffmpeg, runtime.ffprobe, runtime.vspipe, runtime.ytDlp, runtime.vapourSynthPlugins].map((ok, index) => <span key={index} className={ok ? 'ok' : 'missing'} />)}</div>
    </aside>

    <main id="main-content" aria-hidden={modalOpen} inert={modalOpen ? true : undefined}>
      {view === 'home' && <Home session={session} projects={projects} busy={busy} onNewProject={() => setProjectDialog({ mode: 'create', name: 'Untitled Vapormint' })} onOpenProject={openProject} onRenameProject={(id) => { const project = projects.find((item) => item.id === id); setProjectDialog({ mode: 'rename', id, name: project?.name ?? 'Untitled Vapormint' }); }} onDeleteProject={deleteProject} onImport={() => importVideos('files')} onSeason={() => importVideos('season')} onWatch={() => importVideos('watch')} onDownload={prepareDownload} onOpenSource={(id) => { setSession({ ...session, activeSourceId: id }); setView('find'); }} />}
      {view === 'find' && <FindMoments
        session={session} activeSource={activeSource} video={video} playhead={playhead} markIn={markIn} markOut={markOut}
        speed={speed} muted={muted} queueCollapsed={queueCollapsed} queueFilter={queueFilter} status={status} onImport={() => importVideos('files')} onSeek={seek} scrubbing={scrubbing}
        onTime={(value) => { if (scrubbing.current) return; setPlayhead(value); const progressValue = duration ? value / duration : 0; if (Math.abs((activeSource?.progress ?? 0) - progressValue) > 0.002) setSession({ ...session, sources: session.sources.map((source) => source.id === activeSource?.id ? { ...source, progress: progressValue } : source) }); }} onMarkIn={() => { setMarkIn(playhead); setStatus(`Mark In set at ${formatTime(playhead)}`); }} onMarkOut={() => { setMarkOut(playhead); setStatus(`Mark Out set at ${formatTime(playhead)}`); }} onQueue={queueClip}
        onSpeed={(next) => { setSpeed(next); if (video.current) video.current.playbackRate = next; }}
        onToggleMute={() => setMuted((value) => !value)} onFilter={setQueueFilter} onJoin={joinRanges} onResetCompleted={resetCompleted} onClearUnfinished={clearUnfinished} onMarkUnfinished={markUnfinished} onExportAll={exportAll} exportingCount={batchProgress?.total ?? 0} batchProgress={batchProgress}
        onToggleReviewed={() => setSession({ ...session, sources: session.sources.map((source) => source.id === activeSource?.id ? { ...source, finished: !source.finished } : source) })}
        onReanalyze={() => void reanalyzeActiveSource()}
        onToggleQueue={() => setQueueCollapsed((value) => !value)} onSelectSource={(id) => setSession({ ...session, activeSourceId: id })}
        onRemove={removeClip} onSelectClip={(id) => { setSelectedClipId(id); setView('process'); }}
      />}
      {view === 'process' && <ProcessClips
        session={session} source={selectedSource} clip={selectedClip} progress={progress} status={status} onSelect={setSelectedClipId}
        onRecipe={updateRecipe} onExport={exportSelected} onCancel={() => window.cuttingFloor.cancelTask()}
        onMove={moveClip} onRemove={removeClip} expertMode={preferences.expertMode}
        exportRoot={exportRootOverride ?? session.exportPath ?? preferences.exportPath} exporting={Boolean(exportStartedAt)} exportElapsed={exportElapsed} onChooseExportFolder={chooseExportFolder}
        onApplyRecipeToOtherClips={applyRecipeToOtherClips}
        onResetAll={resetCompleted}
        onFind={() => setView('find')}
        onTune={tuneSelected} tuning={tuning} tuneStatus={tuneStatus} tuneResult={tuneResult} busy={busy}
        onLook={(look) => selectedClip && updateRecipe(applyLook(selectedClip.recipe, look, selectedSource?.sourceAnalysis))}
        onAspect={(aspectPreset) => { if (!selectedClip || !selectedSource) return; const oriented = orientedSourceDimensions(selectedSource.sourceAnalysis.width, selectedSource.sourceAnalysis.height, selectedClip.recipe.rotation); updateRecipe(fitCropToAspect({ ...selectedClip.recipe, aspectPreset }, oriented.width, oriented.height)); }}
        onCrop={(edge, value) => { if (!selectedClip || !selectedSource) return; const oriented = orientedSourceDimensions(selectedSource.sourceAnalysis.width, selectedSource.sourceAnalysis.height, selectedClip.recipe.rotation); updateRecipe(setCropEdge(selectedClip.recipe, edge, value, oriented.width, oriented.height)); }}
      />}
      {view === 'settings' && <Settings session={session} preferences={preferences} runtime={runtime} saveState={saveState} onSession={setSession} onWorkspace={applyWorkspace} onPreferences={savePreferences} onError={reportError} onNotice={(message) => { setUndo(undefined); setNotice({ kind: 'info', message }); }} onShowWelcome={() => { setWelcomeStep(0); setShowWelcome(true); }} />}
    </main>
    {downloadSetup && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDownloadSetup(undefined); }}>
      <form ref={(node) => { modal.current = node; }} className="download-dialog" role="dialog" aria-modal="true" aria-labelledby="download-dialog-title" onSubmit={(event) => { event.preventDefault(); void downloadVideo(); }}>
        <span className="eyebrow">PUBLIC VIDEO LINK</span><h2 id="download-dialog-title">New download project</h2><p>The app will show live download and processing progress after you start.</p>
        <label className="field"><span>PROJECT NAME</span><input autoFocus maxLength={100} value={downloadSetup.name} onChange={(event) => setDownloadSetup({ ...downloadSetup, name: event.target.value })} /></label>
        <label className="field"><span>YOUTUBE ACCESS</span><select value={downloadSetup.browser} onChange={(event) => setDownloadSetup({ ...downloadSetup, browser: event.target.value as DownloadBrowser })}><option value="none">Public link only</option><option value="edge">Use Microsoft Edge sign-in</option><option value="chrome">Use Google Chrome sign-in</option><option value="firefox">Use Firefox sign-in</option><option value="brave">Use Brave sign-in</option></select><small>Only choose a browser if YouTube requests sign-in. yt-dlp reads its local cookies for this download; they are not stored by Vapormint.</small></label>
        <label className="field"><span>DOWNLOADED SOURCE MASTER</span><div className="location-row"><input readOnly title={downloadSetup.downloadPath} value={downloadSetup.downloadPath} /><button type="button" className="ghost" onClick={() => void chooseDownloadFolder('downloadPath')}>Choose</button></div></label>
        <label className="field"><span>FINISHED CLIPS + PNG FRAMES</span><div className="location-row"><input readOnly title={downloadSetup.exportPath} value={downloadSetup.exportPath} /><button type="button" className="ghost" onClick={() => void chooseDownloadFolder('exportPath')}>Choose</button></div></label>
        <div className="dialog-actions"><button type="button" className="ghost" onClick={() => setDownloadSetup(undefined)}>Cancel</button><button className="primary" disabled={!downloadSetup.name.trim()}>Start download</button></div>
      </form>
    </div>}
    {projectDialog && <div className="modal-backdrop" role="presentation">
      <form ref={(node) => { modal.current = node; }} className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={(event) => { event.preventDefault(); void submitProjectDialog(); }}>
        <span className="eyebrow">PROJECT LIBRARY</span><h2 id="project-dialog-title">{projectDialog.mode === 'create' ? 'Create a new project' : 'Rename project'}</h2>
        <label className="field"><span>PROJECT NAME</span><input autoFocus maxLength={100} value={projectDialog.name} onChange={(event) => setProjectDialog({ ...projectDialog, name: event.target.value })} /></label>
        <div className="dialog-actions"><button type="button" className="ghost" onClick={() => setProjectDialog(undefined)}>Cancel</button><button className="primary" disabled={!projectDialog.name.trim()}>{projectDialog.mode === 'create' ? 'Create project' : 'Save name'}</button></div>
      </form>
    </div>}
    {taskStartedAt && <aside className="global-task" aria-busy="true" aria-live="polite">
      <span className="global-task-spinner" aria-hidden="true" />
      <div><span>{taskKind === 'download' ? 'DOWNLOADING VIDEO' : 'PREPARING SOURCE'}</span><b>{taskProgress?.message ?? 'Preparing safely'}</b><small>{Math.round(taskProgress?.percent ?? 0)}% · {Math.floor(taskElapsed / 60)}:{String(taskElapsed % 60).padStart(2, '0')} elapsed</small></div>
      <strong>{Math.round(taskProgress?.percent ?? 0)}%</strong>
      <button className="ghost" onClick={() => window.cuttingFloor.cancelTask()}>Stop safely</button>
      <div className="progress-track" role="progressbar" aria-label={taskKind === 'download' ? 'Video download progress' : 'Source preparation progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(taskProgress?.percent ?? 0)}><i style={{ width: `${taskProgress?.percent ?? 0}%` }} /></div>
    </aside>}
    {showWelcome && <div className="modal-backdrop welcome-backdrop">
      <section ref={(node) => { modal.current = node; }} className="welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-body">
        <div className="welcome-brand"><span>VAPORMINT</span><span className="welcome-step">{welcomeStep + 1} / {welcomeSteps.length}</span><button autoFocus aria-label="Close welcome guide" title="Close guide" onClick={closeWelcome}>×</button></div>
        <div className="welcome-copy"><span className="welcome-symbol" aria-hidden="true">{welcomeSteps[welcomeStep].symbol}</span><div><span className="eyebrow">{welcomeSteps[welcomeStep].eyebrow}</span><h2 id="welcome-title">{welcomeSteps[welcomeStep].title}</h2><p id="welcome-body">{welcomeSteps[welcomeStep].body}</p><small>{welcomeSteps[welcomeStep].note}</small></div></div>
        <div className="welcome-footer"><div className="welcome-progress" aria-label={`Step ${welcomeStep + 1} of ${welcomeSteps.length}`}>{welcomeSteps.map((step, index) => <span key={step.eyebrow} className={index === welcomeStep ? 'active' : index < welcomeStep ? 'complete' : ''} />)}</div><button className="text-button" onClick={closeWelcome}>Skip</button>{welcomeStep > 0 && <button className="ghost" onClick={() => setWelcomeStep((step) => step - 1)}>Back</button>}<button className="primary" onClick={() => welcomeStep === welcomeSteps.length - 1 ? closeWelcome() : setWelcomeStep((step) => step + 1)}>{welcomeStep === welcomeSteps.length - 1 ? 'Enter Vapormint' : 'Next'}</button></div>
      </section>
    </div>}
    {notice && <aside className={`app-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'error' ? 'Something needs attention' : 'Project updated'}</span><p>{notice.message}</p><div className="notice-actions">{undo && notice.kind === 'info' && <button className="notice-undo" onClick={() => { setSession(undo.session); setSelectedClipId(undo.selectedClipId); setUndo(undefined); setNotice(undefined); setStatus('Last project change undone.'); }}>Undo</button>}<button aria-label="Dismiss message" onClick={() => { setUndo(undefined); setNotice(undefined); }}>×</button></div></aside>}
    <footer className="app-statusbar"><span>LOCAL WORKSPACE</span><span className="statusbar-tagline">{session.sources.length} sources · {session.clips.length} clips</span><span className="statusbar-save">{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save error' : 'All changes saved'}</span></footer>
  </div>;
}

function NavIcon({ name }: { name: ViewName }) {
  const paths: Record<ViewName, React.ReactNode> = {
    home: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5" /></>,
    find: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></>,
    process: <><path d="m12 3-9 5 9 5 9-5-9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    settings: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function ClipReel({ session }: { session: StudioSession }) {
  const ref = useRef<HTMLVideoElement>(null);
  const idx = useRef(0);
  const [clips, setClips] = useState<{ url: string; poster?: string; start: number; end: number }[]>([]);

  useEffect(() => {
    window.cuttingFloor.loadReelClips().then((items) => {
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      idx.current = 0;
      setClips(items);
    }).catch(() => {});
  }, [session.id, session.clips.length, session.sources.length]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !clips.length) return;
    let url = '';
    const load = () => {
      const clip = clips[idx.current % clips.length];
      if (url !== clip.url) { url = clip.url; v.src = clip.url; }
      const seekPlay = () => { v.currentTime = clip.start; v.play().catch(() => {}); };
      if (v.readyState >= 1) seekPlay(); else v.addEventListener('loadedmetadata', seekPlay, { once: true });
    };
    const onTime = () => { const clip = clips[idx.current % clips.length]; if (clip && v.currentTime >= clip.end - 0.05) { idx.current++; load(); } };
    v.addEventListener('timeupdate', onTime);
    load();
    return () => v.removeEventListener('timeupdate', onTime);
  }, [clips]);

  if (!clips.length) {
    const thumb = session.sources.find((s) => s.thumbnailUrl);
    return thumb?.thumbnailUrl ? <img src={thumb.thumbnailUrl} alt="" /> : <span className="preview-empty">&#9654;</span>;
  }
  return <video ref={ref} poster={clips[0]?.poster} muted playsInline />;
}

function Home({ session, projects, busy, onNewProject, onOpenProject, onRenameProject, onDeleteProject, onImport, onSeason, onWatch, onDownload, onOpenSource }: { session: StudioSession; projects: ProjectCard[]; busy: boolean; onNewProject(): void; onOpenProject(id: string): void; onRenameProject(id: string): void; onDeleteProject(id: string): void; onImport(): void; onSeason(): void; onWatch(): void; onDownload(url: string): boolean; onOpenSource(id: string): void }) {
  const [url, setUrl] = useState('');
  const projectIndex = String(projects.findIndex((p) => p.id === session.id) + 1).padStart(2, '0');
  return <section className="page home-page">
    <div className="home-intro">
      <span className="eyebrow">({projectIndex} / WORKSPACE)</span>
      <h1>The cutting floor<span className="accent-dot">.</span></h1>
      <p className="home-desc">Find your moments. Keep them beautifully.</p>
      <div className="home-actions">
        <button disabled={busy} onClick={onSeason}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5h7l2-2h7v14H2z" /></svg>Add season folder</button>
        <button disabled={busy} onClick={onImport}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m-4-4 4 4 4-4M3 15v2h14v-2" /></svg>Add video files</button>
        <button disabled={busy} onClick={onWatch}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" /></svg>Watch folder</button>
        <button disabled={busy} onClick={onNewProject}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>New project</button>
      </div>
      <div className="home-link">
        <div className="download-row"><svg className="link-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 12l4-4m-2.5-2.5L12 3a3 3 0 0 1 4.2 4.2L13.5 10m-7 0L4 12.8A3 3 0 0 0 8.2 17L10.5 14.5" /></svg><input aria-label="Public video link" placeholder="Paste a public video link" disabled={busy} value={url} onChange={(event) => setUrl(event.target.value)} /><button className="ghost download-go" disabled={busy || !url.trim()} onClick={() => { if (onDownload(url.trim())) setUrl(''); }}>&rarr;</button></div>
      </div>
    </div>
    <div className="home-preview">
      <div className="preview-frame"><ClipReel session={session} /></div>
      <div className="preview-info">
        <span className="accent-dot" style={{ fontSize: 10 }}>&bull;</span>
        <div className="preview-name"><h2>{session.name}</h2></div>
        <span className="preview-stats">{session.sources.length} SOURCE{session.sources.length === 1 ? '' : 'S'} &middot; {session.clips.length} CLIPS</span>
        <button className="ghost continue-btn" onClick={() => { if (session.sources.length) { onOpenSource(session.sources[0].id); } }}>Continue editing &rarr;</button>
      </div>
    </div>
    <div className="home-recent">
      <div className="recent-head"><h2>Recent projects<span className="accent-dot">.</span></h2><span className="bracket-phrase">[ the last few cuts ]</span></div>
      <div className="recent-reel">{projects.map((project, i) => <article key={project.id} className={`reel-card ${project.id === session.id ? 'active' : ''}`}>
        <button disabled={busy} className="reel-open" onClick={() => onOpenProject(project.id)}>
          <span className="reel-thumb">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <i>{project.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'VM'}</i>}</span>
          <div className="reel-meta"><span className="reel-index">{String(i + 1).padStart(2, '0')}</span><span className="reel-sep">/</span><h3>{project.name}</h3><span className="reel-date">{project.completedCount}/{project.clipCount} clips</span></div>
        </button>
        <div className="reel-actions"><button disabled={busy} onClick={() => onRenameProject(project.id)}>Rename</button><button disabled={busy} className="danger" onClick={() => onDeleteProject(project.id)}>Delete</button></div>
      </article>)}</div>
    </div>
  </section>;
}

interface FindProps {
  session: StudioSession;
  activeSource?: StudioSession['sources'][number];
  video: React.RefObject<HTMLVideoElement | null>;
  playhead: number;
  markIn?: number;
  markOut?: number;
  speed: number;
  muted: boolean;
  queueCollapsed: boolean;
  queueFilter: 'all' | 'ready' | 'completed';
  status: string;
  onImport(): void;
  onSeek(value: number): void;
  scrubbing: React.RefObject<boolean>;
  onTime(value: number): void;
  onMarkIn(): void;
  onMarkOut(): void;
  onQueue(): void;
  onSpeed(value: number): void;
  onToggleMute(): void;
  onFilter(value: 'all' | 'ready' | 'completed'): void;
  onJoin(): void;
  onResetCompleted(): void;
  onClearUnfinished(): void;
  onMarkUnfinished(id: string): void;
  onExportAll(): void;
  exportingCount: number;
  batchProgress: { done: number; total: number; message: string } | null;
  onToggleReviewed(): void;
  onReanalyze(): void;
  onToggleQueue(): void;
  onSelectSource(id: string): void;
  onRemove(id: string): void;
  onSelectClip(id: string): void;
}

function FindMoments(props: FindProps) {
  const { session, activeSource, video, playhead, markIn, markOut, speed, muted, queueCollapsed, queueFilter } = props;
  const workspace = useRef<HTMLElement>(null);
  useEffect(() => { workspace.current?.focus(); }, [activeSource?.id]);
  if (!activeSource) return <EmptyPage title="NO SOURCE ON THE DECK" action="IMPORT VIDEO" onAction={props.onImport} />;
  const duration = activeSource.sourceAnalysis.duration;
  const frameDuration = 1 / (activeSource.sourceAnalysis.fps || 30);
  return <section ref={workspace} tabIndex={-1} className="find-page">
    <div className="source-strip">
      <h1 className="find-heading">Find moments<span className="accent-dot">.</span></h1>
      <div className="source-strip-info"><select value={activeSource.id} onChange={(event) => props.onSelectSource(event.target.value)}>{session.sources.map((source) => <option key={source.id} value={source.id}>{source.episodeLabel}</option>)}</select><span className="source-meta">{activeSource.sourceAnalysis.width}&times;{activeSource.sourceAnalysis.height} / {activeSource.sourceAnalysis.fps.toFixed(0)} fps{activeSource.sourceAnalysis.hdr !== 'Unknown' ? ` / ${activeSource.sourceAnalysis.hdr}` : ''}</span></div>
      <details className="analysis-popover"><summary title="Technical source clues and conservative processing recommendations.">Analysis</summary><b>{activeSource.sourceAnalysis.qualitySummary}</b><span>{activeSource.sourceAnalysis.codec} &middot; {activeSource.sourceAnalysis.format} &middot; {activeSource.sourceAnalysis.pixelFormat} &middot; {activeSource.sourceAnalysis.bitDepth}-bit &middot; {activeSource.sourceAnalysis.bitrate ? `${(activeSource.sourceAnalysis.bitrate / 1_000_000).toFixed(1)} Mbps` : 'bitrate unknown'}</span>{sourceGuidanceItems(activeSource.sourceAnalysis).map((item) => <p key={item.title}>{item.confidence} confidence — {item.title}: {item.recommendation} Evidence: {item.evidence} Check: {item.check}</p>)}<InfoTip>Resolution, bitrate, bit depth, HDR, interlacing, variable frame rate, and freezes are technical clues&mdash;not a promise that every frame will look good.</InfoTip><button className="ghost" onClick={props.onReanalyze}>Reanalyze distributed samples</button></details>
      <button className="ghost" onClick={props.onToggleReviewed}>{activeSource.finished ? '✓ Reviewed' : 'Mark reviewed'}</button>
      <button className="ghost" onClick={props.onImport}>+ Add source</button>
    </div>
    <div className="workbench">
      <div className="viewer-panel">
        <div className="video-wrap">{activeSource.missing ? <div className="missing-source">SOURCE MOVED OR DELETED<br /><small>{activeSource.sourcePath}</small></div> : <video ref={video} key={activeSource.id} src={activeSource.fileUrl} muted={muted} playsInline onTimeUpdate={(event) => props.onTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => { event.currentTarget.playbackRate = speed; }} />}<div className="frame-corners" /></div>
        <div className="timeline">
          <input title="Drag directly to scrub through the source." aria-label="Playhead" type="range" min="0" max={duration || 1} step={1 / (activeSource.sourceAnalysis.fps || 30)} value={playhead} onPointerDown={() => { props.scrubbing.current = true; }} onPointerUp={() => { props.scrubbing.current = false; }} onChange={(event) => props.onSeek(Number(event.target.value))} />
          <div className="time-row"><b>{formatTime(playhead)}</b><span>IN {markIn === undefined ? '—' : formatTime(markIn)} · OUT {markOut === undefined ? '—' : formatTime(markOut)}</span><b>{formatTime(duration)}</b></div>
        </div>
        <div className="transport">
          <button aria-keyshortcuts="Shift+ArrowLeft" title="Move one second backward. Shift + Left Arrow also works." onClick={() => props.onSeek(playhead - 1)}>−1s</button><button aria-keyshortcuts="ArrowLeft" title="Move exactly one frame backward." onClick={() => props.onSeek(playhead - frameDuration)}>‹ FRAME</button>
          <button aria-label="Play or pause" aria-keyshortcuts="Space" title="Play or pause. Space also works." className="play" onClick={() => video.current?.paused ? void video.current.play() : video.current?.pause()}>▶</button>
          <button aria-keyshortcuts="ArrowRight" title="Move exactly one frame forward." onClick={() => props.onSeek(playhead + frameDuration)}>FRAME ›</button><button aria-keyshortcuts="Shift+ArrowRight" title="Move one second forward. Shift + Right Arrow also works." onClick={() => props.onSeek(playhead + 1)}>+1s</button>
          <button title="Audio starts muted and can be restored here." onClick={props.onToggleMute}>{muted ? 'UNMUTE' : 'MUTE'}</button>
          <div className="speed">{[1, 2, 3].map((value) => <button title={`${value}× affects preview playback only.`} key={value} className={speed === value ? 'active' : ''} onClick={() => props.onSpeed(value)}>{value}×</button>)}</div>
        </div>
        <div className="mark-controls">
          <button aria-keyshortcuts="I" onClick={props.onMarkIn}><kbd>I</kbd><span>MARK IN<strong>{markIn === undefined ? 'NOT SET' : formatTime(markIn)}</strong></span></button>
          <button aria-keyshortcuts="O" onClick={props.onMarkOut}><kbd>O</kbd><span>MARK OUT<strong>{markOut === undefined ? 'NOT SET' : formatTime(markOut)}</strong></span></button>
          <button aria-keyshortcuts="Enter" className="enter-clip" disabled={markIn === undefined || markOut === undefined} title={markIn === undefined || markOut === undefined ? 'Set both I and O before entering the clip.' : 'Add the marked range to the project queue.'} onClick={props.onQueue}>ENTER CLIP <kbd>ENTER</kbd></button>
        </div>
        <div className="shortcut-line"><kbd>SPACE</kbd> PLAY / PAUSE <kbd>← →</kbd> FRAME <kbd>SHIFT + ← →</kbd> SECOND <kbd>I</kbd> IN <kbd>O</kbd> OUT <kbd>ENTER</kbd> QUEUE</div>
      </div>
      <aside className={`clip-queue ${queueCollapsed ? 'collapsed' : ''}`}>
        <button title="Hide the queue to give the player more room." className="queue-head" onClick={props.onToggleQueue} aria-expanded={!queueCollapsed}><span><h2 className="selects-title">The selects<span className="accent-dot">.</span></h2><small>({session.clips.length})</small></span><i>{queueCollapsed ? '‹' : '›'}</i></button>
        {!queueCollapsed && <><div className="queue-filter-tabs" role="tablist">{(['all', 'ready', 'completed'] as const).map((tab) => <button key={tab} role="tab" aria-selected={queueFilter === tab} onClick={() => props.onFilter(tab)}>{tab === 'all' ? 'All' : tab === 'ready' ? 'Ready' : 'Exported'}</button>)}</div>
        <div className="queue-body"><div className="queue-tools"><button title="Merge overlapping or frame-adjacent ranges from the same source." onClick={props.onJoin}>Join touching</button><button title="Return every completed clip to Ready without deleting exports from disk." onClick={props.onResetCompleted}>Reset completed</button><button title="Remove all unfinished clips from this project." onClick={props.onClearUnfinished}>Clear ready</button></div>
        {props.batchProgress && <div className="batch-progress" aria-live="polite"><div className="progress-copy"><span>BATCH EXPORT</span><b>{props.batchProgress.message}</b><small>{props.batchProgress.done} of {props.batchProgress.total} clips</small></div><div className="progress-track" role="progressbar" aria-label="Batch export progress" aria-valuemin={0} aria-valuemax={props.batchProgress.total} aria-valuenow={props.batchProgress.done}><i style={{ width: `${props.batchProgress.total ? Math.round((props.batchProgress.done / props.batchProgress.total) * 100) : 0}%` }} /></div></div>}
        {session.clips.filter((clip) => queueFilter === 'all' || (queueFilter === 'ready' ? !clip.completed : clip.completed)).map((clip, index) => <div className={`queue-item ${clip.completed ? 'complete' : ''}`} key={clip.id}>
          <button className="queue-open" onClick={() => props.onSelectClip(clip.id)}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{clip.name}</b><small>{formatTime(clip.start)} — {formatTime(clip.end)}</small></div></button>
          {clip.completed && <button title="Return this clip to Ready without deleting its previous export from disk." className="queue-state" aria-label={`Mark ${clip.name} unfinished`} onClick={() => props.onMarkUnfinished(clip.id)}>↺</button>}
          <button className="remove" aria-label={`Remove ${clip.name}`} onClick={() => props.onRemove(clip.id)}>×</button>
        </div>)}{!session.clips.length && <p className="queue-empty">Set I and O points, then press Enter.</p>}
        <button className="process-queue-btn" disabled={props.exportingCount > 0 || !session.clips.some((clip) => !clip.completed)} onClick={props.onExportAll}>{props.exportingCount ? `Exporting ${props.exportingCount}…` : 'Process queue →'}</button>
        </div></>}
      </aside>
    </div>
    <footer className="statusbar"><span className="status-dot" />{props.status}<b>{activeSource.displayName}</b></footer>
  </section>;
}

interface ProcessProps {
  session: StudioSession;
  source?: StudioSource;
  clip?: SessionClip;
  progress?: ExportProgress;
  status: string;
  expertMode: boolean;
  exportRoot: string;
  exporting: boolean;
  exportElapsed: number;
  onSelect(id: string): void;
  onRecipe(patch: Partial<ClipRecipe>): void;
  onExport(): void;
  onCancel(): void;
  onMove(id: string, delta: number): void;
  onRemove(id: string): void;
  onLook(look: StudioLook): void;
  onAspect(aspect: ClipRecipe['aspectPreset']): void;
  onCrop(edge: 'cropLeft' | 'cropRight' | 'cropTop' | 'cropBottom', value: number): void;
  onChooseExportFolder(): void;
  onApplyRecipeToOtherClips(): void;
  onResetAll(): void;
  onFind(): void;
  onTune(): void;
  tuning: boolean;
  tuneStatus: string;
  tuneResult: { converged: boolean; rounds: number; fixes: string[] } | null;
  busy: boolean;
}

function ReceiptModal({ receipt, onClose }: { receipt: RenderReceipt; onClose(): void }) {
  const fmt = (n?: number) => n === undefined ? '—' : String(n);
  return <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label={`Render receipt for ${receipt.clipName}`} onClick={onClose}>
    <div className="receipt-modal" onClick={(event) => event.stopPropagation()}>
      <div className="receipt-head"><div><span className="eyebrow">RENDER RECEIPT</span><h2 title={receipt.clipName}>{receipt.clipName}</h2></div><button className="ghost" aria-label="Close receipt" onClick={onClose}>×</button></div>
      <dl className="receipt-grid">
        <div><dt>RENDERED</dt><dd>{new Date(receipt.rendered).toLocaleString()}</dd></div>
        <div><dt>ENGINE</dt><dd>{receipt.engine}</dd>{receipt.fallbackReason && <dd className="receipt-fallback">{receipt.fallbackReason}</dd>}</div>
        <div><dt>CLIP RANGE</dt><dd>{formatTime(receipt.clipRange.start)} — {formatTime(receipt.clipRange.end)}</dd></div>
        <div><dt>OUTPUT FORMAT</dt><dd>{receipt.recipe.outputFormat}</dd></div>
      </dl>
      <div className="receipt-section"><h3>SOURCE</h3><dl className="receipt-grid">
        <div><dt>LABEL</dt><dd>{receipt.sourceLabel}</dd></div>
        <div><dt>PATH</dt><dd className="receipt-path" title={receipt.sourcePath}>{receipt.sourcePath}</dd></div>
        <div><dt>RESOLUTION</dt><dd>{receipt.source.width}×{receipt.source.height}</dd></div>
        <div><dt>FPS</dt><dd>{receipt.source.fps}</dd></div>
        <div><dt>DURATION</dt><dd>{formatTime(receipt.source.duration)}</dd></div>
        <div><dt>CODEC</dt><dd>{receipt.source.codec}</dd></div>
        <div><dt>PIXEL FORMAT</dt><dd>{receipt.source.pixelFormat} · {receipt.source.bitDepth}-bit</dd></div>
        <div><dt>COLOR</dt><dd>{receipt.source.hdr}</dd></div>
        <div><dt>CADENCE</dt><dd>{receipt.source.scanType} · {receipt.source.fieldOrder}</dd></div>
        {receipt.source.banding !== undefined && <div><dt>BANDING</dt><dd>{fmt(receipt.source.banding)}</dd></div>}
        {receipt.source.noise !== undefined && <div><dt>NOISE</dt><dd>{fmt(receipt.source.noise)}</dd></div>}
      </dl></div>
      <div className="receipt-section"><h3>OUTPUTS</h3><dl className="receipt-grid">
        <div><dt>MASTER</dt><dd className="receipt-path" title={receipt.outputs.masterPath}>{receipt.outputs.masterPath}</dd></div>
        {receipt.outputs.vapourSynthScript && <div><dt>VAPOURSYNTH SCRIPT</dt><dd className="receipt-path" title={receipt.outputs.vapourSynthScript}>{receipt.outputs.vapourSynthScript}</dd></div>}
        {receipt.outputs.pngFramesFolder && <div><dt>PNG FRAMES</dt><dd className="receipt-path" title={receipt.outputs.pngFramesFolder}>{receipt.outputs.pngFramesFolder}</dd></div>}
      </dl></div>
      {receipt.warnings.length > 0 && <div className="receipt-section"><h3>NOTES</h3><ul className="receipt-notes">{receipt.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
      <p className="receipt-foot">This receipt is the auditable record of the export: the exact source, recipe, engine, and outputs. It is stored as JSON next to the master file.</p>
    </div>
  </div>;
}

function ProcessClips(props: ProcessProps) {
  const [previewSpeed, setPreviewSpeed] = useState(1);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewPosition, setPreviewPosition] = useState(0);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [recipeIndex, setRecipeIndex] = useState(0);
  const [receipt, setReceipt] = useState<RenderReceipt | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [processFilter, setProcessFilter] = useState<'all' | 'ready' | 'exported'>('all');
  const previewVideo = useRef<HTMLVideoElement>(null);
  const clipRef = useRef(props.clip);
  clipRef.current = props.clip;
  const scrubbing = useRef(false);
  const initialSeekKey = useRef('');
  useEffect(() => {
    setRecipeIndex(0);
  }, [props.clip?.id]);
  // Auto-tune: when a clip is first selected, run a brief self-tune pass so the
  // recipe and Source Guidance are already evidence-based before the user touches
  // anything. Guarded so it fires once per clip and never while busy/tuning.
  const autoTunedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!props.clip) return;
    if (autoTunedRef.current.has(props.clip.id)) return;
    autoTunedRef.current.add(props.clip.id);
    if (props.busy || props.tuning) return;
    void props.onTune();
  }, [props.clip?.id, props.busy, props.tuning, props.onTune]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.code !== 'Space' || target.matches('input, select, textarea, button, [contenteditable="true"]')) return;
      event.preventDefault();
      const el = previewVideo.current;
      if (!el) return;
      if (el.paused) { const c = clipRef.current; if (c && (el.currentTime < c.start || el.currentTime >= c.end)) el.currentTime = c.start; void el.play(); } else el.pause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!props.clip || !props.source) return <EmptyPage title="THE QUEUE IS EMPTY" action="FIND MOMENTS FIRST" onAction={props.onFind} />;
  const { clip, source } = props;
  const recipe = clip.recipe;
  const analysis = source.sourceAnalysis;
  const suggested = suggestedRecipePatch(analysis);
  const recipes = suggestedRecipes(analysis);
  const guidanceItems = sourceGuidanceItems(analysis);
  const honestNotes = pixelAdvice(analysis);
  const dimensions = outputDimensions(recipe, source.sourceAnalysis.width, source.sourceAnalysis.height);
  const oriented = orientedSourceDimensions(source.sourceAnalysis.width, source.sourceAnalysis.height, recipe.rotation);
  const sourceAspect = source.sourceAnalysis.width / Math.max(1, source.sourceAnalysis.height);
  const rotated = recipe.rotation === 90 || recipe.rotation === 270;
  const videoStyle = rotated ? { width: `${sourceAspect * 100}%`, height: `${100 / sourceAspect}%`, transform: `rotate(${recipe.rotation}deg)` } : recipe.rotation === 180 ? { transform: 'rotate(180deg)' } : undefined;
  const clipProgress = props.progress?.clipId === clip.id ? props.progress : undefined;
  const previewFrame = 1 / Math.max(1, analysis.fps);
  const unfinishedOtherCount = props.session.clips.filter((item) => item.id !== clip.id && !item.completed).length;
  const elapsed = `${Math.floor(props.exportElapsed / 60)}:${String(props.exportElapsed % 60).padStart(2, '0')}`;
  const slowWarning = dimensions.width >= 3840 && recipe.denoise === 'Fine detail';
  const manual = (patch: Partial<ClipRecipe>) => props.onRecipe({ ...patch, look: 'Custom' });
  const togglePreview = () => {
    if (!previewVideo.current) return;
    if (previewVideo.current.paused) {
      if (previewVideo.current.currentTime < clip.start || previewVideo.current.currentTime >= clip.end) previewVideo.current.currentTime = clip.start;
      void previewVideo.current.play();
    } else previewVideo.current.pause();
  };
  const seekPreview = (value: number) => {
    const next = Math.max(clip.start, Math.min(clip.end, value));
    if (previewVideo.current) previewVideo.current.currentTime = next;
    setPreviewPosition(next);
  };
  const openReceipt = async (path: string) => {
    setReceiptLoading(true);
    try {
      setReceipt(await window.cuttingFloor.readReceipt(path));
    } catch {
      setReceipt(null);
    } finally {
      setReceiptLoading(false);
    }
  };
  const completedCount = props.session.clips.filter((c) => c.completed).length;
  const totalCount = props.session.clips.length;
  return <section className={`process-page ${queueCollapsed ? 'queue-collapsed' : ''}`}>
    <div className="process-header"><h1 className="process-heading">Process clips<span className="accent-dot">.</span></h1><span className="process-clip-label">{clip.name}</span><span className="process-progress-label">{completedCount}/{totalCount} exported</span><button className="primary process-header-export" disabled={props.exporting} onClick={props.onExport}>{props.exporting ? 'Exporting…' : 'Export →'}</button></div>
    <div className="recipe-panel">
      <div className="recipe-title"><div><span className="eyebrow">ACTIVE RECIPE</span></div>{props.exporting ? <div className="process-export-strip" aria-live="polite"><div><b>{clipProgress?.message ?? 'Preparing export'}</b><small>{Math.round(clipProgress?.percent ?? 0)}% · {elapsed} elapsed</small><span><i style={{ width: `${clipProgress?.percent ?? 0}%` }} /></span></div><button className="ghost" onClick={props.onCancel}>Stop safely</button></div> : <div className="reorder"><button aria-label="Move clip earlier" onClick={() => props.onMove(clip.id, -1)}>↑</button><button aria-label="Move clip later" onClick={() => props.onMove(clip.id, 1)}>↓</button><button onClick={() => props.onRemove(clip.id)}>Remove</button></div>}</div>
      <div className="crop-editor">
        <div className="preview-column"><div className="preview-heading"><span className="eyebrow">CLIP PLAYBACK</span><small>{isPreviewPlaying ? 'Playing · loops the marked range' : 'Paused · press Play when ready'}</small></div><div className="crop-preview" title="Drag inside the crop box to move it; drag an edge or corner to resize it." style={{ aspectRatio: `${oriented.width}/${oriented.height}`, maxWidth: `${oriented.width / Math.max(1, oriented.height) * 64}vh` }}>
          <video ref={previewVideo} key={clip.id} style={videoStyle} src={source.fileUrl} poster={source.thumbnailUrl} muted preload="auto" playsInline onPlay={() => setIsPreviewPlaying(true)} onPause={() => setIsPreviewPlaying(false)} onLoadedMetadata={(event) => { event.currentTarget.playbackRate = previewSpeed; }} onCanPlay={(event) => { const key = `${clip.id}:${clip.start}`; if (initialSeekKey.current !== key) { initialSeekKey.current = key; event.currentTarget.pause(); event.currentTarget.currentTime = clip.start; event.currentTarget.playbackRate = previewSpeed; setPreviewPosition(clip.start); setIsPreviewPlaying(false); } }} onTimeUpdate={(event) => { if (scrubbing.current) return; if (event.currentTarget.currentTime >= clip.end) { event.currentTarget.currentTime = clip.start; setPreviewPosition(clip.start); if (!event.currentTarget.paused) void event.currentTarget.play(); } else setPreviewPosition(event.currentTarget.currentTime); }} /><CropMask recipe={recipe} source={source} onChange={props.onRecipe} />
        </div><div className="preview-timeline"><input aria-label="Clip playhead" title="Scrub within the marked clip." type="range" min={clip.start} max={clip.end} step={previewFrame} value={previewPosition} onPointerDown={() => { scrubbing.current = true; }} onPointerUp={() => { scrubbing.current = false; }} onChange={(event) => seekPreview(Number(event.target.value))} /><div><span>{formatTime(previewPosition)}</span><span>{formatTime(clip.end)}</span></div></div><div className="preview-transport"><button className="frame-step" aria-label="Move one frame backward" title="Move one frame backward." onClick={() => seekPreview(previewPosition - previewFrame)}>‹</button><button aria-keyshortcuts="Space" className="primary" onClick={togglePreview}>{isPreviewPlaying ? 'Pause clip' : 'Play clip'} <kbd>Space</kbd></button><button className="frame-step" aria-label="Move one frame forward" title="Move one frame forward." onClick={() => seekPreview(previewPosition + previewFrame)}>›</button><span>{formatTime(clip.start)}–{formatTime(clip.end)} · loops inside the marked range</span><div className="speed">{[1, 2, 3].map((value) => <button title={`${value}× changes playback only.`} key={value} className={previewSpeed === value ? 'active' : ''} onClick={() => { setPreviewSpeed(value); if (previewVideo.current) previewVideo.current.playbackRate = value; }}>{value}×</button>)}</div></div></div>
      </div>
      <div className="recipe-inspector"><fieldset className="recipe-fields" disabled={props.exporting}>
        <div className="crop-controls"><div className="section-head"><h2>COMPOSITION CROP</h2><span>{aspectRatio(recipe) ? 'RATIO LOCKED' : 'FREE CROP'} · {dimensions.width}×{dimensions.height} OUTPUT</span></div>
          <Field label="COMPOSITION RATIO"><select title="The selected ratio remains fixed while crop edges or corners are resized." value={recipe.aspectPreset} onChange={(event) => props.onAspect(event.target.value as ClipRecipe['aspectPreset'])}>{aspectPresets.map((value) => <option key={value}>{value}</option>)}</select></Field>
          {recipe.aspectPreset === 'Custom' && <div className="number-pair"><NumberInput label="RATIO WIDTH" value={recipe.customRatioWidth} onChange={(value) => props.onRecipe({ customRatioWidth: value })} /><NumberInput label="RATIO HEIGHT" value={recipe.customRatioHeight} onChange={(value) => props.onRecipe({ customRatioHeight: value })} /><button className="ghost" onClick={() => props.onAspect('Custom')}>APPLY</button></div>}
          <div className="crop-sliders"><CropField label="LEFT" value={recipe.cropLeft} onChange={(value) => props.onCrop('cropLeft', value)} /><CropField label="RIGHT" value={recipe.cropRight} onChange={(value) => props.onCrop('cropRight', value)} /><CropField label="TOP" value={recipe.cropTop} onChange={(value) => props.onCrop('cropTop', value)} /><CropField label="BOTTOM" value={recipe.cropBottom} onChange={(value) => props.onCrop('cropBottom', value)} /></div>
          <button className="text-button" onClick={() => props.onRecipe({ cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, aspectPreset: 'Free' })}>Reset crop</button>
          <InfoTip>The crop ratio sets the shape; Master Size sets the exported pixels. VapourSynth prepares 4:4:4, performs crop-aware resize, and keeps 16-bit 4:4:4 through cleanup. A blank custom height is derived without stretching.</InfoTip>
        </div>
      {props.tuning && <div className="export-progress active" aria-busy="true" aria-live="polite"><div className="progress-copy"><span>SELF-TUNE PREVIEW · AUTO</span><b>{props.tuneStatus || 'Tuning…'}</b><small>Measuring a short preview each round</small></div></div>}
      <details className="recipe-guidance why-prominent"><summary>✦ Why these settings? — how each recipe choice works</summary><div className="tip-grid"><InfoTip><b>LOOK + DETAIL</b> Start gently; use Crisp only for visibly soft edges and denoise only unwanted noise. Off preserves grain. Balanced is the faster BM3D option; Fine detail adds refinement but may soften texture. Inspect faces, hair, text, and shadows at output size.</InfoTip><InfoTip><b>FILTER STRENGTH</b> These are app-specific BM3D/CAS controls—not KNLM, FineSharp, or Photoshop values. Try denoise 0.5–1.0 first; stronger cleanup can smear detail. Sharpen 0.3–0.6 is subtle; watch for halos as strength rises.</InfoTip><InfoTip><b>CADENCE + MOTION</b> Off preserves progressive footage. Bwdif same-rate keeps the frame rate; double-rate and QTGMC produce more frames from fields. Wrong field order can jitter. Inverse telecine is only for confirmed telecined film—not every 30 fps source. MVTools smoothing creates intermediate frames; check cuts, occlusions, and fast motion for artifacts.</InfoTip><InfoTip><b>RESTORATION + REVIEW</b> Descale attempts to undo a matching earlier upscale; it is not general-purpose detail enhancement. Keep it Off without evidence. Enlarging the master cannot recover lost detail. Playback here is the original framing reference, not a promise of the processed look. Reuse recipes only across comparable sources, then check each crop.</InfoTip></div></details>
      <div className="tune-strip" role="group" aria-label="Self-tune preview">
        <div className="tune-strip-copy"><span>SELF-TUNE PREVIEW</span><b>Already ran automatically — here's what it found</b><small>Runs automatically when you select a clip — it turns on deinterlace / denoise / deband / sharpen only when the rendered pixels need them, then you review. Re-run any time before exporting.</small></div>
        <button className="tune-cta ghost" disabled={props.tuning || props.exporting || props.busy} title="Renders short previews with candidate fixes and re-measures the pixels each round until the preview stops improving. Applies the converged recipe to this clip." onClick={props.onTune}>{props.tuning ? 'Tuning…' : '↻ Re-tune this clip'}</button>
      </div>
      {props.tuneResult && !props.tuning && <div className={`tune-result ${props.tuneResult.fixes.length ? 'applied' : 'clean'}`} role="status">{props.tuneResult.fixes.length ? <>✓ <b>Self-tune applied to this recipe:</b> {props.tuneResult.fixes.join(' · ')} · {props.tuneResult.rounds} round{props.tuneResult.rounds === 1 ? '' : 's'}. Review the Detail &amp; Motion settings below, then export.</> : <><b>Self-tune:</b> the rendered preview measured clean — no fixes applied. You can export as-is.</>}</div>}
      <div className="analysis-guide"><div className="guidance-copy"><span>SOURCE GUIDANCE</span><b>{sourceVerdict(analysis)}</b>{honestNotes.length > 0 && <ul className="honest-notes" aria-label="What the decoded pixels actually show">{honestNotes.map((note) => <li key={note}>{note}</li>)}</ul>}<div className="guidance-signals"><i title="Video codec: how the footage is compressed">{analysis.codec === 'av1' ? 'AV1 (efficient)' : analysis.codec === 'h265' ? 'HEVC / H.265' : analysis.codec === 'h264' ? 'H.264 / AVC' : analysis.codec.toUpperCase()}</i><i title="Color sampling and bit depth">{analysis.pixelFormat === 'yuv420p' ? 'Standard 8-bit color' : analysis.pixelFormat === 'yuv444p' ? 'Full 8-bit color (richer)' : `${analysis.pixelFormat} · ${analysis.bitDepth}-bit`}</i>{analysis.scanEvidence && <i title="How confident the scan is that the footage is progressive or interlaced">{analysis.scanEvidence.classification === 'Progressive' ? '✓ Progressive (normal)' : analysis.scanEvidence.classification === 'Interlaced' ? '⚠ Interlaced detected' : '⚠ Cadence needs review'}</i>}{analysis.hdr !== 'Unknown' && <i title="Color space">{analysis.hdr === 'SDR' ? '✓ Standard color' : analysis.hdr}</i>}<i title="Frame timing">{analysis.frameTiming?.kind ?? 'Timing not checked'}</i>{Boolean(analysis.bitrate) && <i title="Container-level bitrate">{Math.round(analysis.bitrate / 1000)} kbps</i>}</div><details open><summary>⚙ Tune the recipe</summary><div className="checklist-guide"><p><b>Self-tune ran automatically</b> and wrote evidence-based fixes into this recipe. Play the clip (Space) and adjust any setting that doesn't look right:</p><ul>{guidanceItems.map((item) => <li key={`check-${item.title}`}><b>{item.title}</b> — {item.check}</li>)}</ul><small>Every setting below (Motion, Detail, Output, Finishing) has a hover explanation. Start with what self-tune applied, then fine-tune by eye.</small></div></details><details className="evidence-span"><summary>📊 Video stats</summary><div className="guidance-cards">{guidanceItems.map((item) => <article key={`${item.title}-${item.evidence}`}><header><b>{item.title}</b><i className={`confidence-${item.confidence.toLowerCase()}`}>{item.confidence}</i></header><p>{item.recommendation}</p></article>)}</div></details><small>Self-tune ran automatically on selecting this clip. It only enables what the rendered pixels need — deinterlace, denoise, deband, or sharpen — and leaves everything else untouched.</small></div><div className="analysis-actions">{recipes.length > 1 && (<div className="recipe-alternatives"><label className="recipe-alternatives-label"><span>RECIPE ALTERNATIVES</span><select value={Math.min(recipeIndex, recipes.length - 1)} onChange={(event) => setRecipeIndex(Number(event.target.value))}>{recipes.map((alt, index) => <option key={alt.name} value={index}>{alt.name} · {alt.confidence}</option>)}</select></label><p className="recipe-alternatives-why">{recipes[Math.min(recipeIndex, recipes.length - 1)]?.why ?? ''}</p><button className="ghost" onClick={() => { const alt = recipes[Math.min(recipeIndex, recipes.length - 1)]; if (alt) props.onRecipe(alt.patch); }}>Apply selected</button></div>)}<button className="ghost" disabled={!unfinishedOtherCount} onClick={props.onApplyRecipeToOtherClips}>Apply to {unfinishedOtherCount} unfinished clip{unfinishedOtherCount === 1 ? '' : 's'}</button></div></div>
      <div className="recipe-settings-grid">
        <details className="recipe-section" open><summary className="recipe-section-head"><div><span>MOTION</span><h3>Cadence and playback</h3></div><p>Preserve original motion unless the source visibly needs intervention.</p></summary><div className="recipe-section-fields two-column">
          <Field label="DEINTERLACE / CADENCE"><select title="How the source was scanned. “Off” for normal progressive footage. Bwdif/QTGMC for interlaced (TV-style) sources that show tearing or ghosting on moving edges." value={recipe.deinterlace} onChange={(event) => props.onRecipe({ deinterlace: event.target.value as ClipRecipe['deinterlace'] })}>{deinterlaceChoices.map((value) => <option key={value} value={value}>{value === 'Bwdif' ? 'Bwdif · same-rate' : value === 'Bwdif 2×' ? 'Bwdif · double-rate' : value === 'QTGMC Quality' ? 'QTGMC · maximum quality' : value}</option>)}</select></Field>
          <Field label="MOTION"><select title="Output frame rate. “Original” keeps the source rate. 30/60 fps upsamples for smoother motion on high-refresh displays." value={recipe.motion} onChange={(event) => props.onRecipe({ motion: event.target.value as ClipRecipe['motion'] })}>{['Original', '30 fps', '60 fps'].map((value) => <option key={value}>{value}</option>)}</select></Field>
          {props.expertMode && <Field label="FIELD ORDER"><select title="Which field comes first in interlaced footage. “Auto” guesses from the container. Wrong order causes jitter on moving edges." value={recipe.fieldOrder} onChange={(event) => props.onRecipe({ fieldOrder: event.target.value as ClipRecipe['fieldOrder'] })}>{['Auto', 'Top first', 'Bottom first'].map((value) => <option key={value}>{value}</option>)}</select></Field>}
          {props.expertMode && <Field label="ROTATION"><select title="Rotates the output. Only needed if the source is stored sideways (common with phone footage)." value={recipe.rotation} onChange={(event) => props.onRecipe({ rotation: Number(event.target.value) as ClipRecipe['rotation'] })}>{[0, 90, 180, 270].map((value) => <option key={value} value={value}>{value}°</option>)}</select></Field>}
        </div></details>
        <details className="recipe-section" open><summary className="recipe-section-head"><div><span>DETAIL</span><h3>Clean and sharpen</h3></div><p>Start with a look, then adjust only what the shot needs.</p></summary><div className="recipe-section-fields two-column">
          <Field label="STARTING LOOK"><select title="A preset bundle of denoise + sharpen + deband settings. “Preserve” is the most faithful; “Crisp” adds sharpening; “Soft / noisy” adds cleanup." value={recipe.look} onChange={(event) => props.onLook(event.target.value as StudioLook)}>{looks.map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="RESTORATION"><select title="Debilinear/Debicubic attempts to reverse a prior bilinear/bicubic upscale (e.g. 480p stretched to 1080p). Keep Off unless you know the source was upscaled." value={recipe.restoration} onChange={(event) => manual({ restoration: event.target.value as ClipRecipe['restoration'] })}>{['Off', 'Debilinear', 'Debicubic'].map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label="DENOISE METHOD"><select title="“Off” preserves original grain. “Balanced” is fast BM3D. “Fine detail” is slower but better at preserving texture while removing noise." value={recipe.denoise} onChange={(event) => manual({ denoise: event.target.value as ClipRecipe['denoise'] })}>{['Off', 'Balanced', 'Fine detail'].map((value) => <option key={value}>{value}</option>)}</select></Field>
          <Field label={`DENOISE STRENGTH · ${recipe.denoiseStrength.toFixed(2)}`}><input title="0 = off. 0.5–1.0 = gentle cleanup. 1.2–2.0 = targets visible noise. Above 2 can smear fine detail." type="range" min="0" max="3" step="0.05" value={recipe.denoiseStrength} onChange={(event) => manual({ denoiseStrength: Number(event.target.value) })} /></Field>
          <Field label="SHARPEN METHOD"><select title="“Off” = no sharpening. “Natural lines” is a gentle unsharp mask. “Adaptive crisp” is stronger and better on edges but can halos on difficult footage." value={recipe.sharpen} onChange={(event) => manual({ sharpen: event.target.value as ClipRecipe['sharpen'] })}>{['Off', 'Natural', 'Adaptive'].map((value) => <option key={value}>{value === 'Natural' ? 'Natural lines' : value === 'Adaptive' ? 'Adaptive crisp' : value}</option>)}</select></Field>
          <Field label={`SHARPEN STRENGTH · ${recipe.sharpenStrength.toFixed(2)}`}><input title="0.3–0.6 = subtle. 0.7–1.0 = visibly crisp, may show halos. Watch faces and fine textures." type="range" min="0" max="1" step="0.05" value={recipe.sharpenStrength} onChange={(event) => manual({ sharpenStrength: Number(event.target.value) })} /></Field>
        </div></details>
        <details className="recipe-section" open><summary className="recipe-section-head"><div><span>OUTPUT</span><h3>Master file</h3></div><p>Choose the delivered format and actual exported pixel size.</p></summary><div className="recipe-section-fields">
          <Field label="OUTPUT FORMAT"><select title="MP4 (H.264) = compact, great for web/screens. ProRes 422 HQ = Photoshop-editable master. ProRes 4444 = maximum quality, very large files." value={recipe.outputFormat} onChange={(event) => props.onRecipe({ outputFormat: event.target.value as ClipRecipe['outputFormat'] })}>{outputFormats.map((value) => <option key={value} value={value}>{value === 'MP4' ? 'High-quality MP4 · H.264 CRF 12' : value === 'ProRes 422' ? 'Photoshop MOV · ProRes 422 HQ' : 'Photoshop MOV · ProRes 4444'}</option>)}</select></Field>
          <Field label="MASTER SIZE"><select title="The actual pixel dimensions of the exported file. “Source” = same as the clip. 4K/2K = upscaled (no detail recovered, just larger canvas)." value={recipe.masterSize} onChange={(event) => props.onRecipe({ masterSize: event.target.value as ClipRecipe['masterSize'] })}>{masterSizes.map((value) => <option key={value}>{value}</option>)}</select></Field>
          {recipe.masterSize === 'Custom' && <Field label="CUSTOM MASTER"><div className="number-pair"><NumberInput label="WIDTH" value={recipe.masterWidth} onChange={(value) => props.onRecipe({ masterWidth: value })} /><NumberInput label="HEIGHT · OPTIONAL" value={recipe.masterHeight ?? ''} onChange={(value) => props.onRecipe({ masterHeight: value || undefined })} /></div></Field>}
        </div></details>
        <details className="recipe-section" open><summary className="recipe-section-head"><div><span>FINISHING</span><h3>Color and extras</h3></div><p>Optional finishing operations and inspectable pipeline output.</p></summary><div className="recipe-section-fields two-column">
          {props.expertMode && <Field label="COLOR MANAGEMENT"><select title="“Auto” handles HDR-to-SDR and Rec.601-to-709 automatically. “Preserve” keeps the source color space as-is. Only change if the output looks wrong." value={recipe.colorManagement} onChange={(event) => props.onRecipe({ colorManagement: event.target.value as ClipRecipe['colorManagement'] })}>{['Auto', 'SDR Rec.709', 'Convert 601 to 709', 'HDR PQ to SDR', 'HDR HLG to SDR', 'Preserve'].map((value) => <option key={value}>{value}</option>)}</select></Field>}
          {props.expertMode && <Field label="ENGINE POLICY"><select title="Strict = only VapourSynth (full quality). Allow FFmpeg = falls back if VapourSynth fails (slightly different output)." onChange={(event) => props.onRecipe({ fallbackMode: event.target.value as ClipRecipe['fallbackMode'] })}><option>Strict VapourSynth</option><option>Allow FFmpeg fallback</option></select></Field>}
        </div><div className="toggle-row">{([['deband', 'DEBAND GRADIENTS', 'Adds gentle dithering to smooth out banding (visible steps) in gradients like skies and shadows.'], ['reverse', 'REVERSE VIDEO + AUDIO', 'Plays the clip backwards, video and audio together.'], ['fade', 'SHORT FADE', 'Adds a brief fade-in at the start and fade-out at the end.'], ['extractFrames', 'EXTRACT PROCESSED PNGS', 'Saves individual PNG frames from the processed export, useful for frame-by-frame inspection.'], ['saveVapourSynthScript', 'SAVE .VPY', 'Saves the VapourSynth script that was used, so the exact pipeline can be reproduced or edited manually.']] as const).map(([key, label, tip]) => <label key={key} title={tip}><input type="checkbox" checked={recipe[key]} onChange={(event) => key === 'deband' ? manual({ deband: event.target.checked }) : props.onRecipe({ [key]: event.target.checked })} />{label}</label>)}</div>
          {recipe.extractFrames && <div className="frame-options"><Field label="PNG EXTRACTION"><select value={recipe.frameExtraction} onChange={(event) => props.onRecipe({ frameExtraction: event.target.value as ClipRecipe['frameExtraction'] })}><option>Every processed frame</option><option>Custom frame rate</option></select></Field>{recipe.frameExtraction === 'Custom frame rate' && <NumberInput label="PNG FPS" value={recipe.frameFps} onChange={(value) => props.onRecipe({ frameFps: Math.max(0.01, value) })} />}</div>}
        </details>
      </div>
      <div className="pipeline-card"><span>VAPOURSYNTH PRIMARY PIPELINE</span><code>BestSource → cadence → trim → crop → restore → BM3D → CAS → MVTools → output</code></div>
      <details className="recipe-guidance"><summary>Engine and output details</summary><div className="tip-grid"><InfoTip><b>ENGINE + COLOR</b> Strict mode stops on VapourSynth failure; Compatibility creates a clearly labeled substitute. Auto maps HDR PQ/HLG and SD Rec.601 to SDR Rec.709, with a conservative Rec.709 fallback for untagged video.</InfoTip><InfoTip><b>OUTPUTS</b> ProRes 422 HQ is the practical Photoshop master, 4444 keeps maximum chroma at much larger size, and MP4 is compact 4:2:0. PNGs come from the processed export; saved .vpy files record the actual recipe.</InfoTip></div></details>
      {clip.processingEngine === 'FFmpeg compatibility' && <div className="compatibility-note"><b>COMPATIBILITY EXPORT</b>{clip.fallbackReason}</div>}
      {clip.outputWarnings?.map((warning) => <div className="compatibility-note" key={warning}><b>OUTPUT NOTE</b>{warning}</div>)}
      {slowWarning && <div className="compatibility-note"><b>LONG EXPORT EXPECTED</b>4K with Fine detail BM3D can be substantially slower. Phase and elapsed time below will continue updating.</div>}
      </fieldset>
      <div className="export-location"><div title={`${props.exportRoot}\\${props.session.name}`}><span>EXPORT LOCATION</span><b>{props.exportRoot}\{props.session.name}</b></div><button title="Choose a destination for this export only. The Settings default will not change." className="ghost" disabled={props.exporting} onClick={props.onChooseExportFolder}>Choose folder</button></div>
      {(clipProgress || props.exporting) && <div className={`export-progress ${props.exporting ? 'active' : ''}`} aria-busy={props.exporting} aria-live="polite"><div className="progress-copy"><span>EXPORT PROGRESS</span><b>{clipProgress?.message ?? 'Preparing export'}</b><small>{props.exporting ? `Active · ${elapsed} elapsed` : clipProgress?.percent === 100 ? `Completed in ${elapsed}` : 'Stopped'}</small></div><strong>{Math.round(clipProgress?.percent ?? 0)}%</strong><div className="progress-track" role="progressbar" aria-label="Clip export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clipProgress?.percent ?? 0)}><i style={{ width: `${clipProgress?.percent ?? 0}%` }} /></div></div>}
      <div className="export-row"><div><span className={`status-dot ${props.exporting ? 'working' : ''}`} />{props.status}</div>{props.exporting && <button className="ghost" onClick={props.onCancel}>Stop safely</button>}{clip.completed && clip.receiptPath && <button className="ghost" disabled={receiptLoading} title="Open the render receipt — the auditable record of this export." onClick={() => openReceipt(clip.receiptPath as string)}>{receiptLoading ? 'Loading…' : 'Receipt'}</button>}<button className="primary" disabled={props.exporting} onClick={props.onExport}>{props.exporting ? 'Exporting…' : 'Export clip →'}</button></div>
      </div>
    </div>
    <aside className={`process-list ${queueCollapsed ? 'collapsed' : ''}`}><button className="process-queue-head" title={queueCollapsed ? 'Show project clips' : 'Hide project clips'} onClick={() => setQueueCollapsed((value) => !value)}><span><b>PROJECT CLIPS</b><small>{props.session.clips.length} clips · {completedCount} exported</small></span><i>{queueCollapsed ? '‹' : '›'}</i></button>{!queueCollapsed && <><div className="process-filter-tabs" role="tablist">{(['all', 'ready', 'exported'] as const).map((tab) => <button key={tab} role="tab" aria-selected={processFilter === tab} onClick={() => setProcessFilter(tab)}>{tab === 'all' ? `All (${totalCount})` : tab === 'ready' ? `Ready (${totalCount - completedCount})` : `Exported (${completedCount})`}</button>)}</div>
      <div className="process-clip-list">{props.session.clips.filter((item) => processFilter === 'all' || (processFilter === 'ready' ? !item.completed : item.completed)).map((item, index) => { const src = props.session.sources.find((s) => s.id === item.sourceId); return <button disabled={props.exporting} key={item.id} className={`process-clip-item ${item.id === clip.id ? 'active' : ''} ${item.completed ? 'complete' : ''}`} onClick={() => props.onSelect(item.id)}>{src?.thumbnailUrl ? <img src={src.thumbnailUrl} alt="" /> : <span className="clip-thumb-empty">▶</span>}<div><b>{item.name}</b><small>{formatTime(item.start)} — {formatTime(item.end)}</small><small className="clip-status">{item.completed ? '✓ EXPORTED' : 'READY'}</small></div></button>; })}</div>
      {completedCount > 0 && <button className="process-reset-all ghost" title="Return every exported clip to Ready without deleting exports from disk." disabled={props.exporting} onClick={props.onResetAll}>Reset all to ready</button>}
      </>}</aside>
    {receipt && <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
  </section>;
}

function Settings({ session, preferences, runtime, saveState, onSession, onWorkspace, onPreferences, onError, onNotice, onShowWelcome }: { session: StudioSession; preferences: StudioPreferences; runtime: RuntimeStatus; saveState: SaveState; onSession(session: StudioSession): void; onWorkspace(workspace: Awaited<ReturnType<typeof window.cuttingFloor.loadWorkspace>>): void; onPreferences(preferences: StudioPreferences): Promise<void>; onError(error: unknown): void; onNotice(message: string): void; onShowWelcome(): void }) {
  const choose = async (kind: 'libraryPath' | 'downloadPath' | 'exportPath') => {
    try {
      const folder = await window.cuttingFloor.chooseLocation(kind, preferences[kind]);
      if (!folder) return;
      if (kind === 'libraryPath') {
        const workspace = await window.cuttingFloor.changeLibrary(session, folder);
        if (workspace) onWorkspace(workspace);
      } else await onPreferences({ ...preferences, [kind]: folder });
    } catch (error) { onError(error); }
  };
  const copyDiagnostics = async () => {
    try { await navigator.clipboard.writeText(runtime.error ?? JSON.stringify(runtime, null, 2)); onNotice('Pipeline diagnostics copied to the clipboard.'); }
    catch (error) { onError(error); }
  };
  const tools: Array<[string, boolean, string | undefined]> = [
    ['FFmpeg', runtime.ffmpeg, runtime.versions?.ffmpeg],
    ['FFprobe', runtime.ffprobe, runtime.versions?.ffprobe],
    ['VSPipe', runtime.vspipe, runtime.versions?.vapourSynth],
    ['yt-dlp', runtime.ytDlp, runtime.versions?.ytDlp],
    ['VapourSynth plugins', runtime.vapourSynthPlugins, runtime.versions?.vapourSynth ? `core ${runtime.versions.vapourSynth}` : undefined],
  ];
  const [settingsTab, setSettingsTab] = useState<'general' | 'appearance' | 'folders' | 'about'>('general');
  const [toolUpdates, setToolUpdates] = useState<ToolVersionInfo[] | null>(null);
  const [toolChecking, setToolChecking] = useState(false);
  const [toolUpdating, setToolUpdating] = useState<string | null>(null);
  const checkTools = async () => {
    setToolChecking(true);
    try { setToolUpdates(await window.cuttingFloor.checkToolUpdates()); }
    catch (error) { onError(error); }
    finally { setToolChecking(false); }
  };
  const updateTool = async (name: string) => {
    setToolUpdating(name);
    try {
      const result = await window.cuttingFloor.updateTool(name);
      onNotice(result.message);
      if (result.ok) await checkTools();
    } catch (error) { onError(error); }
    finally { setToolUpdating(null); }
  };
  const previewSource = session.sources.find((s) => s.thumbnailUrl);
  return <section className="page settings-page">
    <header className="settings-head"><div><span className="eyebrow">(04 / SETTINGS)</span><h1>Your workspace<span className="accent-dot">.</span><span className="accent-star">*</span></h1></div></header>
    <div className="settings-layout">
      <nav className="settings-nav" role="tablist" aria-label="Settings sections">{([['general', 'General'], ['appearance', 'Appearance'], ['folders', 'Folders'], ['about', 'About']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={settingsTab === key} className={settingsTab === key ? 'active' : ''} onClick={() => setSettingsTab(key as typeof settingsTab)}>{label}</button>)}</nav>
      <div className="settings-main">
        {settingsTab === 'appearance' && <><h2 className="settings-section-title">Appearance</h2>
          <div className="settings-row"><span className="settings-label">Theme</span><div className="theme-toggle" role="group" aria-label="Theme"><button aria-pressed={preferences.theme === 'dark'} className={preferences.theme !== 'light' ? 'active' : ''} onClick={() => void onPreferences({ ...preferences, theme: 'dark' })}>Dark</button><button aria-pressed={preferences.theme === 'light'} className={preferences.theme === 'light' ? 'active' : ''} onClick={() => void onPreferences({ ...preferences, theme: 'light' })}>Light</button></div><span className="settings-desc">Choose the overall interface theme.</span></div>
          <div className="settings-row"><span className="settings-label">Palette</span><select value={preferences.palette ?? 'default'} onChange={(event) => void onPreferences({ ...preferences, palette: event.target.value as StudioPreferences['palette'] })}><option value="default">Default (A24 Red)</option><option value="notflix">Notflix</option><option value="wholou">Wholou</option><option value="disnee-plus">Disnee Plus</option></select><span className="settings-desc">Accent color palette inspired by your favorite streaming service.</span></div>
          <div className="settings-row"><span className="settings-label">Expert mode</span><label className="toggle-switch"><input type="checkbox" checked={preferences.expertMode} onChange={(event) => void onPreferences({ ...preferences, expertMode: event.target.checked })} /><span className="toggle-track" /></label><span className="settings-desc">Show field order, rotation, color management, and compatibility controls.</span></div>
          <button className="ghost show-welcome" onClick={onShowWelcome}>Show welcome guide</button>
        </>}
        {settingsTab === 'general' && <><h2 className="settings-section-title">General</h2>
          <div className="settings-row"><span className="settings-label">Project name</span><div className="location-row"><input value={session.name} maxLength={100} onChange={(event) => onSession({ ...session, name: event.target.value })} /></div></div>
          <div className="settings-row"><span className="settings-label">Watched folders</span><span className="settings-desc">{session.watchFolders.length ? session.watchFolders.join(', ') : 'None configured for this project.'}</span></div>
        </>}
        {settingsTab === 'folders' && <><h2 className="settings-section-title">Project locations</h2>
          <div className="settings-row"><span className="settings-label">Project library</span><span className="settings-desc">Main project data, timelines and metadata.</span><div className="location-row"><input readOnly title={preferences.libraryPath} value={preferences.libraryPath} /><button className="ghost" onClick={() => choose('libraryPath')}>Browse &rarr;</button></div></div>
          <div className="settings-row"><span className="settings-label">Source masters</span><span className="settings-desc">Original video files (read-only).</span><div className="location-row"><input readOnly title={preferences.downloadPath} value={preferences.downloadPath} /><button className="ghost" onClick={() => choose('downloadPath')}>Browse &rarr;</button></div></div>
          <div className="settings-row"><span className="settings-label">Finished clips + frames</span><span className="settings-desc">Exported clips, GIFs, and extracted frames.</span><div className="location-row"><input readOnly title={preferences.exportPath} value={preferences.exportPath} /><button className="ghost" onClick={() => choose('exportPath')}>Browse &rarr;</button></div></div>
        </>}
        {settingsTab === 'about' && <><h2 className="settings-section-title">About Vapormint</h2>
          <p className="settings-about-text">Version 2.2.4 &middot; Local video processing with VapourSynth and FFmpeg.</p>
          <button className="ghost" onClick={() => void window.cuttingFloor.checkForUpdates()}>Check for updates</button>
          <div className="settings-runtime">{tools.map(([name, ok, version]) => { const updatable = name === 'yt-dlp' && toolUpdates?.find((t) => t.name === 'yt-dlp')?.updateAvailable; return <div key={name}><i className={ok ? 'ok' : 'missing'} /><span>{name}</span>{version && ok ? <em className="tool-version" title={version}>{version}</em> : null}<b>{ok ? 'READY' : 'MISSING'}</b>{updatable && <button className="ghost tool-update-btn" disabled={!!toolUpdating} onClick={() => void updateTool('yt-dlp')}>{toolUpdating === 'yt-dlp' ? 'Updating…' : 'Update'}</button>}</div>; })}</div>
          <button className="ghost" disabled={toolChecking} onClick={() => void checkTools()}>{toolChecking ? 'Checking…' : 'Check for tool updates'}</button>
          {toolUpdates && !toolUpdates.some((t) => t.updateAvailable) && <small style={{ color: 'var(--muted)', marginLeft: 8 }}>All tools up to date.</small>}
          {runtime.error && <div className="runtime-error" role="alert"><b>Pipeline check details</b><p>{runtime.error}</p><button className="ghost" onClick={() => void copyDiagnostics()}>Copy diagnostics</button></div>}
        </>}
      </div>
      <aside className="settings-sidebar">
        <div className="settings-preview">{previewSource?.thumbnailUrl ? <img src={previewSource.thumbnailUrl} alt="" /> : <span style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--line-strong)' }}>No preview</span>}</div>
        <div className="settings-local-badge">( LOCAL BY DESIGN )</div>
        <div className="settings-pipeline"><h4>Pipeline status</h4><span>{tools.every(([, ok]) => ok) ? 'All tools ready' : 'Some tools missing'}</span><div className="settings-runtime">{tools.map(([name, ok]) => <div key={name}><span>{name}</span><b>{ok ? 'Ready' : 'Missing'}</b></div>)}</div></div>
      </aside>
    </div>
    <footer className="settings-footer"><div className="settings-footer-links"><button onClick={() => onNotice('Vapormint processes everything locally. No video data leaves your machine.')}>Privacy</button><button onClick={() => onNotice('Vapormint is provided as-is for personal use. No warranty expressed or implied.')}>Terms</button><button onClick={() => onNotice('Vapormint uses FFmpeg (LGPL), VapourSynth (LGPL), yt-dlp (Unlicense), Electron (MIT), React (MIT).')}>Licenses</button></div><span>Vapormint 2.2.4</span></footer>
  </section>;
}

function CropField({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return <label><span>{label} · {Math.round(value * 100)}%</span><input type="range" min="0" max="0.8" step="0.001" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function CropMask({ recipe, source, onChange }: { recipe: ClipRecipe; source: StudioSource; onChange(recipe: ClipRecipe): void }) {
  const drag = useRef<{ x: number; y: number; recipe: ClipRecipe } | undefined>(undefined);
  const oriented = orientedSourceDimensions(source.sourceAnalysis.width, source.sourceAnalysis.height, recipe.rotation);
  const move = (event: React.PointerEvent<HTMLButtonElement>, edges: Array<'cropLeft' | 'cropRight' | 'cropTop' | 'cropBottom'>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.closest('.crop-preview')!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    let next = recipe;
    for (const edge of edges) next = setCropEdge(next, edge, edge === 'cropLeft' ? x : edge === 'cropRight' ? 1 - x : edge === 'cropTop' ? y : 1 - y, oriented.width, oriented.height);
    onChange(next);
  };
  const handles: Array<[string, Array<'cropLeft' | 'cropRight' | 'cropTop' | 'cropBottom'>]> = [
    ['nw', ['cropLeft', 'cropTop']], ['n', ['cropTop']], ['ne', ['cropRight', 'cropTop']],
    ['e', ['cropRight']], ['se', ['cropRight', 'cropBottom']], ['s', ['cropBottom']],
    ['sw', ['cropLeft', 'cropBottom']], ['w', ['cropLeft']],
  ];
  return <div className="crop-mask" style={{ left: `${recipe.cropLeft * 100}%`, right: `${recipe.cropRight * 100}%`, top: `${recipe.cropTop * 100}%`, bottom: `${recipe.cropBottom * 100}%` }}>
    <button title="Drag inside the crop box to move it." className="crop-drag" aria-label="Move crop" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, recipe }; }} onPointerMove={(event) => { if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = event.currentTarget.closest('.crop-preview')!.getBoundingClientRect(); onChange(moveCrop(drag.current.recipe, (event.clientX - drag.current.x) / bounds.width, (event.clientY - drag.current.y) / bounds.height)); }} />
    {handles.map(([position, edges]) => <button title="Drag to resize; the selected composition ratio stays locked." key={position} aria-label={`Resize crop ${position}`} className={`crop-handle ${position}`} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={(event) => move(event, edges)} />)}
  </div>;
}

function NumberInput({ label, value, onChange }: { label: string; value: number | ''; onChange(value: number): void }) {
  return <label className="number-input"><span>{label}</span><input type="number" min="1" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Field({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function InfoTip({ children }: React.PropsWithChildren) {
  return <p className="info-tip"><span aria-hidden="true">ⓘ</span>{children}</p>;
}

function EmptyPage({ title, action, onAction }: { title: string; action: string; onAction?(): void }) {
  return <section className="empty-page"><div className="empty-symbol">◇</div><h1>{title}</h1><p>Import a source and mark the moments you want to keep.</p>{onAction && <button className="primary" onClick={onAction}>{action}</button>}</section>;
}
