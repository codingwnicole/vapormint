import assert from 'node:assert/strict';
import { findCompatibleRelease } from './update-release.ts';
const releases=[{tag_name:'v3.0.0',html_url:'https://github.com/hxxliz/vapormint/releases/tag/v3.0.0',assets:[{name:'VapormintSetup.exe'}]},{tag_name:'v2.9.0',html_url:'https://github.com/hxxliz/vapormint/releases/tag/v2.9.0',assets:[{name:'Vapormint-2.9.0-darwin-arm64.zip'}]}];
assert.equal(findCompatibleRelease(releases,'darwin','arm64')?.tag_name,'v2.9.0');
assert.equal(findCompatibleRelease(releases,'win32','x64')?.tag_name,'v3.0.0');
assert.equal(findCompatibleRelease(releases,'darwin','x64'),undefined);
console.log('Update selection matches platform and architecture');
