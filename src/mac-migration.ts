import { createHash } from 'node:crypto';
import { defaultRecipe, type ClipRecipe, type StudioSession, type StudioSource } from './shared.ts';

// The native Swift app used different property names and human-readable recipe labels.
// Keep the original session next to the converted copy for recovery and future remapping.
export function convertNativeSession(raw: any, originalPath: string): StudioSession {
  if (!raw || !Array.isArray(raw.sources) || !Array.isArray(raw.clips)) throw new Error('Invalid native Cutting Floor session');
  const num = (x: unknown, fallback: number) => x !== '' && Number.isFinite(Number(x)) ? Number(x) : fallback;
  const id = createHash('sha256').update(originalPath).digest('hex').slice(0,32);
  const date = typeof raw.created === 'string' ? raw.created : typeof raw.created === 'number' && Number.isFinite(raw.created) ? new Date((raw.created + 978307200) * 1000).toISOString() : new Date(0).toISOString();
  const sources: StudioSource[] = raw.sources.map((s: any, i: number) => {
    const a = s.sourceAnalysis ?? {};
    return { ...s, id: s.id ?? `${id}-${i}`, fileUrl: '', displayName: s.displayName ?? s.episodeLabel ?? 'Source', episodeLabel: s.episodeLabel ?? s.displayName ?? 'Source', progress: num(s.progress,0), finished: !!s.finished, missing: false, sourceAnalysis: { ...a, duration:num(a.duration,0), width:num(a.width,0), height:num(a.height,0), fps:num(a.fps,24), codec:a.codec ?? 'unknown', format:a.format ?? 'unknown', pixelFormat:a.pixelFormat ?? 'unknown', bitDepth:num(a.bitDepth,8), bitrate:num(a.bitrate, num(a.bitrateMbps,0)*1000000), colorSpace:a.colorSpace ?? 'unknown', colorTransfer:a.colorTransfer ?? 'unknown', hdr:'Unknown', scanType: ['Progressive','Interlaced'].includes(a.scanType) ? a.scanType : 'Unknown', fieldOrder:'unknown', variableFrameRate: /variable/i.test(a.frameRateMode ?? ''), qualitySummary:a.qualitySummary ?? '' } };
  });
  const clips = raw.clips.map((c: any, i: number) => {
    const r = c.recipe ?? {}; const base = defaultRecipe();
    const aspect = String(r.aspectPreset ?? '');
    const aspectPreset = aspect.includes('540×304') ? 'One-column landscape · 540×304' : aspect.includes('540×810') ? 'One-column tall portrait · 540×810' : aspect.includes('268×151') ? 'Two-column landscape · 268×151' : /custom|540×400/i.test(aspect) ? 'Custom' : 'Free';
    const denoiseStrength=num(r.denoise,0); const sharpenStrength=num(r.sharpen,0);
    const recipe: ClipRecipe = { ...base, cropTop:num(r.cropTop,0), cropBottom:num(r.cropBottom,0), cropLeft:num(r.cropLeft,0), cropRight:num(r.cropRight,0), aspectPreset, customRatioWidth:num(r.customRatioWidth,540), customRatioHeight:num(r.customRatioHeight,400), masterSize:/custom/i.test(r.masterSize ?? '') ? 'Custom' : 'Source', masterWidth:num(r.masterWidth,1920), masterHeight:num(r.masterHeight,0) || undefined, look:['Natural','Crisp','Soft / noisy source'].includes(r.look) ? r.look : 'Custom', deinterlace:/bwdif/i.test(r.deinterlace ?? '') ? (/2|double|bob/i.test(r.deinterlace) ? 'Bwdif 2×' : 'Bwdif') : /qtgmc/i.test(r.deinterlace ?? '') ? 'QTGMC Quality' : /telecine/i.test(r.deinterlace ?? '') ? 'Inverse Telecine' : 'Off', fieldOrder:/top/i.test(r.fieldOrder ?? '') ? 'Top first' : /bottom/i.test(r.fieldOrder ?? '') ? 'Bottom first' : 'Auto', restoration:/debicubic/i.test(r.restoration ?? '') ? 'Debicubic' : /debilinear/i.test(r.restoration ?? '') ? 'Debilinear' : 'Off', rotation:[0,90,180,270].includes(num(r.sourceRotationDegrees,0)) ? num(r.sourceRotationDegrees,0) as 0|90|180|270 : 0, motion:/60/.test(r.motion ?? '') ? '60 fps' : /30/.test(r.motion ?? '') ? '30 fps' : 'Original', denoise:denoiseStrength > 0 ? (/fine/i.test(r.denoiseMethod ?? '') ? 'Fine detail' : 'Balanced') : 'Off', denoiseStrength, sharpen:sharpenStrength > 0 ? (/adaptive/i.test(r.sharpenMethod ?? '') ? 'Adaptive' : 'Natural') : 'Off', sharpenStrength, deband:!!r.deband, reverse:!!r.reverse, fade:!!r.fade, extractFrames:!!r.extractFrames, frameExtraction:/custom/i.test(r.frameExtraction ?? '') ? 'Custom frame rate' : 'Every processed frame', frameFps:num(r.frameFPS,30), outputFormat:/4444/.test(r.outputFormat ?? '') ? 'ProRes 4444' : /mp4/i.test(r.outputFormat ?? '') ? 'MP4' : 'ProRes 422', saveVapourSynthScript:!!r.saveVapourSynthScript, fallbackMode:/allow|fallback/i.test(r.fallbackPolicy ?? '') && !/strict/i.test(r.fallbackPolicy ?? '') ? 'Allow FFmpeg fallback' : 'Strict VapourSynth', colorManagement:/preserve/i.test(r.colorManagement ?? '') ? 'Preserve' : /601/i.test(r.colorManagement ?? '') ? 'Convert 601 to 709' : /PQ/i.test(r.colorManagement ?? '') ? 'HDR PQ to SDR' : /HLG/i.test(r.colorManagement ?? '') ? 'HDR HLG to SDR' : 'Auto' };
    return { ...c, preserveImportedRecipe:true, id:c.id ?? `${id}-clip-${i}`, sourceId:c.sourceID ?? c.sourceId ?? sources[0]?.id, name:c.name ?? `Clip ${i+1}`, start:num(c.start,0), end:num(c.end,0), completed:!!c.completed, recipe };
  });
  return { version:6, id, name:raw.name ?? 'Imported project', created:date, updated:date, sources, clips, activeSourceId:raw.activeSourceID ?? raw.activeSourceId ?? sources[0]?.id, watchFolders:raw.watchFolderPath ? [raw.watchFolderPath] : [] };
}

import { readdir, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export async function importMacProjects(roots: string[], destination: string): Promise<{ imported: number; errors: string[] }> {
  const files = new Set<string>(); const errors: string[] = [];
  async function scan(dir: string, depth: number): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes:true }); }
    catch (error: any) { if (error.code !== 'ENOENT') errors.push(`${dir}: ${error.message}`); return; }
    if (path.basename(dir) === 'Sessions') {
      for (const entry of entries) if (entry.isDirectory()) files.add(path.join(dir, entry.name, 'session.json'));
      return;
    }
    if (depth > 0) for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await scan(path.join(dir,entry.name),depth-1);
  }
  for (const root of new Set(roots)) await scan(root,3);
  let imported = 0;
  await mkdir(destination,{recursive:true});
  const ledgerPath = path.join(destination,'.cutting-floor-migration.json');
  let completed: string[] = [];
  try { const parsed = JSON.parse(await readFile(ledgerPath,'utf8')); if (Array.isArray(parsed)) completed = parsed.filter((x: unknown) => typeof x === 'string'); } catch { /* First import. */ }
  for (const file of files) {
    try {
      const original = await readFile(file,'utf8');
      const converted = convertNativeSession(JSON.parse(original),file);
      if (completed.includes(converted.id)) continue;
      const folder = path.join(destination,converted.id);
      const sessionPath = path.join(folder,'session.json');
      try { await access(sessionPath); completed.push(converted.id); continue; } catch { /* This project has not been imported yet. */ }
      const thumbnail = path.join(path.dirname(file),'project-thumbnail.jpg');
      try { await access(thumbnail); if (converted.sources[0]) converted.sources[0].thumbnailPath = thumbnail; } catch { /* No legacy thumbnail. */ }
      await mkdir(folder,{recursive:true});
      // Keep the complete original data in the destination; never alter the original library.
      await writeFile(path.join(folder,'legacy-native-session.json'),original,{flag:'wx'}).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
      await writeFile(sessionPath,JSON.stringify(converted,null,2),{flag:'wx'});
      completed.push(converted.id);
      await writeFile(ledgerPath,JSON.stringify(completed,null,2));
      imported++;
    } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'EEXIST') errors.push(`${file}: ${error.message}`); }
  }
  return {imported,errors};
}
