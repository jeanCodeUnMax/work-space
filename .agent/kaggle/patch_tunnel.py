import json, os

NB = r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\comfyui-kaggle.ipynb'
CREDS = os.path.expanduser(r'~\.cloudflared\__CF_TUNNEL_ID__.json')

nb = json.load(open(NB, encoding='utf-8'))

setup_lines = [
    "import json as _json\n",
    "os.makedirs('/kaggle/working/.cloudflared', exist_ok=True)\n",
    "_creds = _json.loads(r'''__CF_CREDS_JSON__''')\n",
    "open('/kaggle/working/.cloudflared/tunnel.json','w').write(_json.dumps(_creds))\n",
    "open('/kaggle/working/cf-config.yml','w').write(\n",
    "    'tunnel: __CF_TUNNEL_ID__\\n'\n",
    "    'credentials-file: /kaggle/working/.cloudflared/tunnel.json\\n'\n",
    "    'ingress:\\n'\n",
    "    '  - hostname: __CF_HOSTNAME__\\n'\n",
    "    '    service: http://127.0.0.1:8188\\n'\n",
    "    '  - service: http_status:404\\n')\n",
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

# push-tmp : injecter token comfy + creds tunnel, vider marotte
creds = open(CREDS, encoding='utf-8').read().strip()
tok = os.environ.get('KAGGLE_COMFY_TOKEN', '')
s = json.dumps(nb, indent=1)
s = s.replace('__KAGGLE_COMFY_TOKEN__', tok)
s = s.replace('__MAROTTE_TUNNEL_TOKEN__', '')
s = s.replace('__CF_CREDS_JSON__', creds)
open(r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\push-tmp.ipynb', 'w', encoding='utf-8').write(s)
print('placeholders restants:', s.count('__KAGGLE_COMFY_TOKEN__'), s.count('__MAROTTE_TUNNEL_TOKEN__'), s.count('__CF_CREDS_JSON__'))
