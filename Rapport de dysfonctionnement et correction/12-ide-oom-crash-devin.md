# 12 - Crashes recurrents de l'IDE Devin : epuisement memoire systeme (OOM)

**Date** : 2026-10-19
**Taches** : transverse (observabilite plateforme)
**Composant** : IDE Devin (Electron) + environnement hote
**Detecteur** : Boss (crash repetes), analyse `devin-crash-logs-20261019T054228.zip`
**Gravite** : haute (perte de fenetre, workers orphelins, repetition)

---

## Symptome

L'IDE Devin "plante" a repetition dans la nuit : fenetre renderer morte, workers ACP orphelins, redemarrages en cascade. Dumps Crashpad recurrents depuis le 07/10 (5 dumps, jusqu'a 38 Mo).

## Cause racine

**Epuisement memoire systeme, pas un bug applicatif.**

- `crash.json` : `reason: "oom"`, `exitCode: -536870904`, 2026-10-19T03:42:21Z. `main.log` : `CodeWindow: detected unresponsive` (05:00 local), `renderer process gone (crashed, -36861)` (05:33), `renderer process gone (oom, -536870904)` (05:42).
- Machine : **RAM 15,9 Go, 1,7 Go libre (~90 %) ; commit charge 28,2/31,9 Go (~88 %)** ; 403 processus.
- L'ecosysteme Devin seul pese **9,4 Go** : Devin 19 proc/4,75 Go (renderer max 3,09 Go), node 38/1,32 Go (serveurs MCP x fenetres + bridges + workers), opencode 4/1,36 Go, pwsh 17/735 Mo, kilo 670 Mo, llama-server 444 Mo, agy 252 Mo. + Obsidian ~1 Go, MsMpEng 527 Mo hors perimetre.
- Signature mecanique : quand le commit sature, le killer Chromium OOM abat le renderer le plus lourd -> fenetre perdue -> au redemarrage, l'auto-start relance tout (watchdogs, 15 serveurs MCP, workers, ingest) -> remontee memoire -> crash suivant.

## Facteurs aggravants mesures

1. **Multi-fenetres sur le meme workspace** (window1/3/6 dans les logs) : triple stack exthost + MCP + ingest.
2. **Churn ingest session** : le pipeline `ingest_flush` logue 12 282 flushes pour `acp_devin-cli_maple-lizard` (session la plus active), 8 944 `whip-principle`, heaps de fin de course 1,0-1,6 Go sous limite V8 4 Go.
3. **Etalement de processus** : 38 node (15 serveurs MCP par fenetre), 17 pwsh (watchdogs/tasks), 19 Devin.
4. **Locataires de fond** : Obsidian ~1 Go, opencode ~1,36 Go, llama-server 444 Mo, MsMpEng 527 Mo (scan temps reel probable sur WAL/comms.jsonl a haut debit d'ecriture + node_modules).
5. Workspace sous `C:\Program Files` (I/O surveillees) + indexation NTFS/Everything permanente.

## Correction appliquee

Aucun patch logiciel — incident d'environnement. Recommandations (ordre d'impact) :

1. **Une seule fenetre Devin** sur ce workspace — ferme window3/window6 (libere ~2 renderers + 2 exthosts + ~30 node MCP, ~2-3 Go).
2. **Couper les locataires inactifs** : opencode x4, llama-server, Obsidian si non requis (~2,8 Go recuperables).
3. **Exclusions Defender** : `C:\Program Files\Projet-complet\hephaistos2-kit`, `C:\Program Files\servers\hephaistos2-kit`, `%APPDATA%\Devin`, `%USERPROFILE%\.devin-shared` — stoppe le scan temps reel des fichiers a churn eleve (WAL, comms.jsonl, logs).
4. **Pagefile** : porter a >= 32 Go ou system-managed — amortit les pics de commit sans corriger la RAM.
5. **Reduire les serveurs MCP** : desactiver ceux non utilises (kaggle, puppeteer, pencil, colab, google-drive...) — 15 MCP x N fenetres = dizaine de node a ~35 Mo.
6. **Hygiene sessions ACP** : 95+ sessions devin-cli inventoriees ; les sessions mortes continuent d'etre ingerees — purger/fermer les inutilisees.

## Verification

- `crash.json` : motif `oom` confirme, timestamps alignes avec les restarts de main.log.
- Relevé live post-redemarrage : commit 28,2/31,9 Go, RAM libre 1,7 Go — seuil toujours critique, crash suivant probable sans les mesures 1-3.
- Dumps Crashpad historiques (07/10-17/10) : meme pattern chronique, pas un evenement isole.

## Prevention

1. Surveiller `heap_used`/RSS via le watchdog : ajouter au snapshot `memFreeMB` + `commitUsedPct` + alerte >85 % (le watchdog logue deja cpuPercent — extension triviale).
2. Regle d'exploitation : interdire >1 fenetre Devin par workspace orchestré ; tout nouveau locataire >300 Mo annonce au canal.
3. Exclusions AV et pagefile revus en base de poste (procedure install-kit).
4. A terme : separer la stack LLM locale (llama/opencode) de la machine IDE ou la scheduler.

---

*Analyse menees sur `devin-crash-logs-20261019T054228/` (crash.json, main.log, desktop-operations*.log, renderer.log). Conclusion : OOM systemique sous charge combinee IDE+MCP+workers+locataires — remediation = reduction d'empreinte, pas de correctif code.*
