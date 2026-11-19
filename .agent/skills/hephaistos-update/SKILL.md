---
name: hephaistos-update
description: Sur hephaistos2-kit, quand l'utilisateur dit "mets à jour", "git pull", "pull les modules" — pull depuis projet-temporaire (integration-n8n), TOUS les sous-modules alignés sur la HEAD distante de leur repo projet-temporaire (pas le gitlink enregistré, qui peut être en retard), installation des extensions dans ~/.devin/extensions SANS build (VSIX present dans le repo, sinon copie dossier dev), purge watchdog (process + env HEPHAISTOS_WATCHDOG/ORCH_MODEL_PING_MS), push vers jeanCodeUnMax JAMAIS projet-temporaire.
---

# hephaistos-update — "mets à jour" / "git pull"

## Déclencheur

Workspace `C:\data-sys\hephaistos2-kit` + requête "mets à jour", "git pull", "pull les modules/extensions", "récupère les dernières versions" → **exécuter le script, ne pas refaire à la main**.

## Script : `.agent/skills/hephaistos-update/update-kit.ps1`

```powershell
pwsh -File C:\data-sys\hephaistos2-kit\.agent\skills\hephaistos-update\update-kit.ps1 [-SkipPush]
```

Étapes (toutes automatisées) :

1. Stash local → `git pull origin integration-n8n` (origin = `projet-temporaire`).
2. Sous-modules `.gitmodules` : fetch de l'URL org + `git checkout` de la **HEAD distante projet-temporaire** (`git ls-remote <url> HEAD`) — **RÈGLE DURE : tous les modules à la dernière version existante sur l'org, jamais au gitlink enregistré s'il est en retard** (gitlinks à jour ensuite via `git add`).
3. Extensions `extensions/*/package.json` : lit `publisher.name-version`, cherche le VSIX correspondant dans le dossier (`<name>-<version>.vsix`) → extraction dans `~/.devin/extensions/` ; **si pas de VSIX → copie du dossier dev** (hors `.git`/`node_modules`). **Aucun build vsce.** Puis `npm install --omit=dev` dans le dossier installé **si `dependencies` non vides** (obligatoire : VSIX/copie sans `node_modules`). Anciennes versions → `~/.devin/extensions.bak` (fichier verrouillé = laissé, non bloquant).
4. Purge : kill `watchdog.ps1`, suppression `HEPHAISTOS_WATCHDOG`/`ORCH_MODEL_PING_MS` (User+Machine).
5. Push : **JAMAIS vers `origin`/projet-temporaire (lecture seule)** — sous-modules et superprojet vers `jcum` (jeanCodeUnMax) `integration-n8n` uniquement.

## Versions attendues (oct 2026)

`orchestrator-monitor 0.0.74` · `hephaistos-chats 0.3.36` · `hephaistos-kit-search 1.0.7` — vérifier après run via les `package.json` installés.

## Après exécution

- Dire : **Developer: Reload Window** dans Devin.
- Rapporter versions installées, watchdog tués, refs poussées.
- Cas limite : si une nouvelle version n'a ni VSIX ni `out/` compilé, le dossier dev copié peut être incomplet → le signaler à l'utilisateur, ne pas builder sans demande explicite.

## RÈGLES GRAVÉES — extensions `~/.devin/extensions/` (2026-10-30)

Leçons du bug "orchestrateur mort / extensions invisibles" — ne jamais les répéter.

### 1. Dossier seul ≠ extension installée

Chaque extension exige les DEUX :

- dossier `C:\Users\webma\.devin\extensions\<publisher>.<name>-<version>\` avec `package.json` + `main` résolvable ;
- **entrée dans `C:\Users\webma\.devin\extensions\extensions.json`** (`identifier.id`, `identifier.uuid`, `version`, `location.path` = `/c:/Users/webma/.devin/extensions/<dossier>`, `relativeLocation` = `<dossier>`).

Sans l'entrée, Devin ignore le dossier en silence (c'est ce qui a tué le monitor : entrée perdue → jamais chargée).

### 2. npm install OBLIGATOIRE après déploiement

L'extraction VSIX ou la copie de dossier **n'embarque pas `node_modules`**. Après chaque install :

```bash
cd ~/.devin/extensions/<dossier> && npm install --omit=dev --no-audit --no-fund
```

Sans ça → `Activating extension failed: Cannot find module 'ws'` (cas réel du monitor, seule dep runtime = `ws`).

### 3. Vérification post-déploiement (les 3, pas une)

1. `package.json` lu + `main` existe ;
2. entrée présente dans `extensions.json` ;
3. **tous les `require('mod')` externes du code `out/`/`extension.js` résolvent** (sauf `vscode` = fourni par l'host) — scanner avant de déclarer fini.

### 4. Après Reload Window — vérifier les logs, pas deviner

`%APPDATA%\devin\logs\<ts>\window1\exthost\exthost.log` : grep `Activating extension .* failed`. Devin **resynchronise `extensions.json`** au reload (peut mettre à jour une version ou purger une entrée orpheline) → re-vérifier l'état après, ne pas présumer.

### 5. Extensions canoniques (tout le reste = parasite)

- `hephaistos.orchestrator-monitor` (0.0.74) — **client** du bridge ; le serveur est `ws-bridge/bridge.js` dans le dossier de l'extension (fallback de démarrage : `.agent/bootstrap.ps1`). Port `ws://127.0.0.1:7477`.
- `hephaistos.hephaistos-chats` (≥0.3.36, 0.3.37 vu).
- `projet-temporaire.hephaistos-kit-search` (1.0.7) — spawn `server/hphe-mcp.exe` stdio.
- **JAMAIS `art-qalam.everything-search`** : proto abandonné, remplacé par `hephaistos-kit-search`. Ne pas le réinstaller ni le réenregistrer ; le cas échéant → corbeille/`extensions.bak`.

### 6. Onglet ComfyUI = proxy :8190, JAMAIS :8188 direct

`comfyuiPanel.ts` iframe `http://127.0.0.1:8190` — c'est `proxies/comfyui-proxy.mjs` (embarqué dans l'extension) qui choisit le backend : COMFYUI_BACKEND → local :8188 → COMFYUI_REMOTE. **"ComfyUI tourne sur 8188 mais onglet vide" = proxy mort** → `node proxies/comfyui-proxy.mjs`. Ne jamais court-circuiter le lancement du proxy quand :8188 répond déjà (bug corrigé 2026-10-30 dans `ensureServiceOnce`).
