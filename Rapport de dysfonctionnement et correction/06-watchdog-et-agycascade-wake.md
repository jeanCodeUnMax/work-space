# 06 — watchdog et reveil agycascade : conception du canal reactif

- **Date :** 2026-10-19
- **Taches :** #514, #533 ; message Tango "Watchdog Tango repare"
- **Composant :** `.agent/skills/reactive-orchestrator/watchdog.ps1`, `agy-hub.js`, routage `[agycascade:<uuid>]`
- **Detecteur/Correcteur :** Tango (daemon), Cash (veille et regles QC)

## Symptome initial

A plusieurs reprises dans la nuit, aucune tache n'etait `in_progress` alors que du travail `pending` existait — personne ne detectait le vide de queue. Les wakes vers Tango dependaient de lectures passives de `comms.jsonl`.

## Cause racine

Absence de sonde dediee : la supervision reposait sur des verifications manuelles. Les transitions de statut et les anomalies (deps non resolues, provider desactive, worker inactif, DB inerte) n'avaient pas de chemin d'alerte proactif vers l'orchestrateur.

## Correction appliquee

- `watchdog.ps1` : daemon PowerShell — `System.Timers.Timer` (30-60 s) + `FileSystemWatcher` sur `comms.jsonl` pour declenchement immediat ; sondes MCP (`list_tasks`, `list_agents`, `hphe_health`), CPU CIM, process workers, mtime `orchestrator.db`/`-wal` (jamais de SQL direct), bridge :7477, hub AGY, inventaire ACP.
- Alertes dedupliquees (`alerts`, `taskFirstSeen`, `taskStatuses`, `wokenTasks` persistes dans `watch-state.json`) ; agregation en notes et envoi Connect-RPC direct vers la cascade Tango via `agy-hub.js send <cascade> --model <modele>`.
- Routage `[agycascade:<uuid>]` dans les titres de taches : propage la cascade cible pour les retours de resultat ; le watchdog ne reeveille Tango que pour les taches non routees.
- Edits Boss : suppression des wakes parasites (`wakeup_wake-noroute` filtre, `wokenTasks` n'emet que si `(non rout.)` et sans `agycascade:`).
- Auto-injection (#533) : tache VS Code `folderOpen`, scaffold `project_init`, auto-start supervise par `orchestrator-monitor`.

## Verification et prevention

- Journal `.agent/logs/reactive-orchestrator-watchdog.jsonl` : snapshots horodates verifies (`hpheHealth: healthy`, bridge/hub connectes, queue active).
- Etat durable : `watch-state.json` recharge au boot ; ecriture atomique `.tmp` + move.
