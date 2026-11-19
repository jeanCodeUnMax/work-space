# 24 — Onglet ComfyUI hephaistos-chats : iframe vide / backend introuvable (:8000)

Date : 2026-11-07
Composant : `extensions/hephaistos-chats` + Comfy Desktop (`installations.json`) + launcher `run_comfyui.bat`
Severite : Moyenne (onglet ComfyUI de l'extension non fonctionnel sur le poste)
Statut : Corrige (verifie : http://127.0.0.1:8000/system_stats = 200, AgyProviderRouter dans object_info)

## Probleme

- Le bouton ComfyUI de l'extension ouvrait une fenetre vide / aucun backend.
- `run_comfyui.bat` lançait l'ancienne dev `.venv` sur :8188 au lieu de Comfy Desktop.
- Comfy Desktop tournait mais son serveur managé bindait :8188, pas :8000.

## Causes racines

1. **Launcher obsolet** — `C:\data-sys\ComfyUI\run_comfyui.bat` spawnait
   `.venv\Scripts\python.exe main.py --port 8188` (dev). Le backend cible est
   `Comfy Desktop.exe` (app installee).

2. **Port absent des launchArgs** — `--port` doit passer par `launchArgs` dans
   `%APPDATA%\Comfy Desktop\installations.json` (champ par installation,
   `portConflict: "auto"` l'applique au spawn python). Le serveur en cours
   avait ete demarre AVANT l'ajout → reste sur :8188.

3. **`killPort(8188)` stale dans le src** — `restartService` tuait l'ancien
   port dev au lieu de :8000 → le bouton restart ne tuait plus le backend.

4. **Doublon proxy** — un `comfyui-proxy.mjs` maison sur :8189 avait ete cree
   alors que l'extension embarque le sien (`proxies/comfyui-proxy.mjs` :8190
   → backend :8000). Retire du launcher.

5. **Exe GUI non lançable depuis un shell agent** — `Start-Process`/`start /b`
   depuis un contexte non-interactif fait crasher silencieusement l'exe.
   Contournement : `explorer.exe "<path>"` (delegue au shell interactif).

## Solution appliquee

- `run_comfyui.bat` : ne fait plus QUE `start "" "Comfy Desktop.exe"` si absent
  (1 seule instance, `tasklist` check).
- `installations.json` : install `ComfyUI` → `launchArgs: "--enable-manager --port 8000"`;
  `--port 8000` retire des installs remote (`comfy-webman`, `Comfy Cloud`).
- `src/extension.ts` : `killPort(8188)` → `killPort(8000)`; commentaires :8188 → :8000.
- `src/comfyuiPanel.ts` + `proxies/comfyui-proxy.mjs` : commentaires/erreurs :8188 → :8000.
- `npm run compile` relance → `out/` resynchronise avec `src/`.
- `C:\data-sys\ComfyUI\AGENTS.md` : section "COMFYUI BUTTON — CHAINE GRAVEE" (regle projet).

## Etat actuel

| Element | Etat |
|---|---|
| Comfy Desktop serveur | ecoute `127.0.0.1:8000` (verifie `system_stats` = 200) |
| `AgyProviderRouter` | visible dans object_info (1044 nodes) |
| Proxy extension :8190 | se leve a l'ouverture du panneau (spawn par l'extension) |
| Template hephaistos2-kit | src + out corriges — tout nouveau projet herite du fix |
| Extension installee 0.3.46 | anterieure au src corrige — fonctionne via `comfyui.cmd` → `run_comfyui.bat`; au prochain `vsce package` la resolution directe de l'exe rendra le bat optionnel |

## Chaine finale (gravee)

Bouton → comfyui.cmd → run_comfyui.bat → Comfy Desktop.exe → python --port 8000
Webview → iframe :8190 → proxy embarque extension → :8000
