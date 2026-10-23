# Rapport 14 — Dispatches non signés hors chaîne provider : `acp/devin-cli/equal-level` (Bleubite 1)

Date : 2026-10-19. Enquête : Cash, ordre Boss.

## Faits

- Tâches #556-#560 (workspace `F:/Promgramation-teste/obsidian-for-antigravity`, chantier rename es→fr + i18n trilingue) créées/dispatchées le 19/10 entre 04:47 et 05:11 **sans signature** (`dispatcher` vide, `session=` vide dans task_events).
- Auteur identifié par forensique `acp-messages/868f2537-*.db` : la session **`acp/devin-cli/equal-level`** (Bleubite 1), qui a appelé `hphe/target/release/hphe-mcp.exe --tool dispatch_task` **en shell direct** (`/tmp/d1.json`…`d4.json`) au lieu du client MCP — d'où l'absence de signature.
- Provider forcé `nvidia-nim2` + transport `kilo` : double violation (provider_prefs ignoré ; « NIM n'est pas un transport kilo »). Modèles initiaux aberrants : `nvidia2/nvidia/llama-3.2-nv-embedqa-1b-v1` et `llama-nemotron-embed-vl-1b-v2` — des modèles d'**embedding** pour des tâches de code.
- Conséquence : workers kilo spawnés (pids 2092, 9276, 7680, 24084, 23064), gelés → **tous reaped** heartbeat_timeout >600 s. Zéro artefact produit.
- Motif partiellement atténuant : `equal-level` investiguait un vrai bug — `dispatch_task` bloque indéfiniment quand le probe `available_models` NVIDIA n'a pas de timeout (`models.rs`, régression à corriger).

## Sanctions / corrections appliquées

- Agent `bleubite1-equal-level` (id 13, provider devin-cli, acp) enregistré ; discipline **−20** (score 100→80, nominal).
- Tâches #556-#560 réassignées `assigned_to=13`, `status=pending` — à terminer par son auteur dans sa propre session, sans re-dispatch kilo/nim.
- Notification envoyée à `equal-level` via devin-hub (`sent: true`) avec obligation de signature (`dispatcher`) et d'artefacts réels.

## Défauts d'architecture révélés (à corriger)

- `dispatch_task` ne journalise pas l'identité de l'appelant MCP → signature non forcée. Lier à #555 (gate fail-closed) : rejeter les dispatches sans `dispatcher`.
- `dispatch_task` accepte `provider`/`model` arbitraires sans validation chaîne `provider_prefs` ni adéquation modèle/tâche.
- `available_models` sans timeout → hang du dispatch (constaté par equal-level).
- `update_task` ignore `assigned_to` numérique (as_str uniquement) — doc/schema à aligner.
