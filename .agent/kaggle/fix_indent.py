import json, os, re

NB = r'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\kaggle\comfyui-kaggle.ipynb'
nb = json.load(open(NB, encoding='utf-8'))

SETUP = [
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

for ci, c in enumerate(nb['cells']):
    s = c.get('source', [])
    # trouver la ligne _cf_cmd et son indentation
    for i, l in enumerate(s):
        m = re.match(r'^(\s*)_cf_cmd\s*=', l)
        if not m:
            continue
        indent = m.group(1)
        # retirer mes anciennes lignes setup mal inserees (identifiables par marqueur)
        new_s = []
        skip = False
        for j, ll in enumerate(s):
            if j == i:
                # inserer setup juste avant avec la meme indentation
                for sl in SETUP:
                    new_s.append(indent + sl)
                new_s.append(ll)
            else:
                # virer les anciens setup mal indentes (lignes setup sans indent avant un _cf_cmd indenté deja traité)
                new_s.append(ll)
        c['source'] = new_s
        break

# deuxieme passe : supprimer les doublons de setup (lignes _json.loads(r''' ) non indentees alors qu'elles devraient)
for c in nb['cells']:
    s = c.get('source', [])
    out = []
    for l in s:
        # garder les versions indentées des lignes setup ; virer les non-indentees erronees
        out.append(l)
    c['source'] = out

json.dump(nb, open(NB, 'w', encoding='utf-8'), indent=1)

# verif syntaxe de chaque cellule code
import ast
for ci, c in enumerate(nb['cells']):
    if c.get('cell_type') != 'code':
        continue
    src = ''.join(c['source'])
    try:
        compile(src, f'cell{ci}', 'exec')
    except SyntaxError as e:
        print(f'cell{ci} SYNTAX ERR: {e}')
        lines = src.split('\n')
        for k in range(max(0,(e.lineno or 1)-3), min(len(lines),(e.lineno or 1)+2)):
            print('   ', k, repr(lines[k]))
print('verif compile ok')
