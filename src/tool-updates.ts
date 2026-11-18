export interface YtDlpRelease { tag_name: string; assets: Array<{name:string;browser_download_url:string;digest:string|null;size:number}> }
export function selectYtDlpAsset(release:YtDlpRelease) {
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(release.tag_name)) throw new Error('Invalid yt-dlp release version.');
  const asset=release.assets?.find(x=>x.name==='yt-dlp_macos');
  const expected=`https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/yt-dlp_macos`;
  if (!asset || asset.browser_download_url!==expected || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '') || !Number.isSafeInteger(asset.size) || asset.size<1 || asset.size>150_000_000) throw new Error('Official yt-dlp release asset or checksum is unavailable.');
  return {version:release.tag_name,url:expected,sha256:asset.digest!.slice(7).toLowerCase(),size:asset.size};
}
export function newerVersion(latest:string,current:string) {
  const a=latest.split('.').map(Number), b=current.split('.').map(Number);
  for(let i=0;i<3;i++){if((a[i]??0)>(b[i]??0))return true;if((a[i]??0)<(b[i]??0))return false;}return false;
}
