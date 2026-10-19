# TRACKER — Hephaistos 2.1

Derniere mise a jour : 2026-10-19 — veille Cash/Devin.

## Phase 1 — Schema + dispatch + tools

| Task | Objet | Statut |
|---|---|---|
| 495 | Migration schema : `agents.capabilities`, `tasks_todo.expected_artifact` via `ensure_schema()` | completed |
| 496 | Validation dispatch : model/provider requis, `provider_prefs.enabled`, gate capabilities | completed |
| 497 | Tools `discipline_agent` + `agent_status` dans `kit.rs` | completed |
| 499 | Release build + tests + deploiement canonique | completed |
| 498 | Reprise de la 501 : packaging VSIX 1.0.5 (extension search) | completed |

## Incidents resolus

| Task | Cause | Resolution |
|---|---|---|
| 500 | nim2 text_only : diff hallucine (sqlx/init_db inexistants) | failed + sanction -20, scope repris via 495 |
| 501 | meme cause (extension) | failed + sanction -20, reprise via 498 |
| 502 | vibe : `Vibe budget exhausted` HTTP 402 | failed (zombie requalifie) |
| 503 | kilo -> openrouter desactive, `User not found` | failed — couvert par le gate provider de la 496 |
| 508 | hermes PID 24592 gele : 0 CPU / 4.5MB / zero output 11 min | process tue, task failed, scope repris via 504/505/506 |
| 509 | nim2 : fix-report + TRACKER.md pretendus, absents du disque | failed + sanction -20 (score 40), docs ecrits par Cash |

## Phase 2 — Enforcement

| Task | Objet | Statut |
|---|---|---|
| 504 | FR-05 : gate completion `expected_artifact` (fichier existe + mtime > created_at) | completed — valide live : rejete absent/ancien, accepte fichier frais |
| 505 | FR-06 : auto `verify_task` a la completion (`verified_by`, anti-boucle) | completed — code + compile ; spawn valide a la prochaine cloture d'une tache code dispatchee |
| 506 | FR-07 : circuit breaker `model_health` (3 echecs -> disable, cooldown 15min) | completed — hook `record_model_health` + reactivation dans `pick_model` |
| 507 | Rebuild Phase 2 + tests + deploiement + TRACKER | completed — release 2m22s, tests 10/10, deploy `extension/server/` (ancien `.old-2-20261019-0440`) |

Colonnes schema ajoutees : `tasks_todo.verified_by`, `provider_prefs.disabled_at` (idempotent via `ensure_schema`).

## Roster actif

| Agent | ID | Role | Capabilities |
|---|---|---|---|
| devin | 5 | Cash — Lead Rust, veille | fs_read, fs_write, cmd |
| vibe | 8 | mort (budget epuise) | - |
| ollama-cloud | 9 | hermes gpt-oss:120b-cloud | fs_write via hermes |
| nim2 | 10 | NIM texte seul — score 40 | text_only |
| nim1 | 11 | NIM texte seul | text_only |
