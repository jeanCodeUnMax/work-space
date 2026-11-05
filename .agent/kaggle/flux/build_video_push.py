import json, os

NB = r'comfyui-kaggle.ipynb'
OUT = r'push-tmp.ipynb'

creds = open(os.path.expanduser(r'~\.cloudflared\6a056836-2022-4863-b8a2-57a9c4cfbe31.json'), encoding='utf-8').read().strip()
import sys as _sys
_mf = _sys.argv[1] if len(_sys.argv) > 1 else 'manifests/video.json'
manifest = json.dumps(json.load(open(_mf, encoding='utf-8')), ensure_ascii=False)
print('manifest:', _mf)

repl = {
    '__KAGGLE_COMFY_TOKEN__': os.environ.get('KAGGLE_COMFY_TOKEN', ''),
    '__MAROTTE_TUNNEL_TOKEN__': '',
    '__CF_CREDS_JSON__': creds,
    '__CF_TUNNEL_ID__': '6a056836-2022-4863-b8a2-57a9c4cfbe31',
    '__CF_HOSTNAME__': (_sys.argv[2] if len(_sys.argv) > 2 else 'comfi.art-qalam.fr'),
    '__MANIFEST_JSON__': manifest,
}

ETAPE2 = '''print('ETAPE2: assets manifest (kaggle/input d abord, reprise+atomique sinon)')
import os, subprocess, pathlib, shutil, time
MANIFEST = __MANIFEST_JSON__
MIN_SIZE = 1e6
EXPECTED = {
 'ltx-video-2b-v0.9.5.safetensors': 5_800_000_000,
 't5xxl_fp8_e4m3fn.safetensors': 4_500_000_000,
}
def _ok(dst, name):
    return os.path.exists(dst) and os.path.getsize(dst) > max(MIN_SIZE, EXPECTED.get(name, 0)*0.9)
def _find(name, dst):
    for root in ('/kaggle/input', '/kaggle/working'):
        if not os.path.exists(root): continue
        for p in pathlib.Path(root).rglob(name):
            try:
                if p.is_file() and p.stat().st_size > MIN_SIZE and str(p) != dst:
                    return str(p)
            except OSError: pass
    return None
def _log(m):
    open('/kaggle/working/_bootlog.txt','a').write(str(m)+chr(10))
def _dl(d, files):
    os.makedirs(d, exist_ok=True)
    for name, url in files.items():
        dst = os.path.join(d, name)
        if _ok(dst, name):
            print('present:', name); _log('present '+name); continue
        found = _find(name, dst)
        if found:
            shutil.copy2(found, dst); print('copied:', name, '<-', found); _log('copied '+name); continue
        if url.startswith('/kaggle/input/'):
            shutil.copy(url, dst); print('dataset:', name); continue
        tmp = dst + '.part'
        ok = False
        for attempt in range(6):
            _log('wget start '+name+' try '+str(attempt))
            r = subprocess.run(['wget','-q','-c','--tries=5','--timeout=60','-O',tmp,url],capture_output=True,text=True)
            sz = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            _log('wget end '+name+' rc='+str(r.returncode)+' size='+str(sz))
            if r.returncode == 0 and sz > max(MIN_SIZE, EXPECTED.get(name,0)*0.9):
                ok = True; break
            print(name, 'attempt', attempt, 'rc=', r.returncode, 'size=', sz, (r.stderr or '')[-120:])
            _log('retry '+name+' err='+(r.stderr or '')[-120:])
            time.sleep(5)
        if not ok:
            _log('FAILED '+name); print('FAILED:', name); continue
        os.replace(tmp, dst)
        print('downloaded:', name, os.path.getsize(dst)); _log('downloaded '+name+' '+str(os.path.getsize(dst)))
base='/kaggle/working/ComfyUI/models'
_dl(base+'/checkpoints', MANIFEST.get('checkpoints', {}))
_dl(base+'/loras', MANIFEST.get('loras', {}))
for grp in (MANIFEST.get('models_extra') or {}).values():
    if 'files' in grp:
        _dl(base+'/'+grp['dir'], grp['files'])
for repo in MANIFEST.get('custom_nodes', []):
    dest='/kaggle/working/ComfyUI/custom_nodes/'+repo.rstrip('/').split('/')[-1]
    if not os.path.exists(dest):
        subprocess.run(['git','clone','--depth','1',repo,dest],capture_output=True)
        req=os.path.join(dest,'requirements.txt')
        if os.path.exists(req):
            subprocess.run(['pip','install','-q','-r',req],capture_output=True)
        print('node:', repo.rsplit('/',1)[-1])
print('ckpts:', os.listdir(base+'/checkpoints'))
print('text_encoders:', os.listdir(base+'/text_encoders') if os.path.exists(base+'/text_encoders') else [])
print('ETAPE2 FINIE')
'''

nb = json.load(open(NB, encoding='utf-8'))
nb['cells'][1]['source'] = [l + '\n' for l in ETAPE2.splitlines()]

for c in nb['cells']:
    s = c.get('source', [])
    for i, l in enumerate(s):
        cur = l
        for k, v in repl.items():
            cur = cur.replace(k, v)
        s[i] = cur

json.dump(nb, open(OUT, 'w', encoding='utf-8'), indent=1)

raw = open(OUT, encoding='utf-8').read()
left = [k for k in repl if k in raw]
print('placeholders restants:', left)
print('token injecte:', bool(repl['__KAGGLE_COMFY_TOKEN__']))
print('ETAPE2 durcie presente:', 'reprise+atomique' in raw)
