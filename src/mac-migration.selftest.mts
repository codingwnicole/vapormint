import assert from 'node:assert/strict';
import { convertNativeSession } from './mac-migration.ts';
const source = {id:'source-1',sourcePath:'/tmp/a.mp4',displayName:'Episode',episodeLabel:'Episode 1',progress:1,finished:false,sourceAnalysis:{duration:30,width:1920,height:1080,fps:24,codec:'h264',bitrateMbps:5}};
const raw = {name:'Legacy project',activeSourceID:'source-1',created:0,sources:[source],clips:[{id:'clip-1',sourceID:'source-1',name:'Scene',start:1,end:3,completed:true,recipe:{aspectPreset:'Custom dimensions → ratio',customRatioWidth:'536',customRatioHeight:'320',masterSize:'Custom master resolution',masterWidth:'536',masterHeight:'320',denoise:0.8,denoiseMethod:'Balanced · fast',sharpen:0.45,sharpenMethod:'Natural lines',outputFormat:'Photoshop MOV · ProRes 4444',motion:'Smooth 60 fps',extractFrames:false}}]};
const p=convertNativeSession(raw,'/test/library/Sessions/A/session.json');
assert.equal(p.clips[0].preserveImportedRecipe,true);assert.equal(p.created,'2001-01-01T00:00:00.000Z');assert.equal(p.activeSourceId,'source-1');assert.equal(p.clips[0].sourceId,'source-1');assert.equal(p.clips[0].recipe.outputFormat,'ProRes 4444');assert.equal(p.clips[0].recipe.motion,'60 fps');assert.equal(p.clips[0].recipe.masterWidth,536);assert.equal(p.clips[0].recipe.denoiseStrength,0.8);assert.equal(p.clips[0].recipe.extractFrames,false);assert.equal(p.sources[0].sourceAnalysis.bitrate,5000000);assert.equal(convertNativeSession(raw,'/test/library/Sessions/A/session.json').id,p.id);
console.log('Native Mac project conversion passed');
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importMacProjects } from './mac-migration.ts';
const temp=await mkdtemp(path.join(tmpdir(),'vapormint-import-test-'));
try {
 const old=path.join(temp,'legacy','nested','Sessions','Project');const dest=path.join(temp,'new');
 await mkdir(old,{recursive:true});const original=JSON.stringify(raw);await writeFile(path.join(old,'session.json'),original);
 assert.deepEqual(await importMacProjects([path.join(temp,'legacy')],dest),{imported:1,errors:[]});
 assert.deepEqual(await importMacProjects([path.join(temp,'legacy')],dest),{imported:0,errors:[]});
 assert.equal(await readFile(path.join(old,'session.json'),'utf8'),original);
 const savedId=convertNativeSession(raw,path.join(old,'session.json')).id; await rm(path.join(dest,savedId),{recursive:true,force:true});
 assert.deepEqual(await importMacProjects([path.join(temp,'legacy')],dest),{imported:0,errors:[]});
 await mkdir(path.join(dest,savedId)); await writeFile(path.join(dest,savedId,'legacy-native-session.json'),original);
 const saved=convertNativeSession(raw,path.join(old,'session.json'));assert.equal(await readFile(path.join(dest,saved.id,'legacy-native-session.json'),'utf8'),original);
} finally { await rm(temp,{recursive:true,force:true}); }
console.log('Native Mac project import is non-destructive and repeatable');
