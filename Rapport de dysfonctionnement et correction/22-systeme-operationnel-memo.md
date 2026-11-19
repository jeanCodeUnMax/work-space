# 22 — Mémo système : ce qui tourne, où, et quoi faire quand ça casse

**Statut** : Référence opérationnelle · **Date** : 2026-10-30 · **Auteur** : Devin (webman)

Ce document = la fiche de bord. Le système fonctionne quand tout ceci est vrai. Si un onglet est vide, suis la checklist avant de toucher quoi que ce soit.

## La chaîne qui marche (état sain)

```
Onglet ComfyUI (workspace)  ──iframe──> http://127.0.0.1:8188   ComfyUI direct
Panneau "studio local"      ──iframe──> http://127.0.0.1:8190   proxy → :8188
Onglet n8n                  ──iframe──> http://127.0.0.1:5680   n8n-auth-proxy → :5678
Monitor/orchestrateur       ──client──> ws://127.0.0.1:7477     ws-bridge/bridge.js
```

| Service | Port | Lancé par |
|---|---|---|
| ComfyUI | :8188 | `comfyui.cmd` (PATH) → `run_comfyui.bat` → `.venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --enable-cors-header` |
| comfyui-proxy | :8190 | extension (spawn) ou `node proxies/comfyui-proxy.mjs` |
| n8n | :5678 | service n8n |
| n8n-auth-proxy | :5680 | `.agent/scripts/start-n8n-proxy.cmd` |
| ws-bridge (orchestrateur) | :7477 | extension monitor ou `.agent/bootstrap.ps1` |

## RÈGLES À NE JAMAIS CASSER

1. **`--enable-cors-header` dans `run_comfyui.bat`** — sans ce flag, ComfyUI répond `403` à tout iframe (`Sec-Fetch-Site: cross-site`) → onglet vide alors que curl donne 200. C'est LA cause du bug du 30-10. Ne jamais réécrire cette ligne sans le flag.
2. **`comfyui.cmd` doit rester dans `C:\data-sys\ComfyUI\`** (dossier déjà sur le PATH) — c'est le nom que `resolveComfyUI()` cherche (`comfyui.cmd|bat`, `run_nvidia_gpu.bat`). `run_comfyui.bat` seul n'est PAS reconnu par l'extension.
3. **Ne jamais supprimer `node_modules` de `~/.devin/extensions/…monitor-0.0.74`** — le monitor a besoin de `ws` ; sans lui l'extension crash à l'activation (`Cannot find module 'ws'`) → orchestrateur mort, pas de bridge :7477.
4. **Proxy :8190 = process séparé** — si l'onglet standalone est vide mais :8188 répond : `node proxies/comfyui-proxy.mjs` depuis `extensions/hephaistos-chats/` (la version repo contient le fix `host` WS).

## Checklist "onglet vide" (dans l'ordre, 30 secondes)

```powershell
netstat -ano | findstr 8188     # rien → lancer C:\data-sys\ComfyUI\comfyui.cmd
netstat -ano | findstr 8190     # rien → relancer le proxy (règle 4)
netstat -ano | findstr 7477     # rien → monitor pas actif → Developer: Reload Window
curl http://127.0.0.1:8188/     # 200 attendu ; 403/rien → ComfyUI mal lancé
```

Puis dans Devin : **Ctrl+Shift+P → Developer: Open Webview Developer Tools → Network** → la ligne qui échoue dit tout (`403` = cors-header perdu, `ERR_CONNECTION_REFUSED` = service mort).

## Extensions installées (`~/.devin/extensions/`)

- `hephaistos.hephaistos-chats` 0.3.37 (Devin met à jour tout seul parfois)
- `hephaistos.orchestrator-monitor` 0.0.74 — **client** du bridge :7477, pas le serveur
- `projet-temporaire.hephaistos-kit-search` 1.0.7 — spawn `hphe-mcp.exe` stdio
- JAMAIS `art-qalam.everything-search` : proto abandonné.

## Git — politique gravée

- **Pull** : `origin` = projet-temporaire (source de vérité, lecture seule). Tous les modules à la HEAD distante, jamais au gitlink en retard.
- **Push** : UNIQUEMENT `jcum` (jeanCodeUnMax) `integration-n8n`. Jamais vers projet-temporaire.
- Update auto : `pwsh .agent/skills/hephaistos-update/update-kit.ps1` (fait pull + sous-modules + extensions + `npm install --omit=dev`).

## Fichiers machine-locale (pas dans git, ne pas perdre)

- `C:\data-sys\ComfyUI\comfyui.cmd` + `run_comfyui.bat` (le flag CORS dedans)
- `C:\data-sys\ComfyUI\pyrightconfig.json`, `pyrightconfig.json` (kit + n8n) — anti-énumération pyright
- `~/.config/cli-anything-telegram/config.json` — token bot + `api_id`/`api_hash` + chats nommés (`lascar`). Envoi DM = `cli-anything-telegram --chat lascar send --as-user` avec `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` en env (Bot API ne peut pas DM).
