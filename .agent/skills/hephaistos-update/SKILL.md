---
name: hephaistos-update
description: Sur hephaistos2-kit, quand l'utilisateur dit "mets à jour", "git pull", "pull les modules" — pull depuis projet-temporaire (integration-n8n), checkout des sous-modules sur leurs gitlinks, installation des extensions dans ~/.devin/extensions SANS build (VSIX present dans le repo, sinon copie dossier dev), purge watchdog (process + env HEPHAISTOS_WATCHDOG/ORCH_MODEL_PING_MS), push vers jeanCodeUnMax.
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
2. Sous-modules `.gitmodules` : fetch de l'URL org + `git checkout` du SHA gitlink enregistré (le point qui échouait en manuel).
3. Extensions `extensions/*/package.json` : lit `publisher.name-version`, cherche le VSIX correspondant dans le dossier (`<name>-<version>.vsix`) → extraction dans `~/.devin/extensions/` ; **si pas de VSIX → copie du dossier dev** (hors `.git`/`node_modules`). **Aucun build vsce.** Anciennes versions → `~/.devin/extensions.bak` (fichier verrouillé = laissé, non bloquant).
4. Purge : kill `watchdog.ps1`, suppression `HEPHAISTOS_WATCHDOG`/`ORCH_MODEL_PING_MS` (User+Machine).
5. Push : sous-modules vers `jcum` (ou origin), puis superprojet `jcum integration-n8n`.

## Versions attendues (oct 2026)

`orchestrator-monitor 0.0.74` · `hephaistos-chats 0.3.34` · `hephaistos-kit-search 1.0.7` — vérifier après run via les `package.json` installés.

## Après exécution

- Dire : **Developer: Reload Window** dans Devin.
- Rapporter versions installées, watchdog tués, refs poussées.
- Cas limite : si une nouvelle version n'a ni VSIX ni `out/` compilé, le dossier dev copié peut être incomplet → le signaler à l'utilisateur, ne pas builder sans demande explicite.
