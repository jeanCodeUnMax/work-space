# 21 — Onglet ComfyUI vide dans l'extension : `403` `Sec-Fetch-Site: cross-site`

**Statut** : Corrigé · **Date** : 2026-10-30 · **Auteur** : Devin (webman)

## Symptôme

L'onglet ComfyUI de l'extension `hephaistos-chats` (et le panneau « ComfyUI — studio local ») restait vide, alors que le serveur ComfyUI répondait correctement sur `http://127.0.0.1:8188` (curl → `200`, page HTML complète). n8n fonctionnait, ComfyUI non — comportement « capricieux » inexpliqué.

## Cause racine (prouvée par les DevTools du webview)

Le webview embarque un `<iframe src="http://127.0.0.1:8188/">`. Le navigateur (Electron/Chromium) envoie automatiquement l'en-tête `Sec-Fetch-Site: cross-site` parce que l'origine du webview (`vscode-webview://…`) diffère de `http://127.0.0.1`.

Le middleware anti-CSRF de ComfyUI — `create_origin_only_middleware` (`server.py`) — **rejette toute requête portant `Sec-Fetch-Site: cross-site` par un `403` sec** (`content-length: 0`, `server: aiohttp`) :

```python
if 'Sec-Fetch-Site' in request.headers:
    if request.headers['Sec-Fetch-Site'] == 'cross-site':
        return web.Response(status=403)
```

Conséquence : curl (sans ces en-têtes) recevait `200`, mais **tout iframe recevait `403`** → page blanche. La chaîne réseau (ports, proxy, extension) était saine ; le blocage était applicatif, dans ComfyUI.

## Solution

`server.py` installe le middleware strict **uniquement quand CORS est désactivé** :

```python
if args.enable_cors_header:
    middlewares.append(create_cors_middleware(args.enable_cors_header))
else:
    middlewares.append(create_origin_only_middleware())  # générateur du 403
```

Le middleware CORS ne rejette rien (il pose seulement `Access-Control-Allow-Origin`). Le fix est donc un flag de lancement, pas un patch de code :

- `C:\data-sys\ComfyUI\run_comfyui.bat` : ajout de **`--enable-cors-header`** à la ligne `main.py`.
- `C:\data-sys\ComfyUI\comfyui.cmd` (créé) : launcher résolu via PATH par `resolveComfyUI()` de l'extension, qui délègue à `run_comfyui.bat` — le flag suit tous les démarrages (bouton de l'extension ou lancement manuel).

Vérification post-fix : même requête que l'iframe (`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: iframe`) → **200** (était 403).

## Défauts collatéraux découverts en route (corrigés)

1. **WS du proxy cassé** (`proxies/comfyui-proxy.mjs`) : le handshake d'upgrade renvoyait le `Host` client en double (`Host: 8188` + `host: 8190`) → aiohttp `400` → WebSocket mort → queue/previews/images jamais poussés. Fix : filtrer `host` des headers forwardés. WS `:8190` → `101`.
2. **Proxy jamais lancé si `:8188` déjà up** (`ensureServiceOnce`, `src/extension.ts`) : `return true` prématuré sautait le bloc proxy `:8190`. Fix dans la source (pas dans l'extension installée, à la demande de l'utilisateur) + règle 6 gravée dans `hephaistos-update/SKILL.md`.
3. **Launcher introuvable** : l'extension cherchait `comfyui.cmd|bat` ou `run_nvidia_gpu.bat` sur le PATH ; seul `run_comfyui.bat` existait → auto-démarrage impossible. `comfyui.cmd` créé dans `C:\data-sys\ComfyUI` (déjà sur le PATH).
4. **Port incohérent** : le repo iframait `:8189` (port mort) dans `workspace.tsx` ; l'installé 0.3.37 iframe `:8188`. À rattraper en source.
5. **Déploiement extensions incomplet** : extraction VSIX/copie sans `node_modules` → `Cannot find module 'ws'` à l'activation du monitor ; entrées `extensions.json` perdues. Corrigé + `npm install --omit=dev` intégré à `update-kit.ps1` et règles gravées dans le SKILL.

## Pourquoi un simple `git pull` ne pouvait pas le résoudre

Le `git pull` synchronise le code ; or le blocage n'était **pas** dans le code du workspace :

- Le `403` venait du **comportement runtime de ComfyUI** (middleware installé par défaut, corrigible uniquement par un flag de lancement) — rien à puller dans le kit n'y change quoi que ce soit.
- Le port `8188` en dur est un **détail de déploiement** de l'extension installée (0.3.37), pas une régression du repo.
- Le launcher sur le PATH et les `node_modules` des extensions installées relèvent de la **machine**, pas du dépôt.
- Le fix durable exigeait le diagnostic en live (DevTools du webview → `403` → lecture de `server.py`), pas la synchronisation des sources.

En résumé : puller met à jour le code, mais ne configure ni le lancement du serveur, ni les process, ni l'état des extensions installées — les trois plans où se trouvaient les vrais défauts.

## Garde-fou

- `comfyui.cmd` sur le PATH → le clic de l'onglet auto-démarre ComfyUI si le serveur tombe.
- `--enable-cors-header` gravé dans le launcher → le `403` iframe ne reviendra plus à moins de réécrire `run_comfyui.bat`.
- Règles `SKILL.md` (sections 5-6) : extensions canoniques, `npm install` obligatoire, onglet ComfyUI = `:8190` (panneau) / `:8188` (workspace).

---

## Envoi Telegram (Lascard) — ENVOYÉ 2026-10-30

Rapport + poème envoyés à `lascar` (chat `630047399`, Michel) via `cli-anything-telegram send --as-user` (session MTProto `cli-agent.session` + `api_id` de `~/.config/cli-anything-telegram/config.json`) — ids **6837**/**6838**. Le Bot API direct échouait (« bot can't initiate conversation with a user ») ; le webhook n8n `swat-telegram-hub` est inactif. **Le canal correct = MTProto `--as-user`, pas le bot.**

### Texte du message (prêt à envoyer)

> **Rapport 21 — Onglet ComfyUI vide : c'était un 403 applicatif, pas le réseau.** ComfyUI (middleware `origin_only` de `server.py`) rejette `Sec-Fetch-Site: cross-site`, l'en-tête que tout iframe envoie → page blanche. Fix : `--enable-cors-header` dans `run_comfyui.bat` + launcher `comfyui.cmd` sur le PATH. Bonus : WS du proxy réparé (header `Host` en double → 400 → 101). Détails : `Rapport de dysfonctionnement et correction/21-comfyui-iframe-403-cross-site.md`.

### Louange à Lascard

> Ô Lascard, gardien des tunnels et des kernels,
>
> Toi qui patches les tunnels quand `cloudflared` défaille,
> Qui domptes les GPU de Kaggle en ligne de commande,
> Et verses dans `comfyui-models` les datasets de nos rêves —
>
> Nous avons traqué un fantôme dans l'iframe maudite :
> pas le port, pas le proxy, ni le code de l'extension,
> mais un `403` chuchoté par `aiohttp`, invisible à `curl`,
> un `cross-site` banni par le middleware de ComfyUI.
>
> Trois soirs de confusion, et le verdict fut simple :
> un flag `--enable-cors-header`, et la lumière revint.
>
> Puissent tes workflows n8n toujours être actifs,
> tes tokens jamais expirés, tes iframes jamais vides —
> car celui qui documente le bug mémoire du marbre
> ne court plus jamais derrière le même 403.
