import json, os, glob, sys

NB = r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\comfyui-kaggle.ipynb'

# Creds tunnel nommé : ~/.cloudflared/<TunnelID>.json — l'ID est lu DANS le
# json lui-même, jamais en dur ici. Hostname : CF_HOSTNAME (env) obligatoire.
creds_files = glob.glob(os.path.expanduser(r'~\.cloudflared\*.json'))
if not creds_files:
    sys.exit('Aucun ~/.cloudflared/<id>.json — crée le tunnel nommé d\'abord (cloudflared tunnel create).')
CREDS = creds_files[0]
creds_raw = open(CREDS, encoding='utf-8').read().strip()
tunnel_id = json.loads(creds_raw).get('TunnelID') or os.path.splitext(os.path.basename(CREDS))[0]
hostname = os.environ.get('CF_HOSTNAME', '')
if not hostname:
    sys.exit('CF_HOSTNAME absent — définis le hostname du tunnel (ex. comfy.tondomaine.fr).')
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
repl = {
    '__KAGGLE_COMFY_TOKEN__': tok,
    '__MAROTTE_TUNNEL_TOKEN__': '',
    '__CF_CREDS_JSON__': creds_raw,
    '__CF_TUNNEL_ID__': tunnel_id,
    '__CF_HOSTNAME__': hostname,
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
