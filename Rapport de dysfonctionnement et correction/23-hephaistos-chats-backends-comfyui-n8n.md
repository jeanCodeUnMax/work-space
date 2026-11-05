# 23 — Extension hephaistos-chats : onglets ComfyUI et n8n casses (0.3.42 -> 0.3.46)

Date : 2026-11-05
Composant : `extensions/hephaistos-chats` (`src/extension.ts`, `webview/workspace.tsx`, `proxies/*.mjs`)
Severite : Haute (deux onglets inutilisables, corrections deployees dans le mauvais IDE pendant plusieurs heures)
Statut : Corrige (verifie : n8n login OK, ComfyUI affiche via proxy :8190)

## Symptomes

- Onglet n8n : `n8n-auth-proxy: login n8n KO (401)` en boucle.
- Onglet ComfyUI : fenetre grise, aucune interface.
- Les rebuilds n'avaient aucun effet visible dans l'IDE.

## Causes racines (4 bugs distincts + 1 erreur de deploiement)

1. **Creds vides injectees au proxy n8n** — `ensureServiceOnce` passait
   `N8N_EMAIL: ''` / `N8N_PASSWORD: ''` dans l'env du proxy, ce qui ecrasait les
   valeurs du `.env` lues par `n8n-auth-proxy.mjs` (priorite `process.env`).
   Fix : ne passer que les cles non vides (`proxyEnv` filtre).

2. **`resolveComfyUI` ne trouvait que les launchers dev** — recherche limitee a
   `comfyui.cmd|bat` / `run_nvidia_gpu.bat` sur PATH. Le backend cible est le
   `Comfy Desktop.exe` deja lance (`F:\ComfyUi\ComfyUI\Comfy Desktop\Comfy Desktop.exe`).
   Fix : la fonction ne resout plus QUE l'exe (toutes references .bat/dev supprimees).

3. **`comfyui-proxy` jamais spawne** — `ensureServiceOnce('comfyui')` faisait
   `if (portUp(:8000)) return true` : quand Comfy Desktop tourne deja (cas normal),
   le bloc de spawn du proxy `:8190` etait saute. Restructure : le check backend
   ne garde que le spawn de l'exe ; le proxy `:8190` est assure dans tous les cas.

4. **Iframe en dur sur la dev** — `webview/workspace.tsx` iframait
   `http://127.0.0.1:8188` (ancienne dev ComfyUI) au lieu du proxy `:8190`.
   Explique pourquoi "ca marchait avec la version dev". Fix : `src="http://127.0.0.1:8190"`.

5. **Deploiement dans le mauvais IDE** — les VSIX etaient installees/copiees dans
   `C:\Users\Administrator\.cursor\extensions` alors que l'hote est **Devin**
   (`C:\Users\Administrator\.devin\extensions` + `extensions.json`). Toute
   correction compilait sans etre chargee.

## Corrections appliquees

| Version | Contenu |
|---------|---------|
| 0.3.42 | filtre creds proxy + resolveComfyUI exe-only (build casse puis restaure) |
| 0.3.43 | ports par defaut `:8000` (extension + `COMFYUI_LOCAL` dans le proxy) |
| 0.3.44 | ajout spawn `comfyui-proxy.mjs` sur `:8190` |
| 0.3.45 | retrait du `return true` premature qui sautait le spawn du proxy |
| 0.3.46 | iframe webview `:8188` -> `:8190` |

Deploiement : VSIX installee via `Extensions: Install from VSIX` + copie dans
`.devin/extensions/hephaistos.hephaistos-chats-0.3.46` + `extensions.json` a jour.

## Verification

- `curl http://127.0.0.1:8190/` -> 200 (proxie ComfyUI `:8000`, WS inclus).
- `curl http://127.0.0.1:8000/system_stats` -> 200 (Comfy Desktop en cours).
- Onglet n8n : login OK via proxy `:5680` + creds `.env`.
- Onglet ComfyUI : interface affichee (confirmee par l'utilisateur).

## Regles retenues

- Le webview React iframes toujours les **proxies** (`:8190`, `:5680`), jamais les backends directs.
- Ne jamais injecter une var d'env vide a un process fils : les valeurs vides ecrasent le `.env`.
- Verifier le repertoire d'extensions de **l'IDE hote reel** avant de conclure qu'un fix est deploye.
