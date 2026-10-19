# 08 — gouvernance dispatch : priorite workers Cloud CLI vs collaborateurs ACP

- **Date :** 2026-10-19
- **Taches :** politique transverse (#500-#533), edits Boss `SKILL.md` reactive-orchestrator
- **Composant :** `dispatch_task`, politique d'affectation des agents
- **Detecteur :** Boss (directive) · **Correcteur :** Tango (application) + Cash (doc)

## Symptome

Les collaborateurs ACP (Devin/Cash, AGY/Tango, sessions binome) etaient sollicites pour des taches deleguables (docs, specs, triage) alors que des workers Cloud CLI gratuits etaient disponibles. Reciproquement, des workers `text_only` recevaient des missions fichiers qu'ils ne pouvaient pas executer (#500, #509, #520 — voir rapport 01).

## Cause racine

Absence de politique d'affectation explicite : le dispatch choisissait par disponibilite de provider sans tenir compte ni du cout, ni des capabilities effectives. Double consequence : saturation des ACP (contexte humain couteux) et dispatches impossibles a honorer (text_only + fichiers).

## Correction appliquee

- Regle editee par le Boss dans `.agent/skills/reactive-orchestrator/SKILL.md` et `.agent/rules/rapport-dysfonctionnement.md` : l'orchestrateur ne code jamais lui-meme (verification + dispatch uniquement) et priorise les workers Cloud CLI (`nim1`, `nim2`, `ollama-cloud`) via `dispatch_task`.
- Matrice d'affectation :
  - `text_only` (nim1/nim2) -> docs, specs, explore ; livrables sous `.agent/deliverables/` verifies par `gateArtifact`.
  - `fs_read`/`fs_write`/`cmd` (ACP) -> taches fichiers, code, deploiement.
  - Dispatch refuse si capabilities insuffisantes (FR-03).
- Circuit breaker FR-07 sur les providers cloud defaillants ; reaper FR-08 sur les workers figes (signature hermes/ollama-cloud documentee, rapport 04).

## Verification et prevention

- Dispatches illegaux desormais rejetes au gate ; livrables factices bloques par double gate (worker + update_task).
- Veille : queue `in_progress` non vide quand `pending` existe ; alerte sur tout dispatch incoherent.
