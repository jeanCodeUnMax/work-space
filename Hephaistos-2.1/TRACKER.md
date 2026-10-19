# TRACKER — Hephaistos 2.1

Statut global : **en execution** · Date : 2026-10-19 (maj nuit 18-19/10)
Règle : une recompile `hphe-mcp.exe` par phase Rust maximum ; propagation canonique → `servers/` vérifiée à chaque merge.
Consolidation des modifications livrées : `PRD-CONSOLIDE-HEPHAISTOS-2.1.md`.

## Phase 1 — Gates dispatch (Rust) ✅ (tasks #495-499, déployé)

| # | Tâche | FR | Fichiers | Vérif | Statut |
|---|-------|----|----------|-------|--------|
| 1.1 | Migration : `agents.capabilities` TEXT, `tasks.expected_artifact` TEXT | FR-03/05 | `orch.rs` (`ensure_schema` dans `with_db`) | appliquée sur DB live | ✅ |
| 1.2 | Validation dispatch : model/provider non vides → erreur | FR-01 | `orch.rs` `dispatch_task` | dispatch `{}` refusé | ✅ |
| 1.3 | Validation dispatch : provider `enabled=0` → refus | FR-02 | `orch.rs` | incident 03 (kilo→openrouter) couvert | ✅ |
| 1.4 | Gate capabilities : `text_only` + mission fichier → refus | FR-03 | `orch.rs`, seed nim1/nim2 | nim2 seedé `["text_only"]` | ✅ |
| 1.5 | Tools `discipline_agent` + `agent_status` | FR-04 | `kit.rs` + `orch.rs` | sanctions nim2 (100→60→40) via MCP | ✅ |
| 1.6 | Recompile + déploiement + `fix-report` | — | `hphe-mcp.exe` → servers | release 1m55s, `.old` conservé | ✅ |

## Phase 2 — Intégrité livrables (Rust) ✅ (tasks #504-507, déployé)

| # | Tâche | FR | Fichiers | Vérif | Statut |
|---|-------|----|----------|-------|--------|
| 2.1 | Gate completion : `expected_artifact` existe + mtime > dispatch | FR-05 | `orch.rs` `update_task` | rejet absent+ancien, accepte frais (live #513) | ✅ |
| 2.2 | `verify_task` auto vers reviewer + anti-boucle `verified_by` | FR-06 | `orch.rs` | armé (task_type requis au dispatch) | ✅ |
| 2.3 | Circuit breaker `model_health` : compteur, seuil 3, cooldown 15 min | FR-07 | `orch.rs` | `pick_model` réactive après `disabled_at` | ✅ |
| 2.4 | Recompile + déploiement + `fix-report` | — | — | release 2m22s | ✅ |

## Phase 3 — JS + extension ✅ (tasks #515-523)

| # | Tâche | FR | Fichiers | Vérif | Statut |
|---|-------|----|----------|-------|--------|
| 3.1 | Heartbeat spawn wrapper (tick 30 s) | FR-08 | `orch.rs` `last_heartbeat`, beat au dispatch, `log=` dans event | tick visible en DB | ✅ |
| 3.2 | Reaper ws-bridge (>10 min → failed + event) | FR-08 | `ws-bridge/bridge.js` + `reconcile_dead_tasks` | 3e passe heartbeat stale | ✅ |
| 3.3 | Table `pairs` + persistance binôme + rejoin | FR-09 | `binome.js`, `comms.js`, `orch.rs` | `pair()` → `restored:true` post-15min | ✅ |
| 3.4 | Fallback `list_acp_sessions` direct providers | FR-10 | `devin-hub.js` (`listAcpSessionsDirect`, state.vscdb) | 544 sessions sans bridge | ✅ |
| 3.5 | Extension : commandes + status bar + WebView + reconnect | FR-11 | `orchestrator-monitor` | commandes/webview existants ; + auto-start watchdog (#533) | ✅ |
| 3.6 | `node --check` tous les fichiers bridge + `fix-report` | — | — | OK bridge/comms/binome/devin-hub/nim-worker | ✅ |

## Phase 3.7 — Veille réactive + auto-injection (#533, en cours)

| # | Tâche | FR | Fichiers | Vérif | Statut |
|---|-------|----|----------|-------|--------|
| 3.7.1 | PRD consolidé + plan + tracker | — | `PRD-CONSOLIDE-HEPHAISTOS-2.1.md` | doc écrite | ✅ |
| 3.7.2 | Watchdog `runOn=folderOpen` | — | `.vscode/tasks.json` | tâche ajoutée | ✅ |
| 3.7.3 | `project_init` scaffold workspace | — | `hphe-kit/memory.rs` + templates | init idempotent testé (`created:[]` au 2e appel) | ✅ |
| 3.7.4 | Auto-start watchdog par extension | — | `orchestrator-monitor/src/extension.ts` | spawn + respawn backoff + status bar | ✅ |
| 3.7.5 | Recompile + déploiement | — | release + `orchestrator-monitor-0.0.60.vsix` | exes déployés canonique | ✅ |

## Phase 4 — CLI hphe-orch ✅ (#522 spec, #538 implémentation)

| # | Tâche | FR | Fichiers | Vérif | Statut |
|---|-------|----|----------|-------|--------|
| 4.1 | Choix connexion : spawn hphe-mcp stdio vs lib | FR-12 | crate `hphe/crates/hphe-orch` | lib `hphe-kit` direct, zero stdio | ✅ |
| 4.2 | Sous-commandes + `--json` + exit codes | FR-12 | `hphe-orch` | `list/agents/create/dispatch/update/kill/verify/status/agent-status/discipline/heartbeat/reconcile/pair-save/pair-get`, `hphe-orch list --json` OK | ✅ |
| 4.3 | Install + doc + test depuis agent shell | FR-12 | `hphe-orch.exe` → `servers/extension/server/` | `status`/`agents`/`verify` testés live | ✅ |

## Dépendances

- 2.1 dépend de 1.1 (colonne `expected_artifact`)
- 3.1/3.2 dépendent de la migration `last_heartbeat` (peut aller en phase 2)
- 4.x dépend des phases 1-2 stables (les gates doivent exister pour que le CLI les respecte)
- FR-06 suppose un agent `reviewer` enregistré (AGY QC aujourd'hui ad hoc → formaliser dans le seed)

## À décider avant implémentation

1. `hphe-orch` : binaire Rust embarquant `hphe-kit` en lib (cohérent « Rust-first », plus léger) **vs** spawn stdio de `hphe-mcp.exe` (zéro duplication). → **décidé : lib** (spec phase4).
2. `capabilities` : colonne TEXT JSON `["fs_read","text_only"]` vs colonnes bool — **décidé : JSON compact** (livré).
3. Reviewer QC : rôle fixe `agy` ou rotation selon `provider_prefs` → recommandé : rôle dédié hors chaîne provider.
