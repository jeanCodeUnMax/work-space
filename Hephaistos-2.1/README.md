# Hephaistos 2.1 — Durcissement orchestrateur & binôme

> Initiative : fiabiliser l'orchestration multi-agents Hephaistos2-Kit sur la base des pannes réelles observées (octobre 2026). Principe directeur : **le maximum en Rust** (vélocité, légèreté, un seul binaire `hphe-mcp.exe`), le JS uniquement là où l'IDE l'impose (ws-bridge, extension, agent-bridge).

## Pourquoi 2.1

Pannes constatées en production qui motivent chaque exigence :

| Panne observée | Cause racine | Exigence 2.1 |
|---|---|---|
| Workers NIM marqués `completed` sans rien écrire (rapports factices) | Completion = réponse texte, aucune vérif livrable | Gate livrable + capacités agent |
| `#441` : crash instantané `hermes -z` | Dispatch avec `model`/`provider` vides | Fail-fast au dispatch |
| `#452` : dispatch sur `openrouter-free` désactivé | Aucun check `provider_prefs.enabled` au dispatch forcé | Gate provider enabled |
| Tâches `in_progress` fantômes après crash IDE | Workers orphelins, aucun heartbeat | Reaper + heartbeat |
| `list_acp_sessions` muet après crash IDE | Dépendance unique au client WS de l'extension | Fallback découverte + reconnexion |
| `agent-discipline.mjs` écrit SQLite en direct | Violation de la règle « orchestrateur via MCP » | Tool `discipline_agent` natif |

## Contenu du dossier

| Document | Rôle |
|---|---|
| `FEASIBILITY.md` | Rapport de faisabilité — matrice effort/risque/verdict des 9 exigences + pistes plugin/CLI |
| `PRD.md` | Product Requirements Document — exigences FR-xx avec critères d'acceptation |
| `TRACKER.md` | Découpage en tâches par phase, dépendances, statuts |
| `ARCHITECTURE.md` | Diagrammes Mermaid — archi actuelle, cible 2.1, séquences binôme/dispatch, circuit breaker |
| `design/phase1-rust-gates.md` | Spec : fail-fast dispatch + capacités + discipline MCP |
| `design/phase2-rust-integrity.md` | Spec : gate livrable + verify_task QC + circuit breaker |
| `design/phase3-js-bridge-extension.md` | Spec : heartbeat/reaper + persistance pairs + extension IDE |
| `design/phase4-hphe-orch-cli.md` | Spec : CLI `hphe-orch` pilotable sans IDE |

## Composants touchés

```
hphe/crates/hphe-kit/src/orch.rs        ← logique orchestrateur (Rust, 1517 l.)
hphe/crates/hphe-mcp/src/tools/kit.rs   ← surface MCP (Rust)
extensions/orchestrator-monitor/        ← extension IDE + ws-bridge JS
.agent/agent-bridge/                    ← binome.js, chat-id.js, acp-inject.js, comms.js
data/orchestrator.db                    ← migrations additives uniquement
```

## Invariants non négociables

- Toute mutation de `orchestrator.db` passe par les outils MCP — jamais de SQL direct.
- Modifications du canonique `Projet-complet/hephaistos2-kit` → vérifier divergence avec `servers/hephaistos2-kit` + `cargo check` / `node --check` + `fix-report-<date>.md`.
- Recompiler `hphe-mcp.exe` coupe les sessions MCP actives → déployer en fenêtre calme, avec `.old` de côté.
- Jamais de secrets dans les fichiers, les args ou les logs.

## Statut

Draft — documents produits 2026-10-18, implémentation non démarrée. Voir `TRACKER.md` pour l'ordre d'exécution.
