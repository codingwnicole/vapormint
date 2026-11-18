import os, pathlib, shutil, subprocess, sys
root=pathlib.Path('runtime/darwin-arm64')
libdir=root/'ffprobe-libs'; libdir.mkdir(exist_ok=True)
source=os.path.realpath(sys.argv[1]) if len(sys.argv) > 1 else shutil.which('ffprobe')
if not source: raise SystemExit('ffprobe was not found')
queue=[source]; seen={}; deps={}
while queue:
 original=queue.pop(); real=os.path.realpath(original)
 if real in seen: continue
 seen[real]=os.path.basename(real)
 lines=subprocess.check_output(['otool','-L',real],text=True).splitlines()[1:]
 refs=[line.strip().split(' (')[0] for line in lines]
 deps[real]=[r for r in refs if r.startswith('/opt/homebrew/') and os.path.realpath(r)!=real]
 queue.extend(deps[real])
if len(set(seen.values()))!=len(seen): raise SystemExit('Duplicate library names')
for real,name in seen.items():
 target=(root/'ffprobe') if real==os.path.realpath(source) else libdir/name
 shutil.copy2(real,target); target.chmod(0o755)
 for ref in deps[real]:
  depname=seen[os.path.realpath(ref)]
  replacement=('@loader_path/ffprobe-libs/' if target.parent==root else '@loader_path/')+depname
  subprocess.run(['install_name_tool','-change',ref,replacement,str(target)],check=True)
 subprocess.run(['codesign','--force','--sign','-',str(target)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('Bundled',len(seen)-1,'libraries')
