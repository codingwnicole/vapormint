export interface ReleaseAsset { name:string; browser_download_url?:string }
export interface Release { tag_name:string; html_url:string; draft?:boolean; prerelease?:boolean; assets?:ReleaseAsset[] }

function matchesPlatform(n:string, platform:string, arch:string):boolean {
  if (platform === 'win32') return /\.exe$/.test(n) && /setup/.test(n);
  if (platform !== 'darwin' || !/\.(zip|dmg)$/.test(n) || !/(mac|darwin|osx|apple.silicon)/.test(n)) return false;
  if (/universal/.test(n)) return true;
  return arch === 'arm64' ? /arm64|aarch64|apple.silicon/.test(n) : arch === 'x64' && /x64|x86_64|intel/.test(n);
}

export function findCompatibleRelease(releases:Release[],platform:string,arch:string):Release | undefined {
  return releases.find(release => !release.draft && !release.prerelease && (release.assets ?? []).some(({name}) => matchesPlatform(name.toLowerCase(), platform, arch)));
}

export function findDmgAsset(release:Release, arch:string):ReleaseAsset | undefined {
  return release.assets?.find(a => { const n=a.name.toLowerCase(); return /\.dmg$/.test(n) && matchesPlatform(n, 'darwin', arch); });
}
