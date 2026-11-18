import assert from 'node:assert/strict';
import { selectYtDlpAsset, newerVersion } from './tool-updates.ts';
const digest='a'.repeat(64);const release={tag_name:'2026.10.26',assets:[{name:'yt-dlp_macos',browser_download_url:'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_macos',digest:'sha256:'+digest,size:100}]};
assert.equal(selectYtDlpAsset(release).sha256,digest);assert(newerVersion('2026.10.26','2026.09.01'));assert(!newerVersion('2026.09.01','2026.10.26'));
assert.throws(()=>selectYtDlpAsset({...release,assets:[{...release.assets[0],browser_download_url:'https://evil.example/yt-dlp_macos'}]}));
assert.throws(()=>selectYtDlpAsset({...release,assets:[{...release.assets[0],digest:null}]}));
console.log('Tool updater validates origin, hash, and version');
