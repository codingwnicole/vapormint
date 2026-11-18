export interface Release { tag_name:string; html_url:string; draft?:boolean; prerelease?:boolean; assets?:Array<{name:string}> }
export function findCompatibleRelease(releases:Release[],platform:string,arch:string):Release | undefined {
  return releases.find(release => !release.draft && !release.prerelease && (release.assets ?? []).some(({name}) => {
    const n=name.toLowerCase();
    if (platform === 'win32') return /\.exe$/.test(n) && /setup/.test(n);
    if (platform !== 'darwin' || !/\.(zip|dmg)$/.test(n) || !/(mac|darwin|osx|apple.silicon)/.test(n)) return false;
    if (/universal/.test(n)) return true;
    return arch === 'arm64' ? /arm64|aarch64|apple.silicon/.test(n) : arch === 'x64' && /x64|x86_64|intel/.test(n);
  }));
}
