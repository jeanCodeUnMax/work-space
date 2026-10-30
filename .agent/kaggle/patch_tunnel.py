import json, os, glob, sys

NB = r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\comfyui-kaggle.ipynb'

# Creds du tunnel dédié CF_TUNNEL_NAME (défaut 'comfi') : résolu via
# `cloudflared tunnel list -o json` -> ~/.cloudflared/<TunnelID>.json.
import subprocess
tname = os.environ.get('CF_TUNNEL_NAME', 'comfi')
tunnel_id = None
try:
    out = subprocess.check_output(['cloudflared', 'tunnel', 'list', '-o', 'json'], text=True, timeout=15)
    for t in json.loads(out):
        if t.get('name') == tname:
            tunnel_id = t.get('id'); break
except Exception:
    pass
if not tunnel_id:
    cands = glob.glob(os.path.expanduser(r'~\.cloudflared\*.json'))
    if len(cands) == 1:
        tunnel_id = json.loads(open(cands[0]).read()).get('TunnelID')
if not tunnel_id:
    sys.exit(f'Tunnel "{tname}" introuvable - cloudflared tunnel create {tname} puis route dns {tname} <host>.')
CREDS = os.path.expanduser('~/.cloudflared/' + tunnel_id + '.json')
creds_raw = open(CREDS, encoding='utf-8').read().strip()
hostname = os.environ.get('CF_HOSTNAME', '')
if not hostname:
    # 1) derive des routes DNS du tunnel resolu
    try:
        import re as _re
        r = subprocess.run(['cloudflared', 'tunnel', 'route', 'dns'], capture_output=True, text=True, timeout=30)
        for ln in (r.stdout or '').splitlines():
            if tunnel_id in ln:
                m = _re.search(r'([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', ln)
                if m:
                    hostname = m.group(1); break
    except Exception:
        pass
if not hostname:
    # 2) fallback fichier local (gitignore) : {"hostname": "..."}
    _tl = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tunnel.local.json')
    if os.path.exists(_tl):
        try:
            hostname = json.load(open(_tl, encoding='utf-8')).get('hostname', '')
        except Exception:
            pass
if not hostname:
    sys.exit('Hostname introuvable : CF_HOSTNAME, route DNS du tunnel ou tunnel.local.json requis.')

tok = os.environ.get('KAGGLE_COMFY_TOKEN', '')

nb = json.load(open(NB, encoding='utf-8'))

setup_lines = [
    "import json as _json\n",
    "os.makedirs('/kaggle/working/.cloudflared', exist_ok=True)\n",
    "_creds = _json.loads(r'''__CF_CREDS_JSON__''')\n",
    "open('/kaggle/working/.cloudflared/tunnel.json','w').write(_json.dumps(_creds))\n",
    "open('/kaggle/working/cf-config.yml','w').write(\n",
    "    'tunnel: __CF_TUNNEL_ID__\n'\n",
    "    'credentials-file: /kaggle/working/.cloudflared/tunnel.json\n'\n",
    "    'ingress:\n'\n",
    "    '  - hostname: __CF_HOSTNAME__\n'\n",
    "    '    service: http://127.0.0.1:8188\n'\n",
    "    '  - service: http_status:404\n')\n",
    "print('cf config ecrite: __CF_HOSTNAME__ -> :8188')\n",
]

old_cmd = "_cf_cmd = (['/kaggle/working/cloudflared','tunnel','--no-autoupdate','run','--token','__MAROTTE_TUNNEL_TOKEN__'] if '__MAROTTE_TUNNEL_TOKEN__' else ['/kaggle/working/cloudflared','tunnel','--no-autoupdate','--url','http://127.0.0.1:8188'])"
new_cmd = "_cf_cmd = ['/kaggle/working/cloudflared','tunnel','--no-autoupdate','--config','/kaggle/working/cf-config.yml','run','__CF_TUNNEL_ID__']"

n = 0
for c in nb['cells']:
    s = c.get('source', [])
    for i, l in enumerate(s):
        if old_cmd in l:
            s[i] = l.replace(old_cmd, new_cmd)
            for k, sl in enumerate(setup_lines):
                s.insert(i + k, sl)
            n += 1
            break

json.dump(nb, open(NB, 'w', encoding='utf-8'), indent=1)
print('cells patchees:', n)

# push-tmp : injection DANS les sources des cellules — les quotes des creds
# sont échappées par json.dump, jamais collées en brut dans le JSON sérialisé.
_prof = os.environ.get('CF_PROFILE', 'sdxl')
_mpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifests', _prof + '.json')
_manifest = json.dumps(json.load(open(_mpath, encoding='utf-8')), ensure_ascii=False) if os.path.exists(_mpath) else '{}'
print('profile:', _prof, '| manifest', len(_manifest), 'chars')

repl = {
    '__KAGGLE_COMFY_TOKEN__': tok,
    '__MAROTTE_TUNNEL_TOKEN__': '',
    '__CF_CREDS_JSON__': creds_raw,
    '__CF_TUNNEL_ID__': tunnel_id,
    '__CF_HOSTNAME__': hostname,
    '__MANIFEST_JSON__': _manifest,
}
remaining = {k: 0 for k in repl}
for c in nb['cells']:
    s = c.get('source', [])
    for i, l in enumerate(s):
        cur = l
        for k, v in repl.items():
            if k in cur:
                cur = cur.replace(k, v)
        s[i] = cur
        remaining.update({k: remaining[k] + cur.count(k) for k in repl})
json.dump(nb, open(r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\push-tmp.ipynb', 'w', encoding='utf-8'), indent=1)
print('placeholders restants:', remaining)
print('tunnel:', tunnel_id, '| host:', hostname)

# --- PUSH + ATTENTE (bouton Run Kaggle -> tout automatique) ---
import subprocess as _sp, time as _time, os as _os, sys as _sys
_push = _os.environ.get('KAGGLE_AUTOPUSH', '1') != '0'
if _push:
    print('push kernel...')
    r = _sp.run(['kaggle', 'kernels', 'push'], cwd=_os.path.dirname(_os.path.abspath(__file__)),
                capture_output=True, text=True)
    print((r.stdout or r.stderr).strip()[:400])
    if r.returncode == 0 and _os.environ.get('KAGGLE_NOWAIT', '0') != '1':
        print('attente tunnel', hostname, '(max ~12 min: clone+deps+modeles+boot)...')
        _deadline = _time.time() + 720
        _code = '000'
        while _time.time() < _deadline:
            try:
                r2 = _sp.run(['curl', '-s', '-m', '15', '-o', 'nul', '-w', '%{http_code}',
                              'https://' + hostname + '/'], capture_output=True, text=True)
                _code = (r2.stdout or '000').strip()
            except Exception:
                pass
            if _code == '200':
                break
            _time.sleep(20)
        print('endpoint', hostname, '->', _code)
        if _code != '200':
            print('TIMEOUT: le kernel boote encore - verifier https://www.kaggle.com/code/lascardm/comfyui-batch-gpu')
