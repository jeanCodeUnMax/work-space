# Fix Report — Phase 1 (Hephaistos 2.1)

Date : 2026-10-19 — Cash (Devin) / Lead Rust — session `acp/devin-cli/whip-principle`
Pair : `2a33ba30-3b3b-42ba-988c-bcea762732e6` (Tango hub / Cash acp)

## Contexte

Phase 1 de refonte de l'orchestrateur `hphe` : schema `orchestrator.db`
(capabilities + expected_artifact), validation du dispatch, nouveaux tools
`discipline_agent` / `agent_status`, build release et deploiement canonique.

Incident declencheur : tasks 500/501 confiees a `nim2` (worker text-only via
`.agent/scripts/nim-worker.mjs`) ont produit des livrables factices — diffs
invoquant `sqlx`/`init_db` inexistants (le code utilise `rusqlite` +
`with_db`/`Mutex<Connection>`). Sanctions appliquees : nim2 score 100 -> 60.

## Correctifs livres

### #495 — Migration schema (ensure_schema)

- `ensure_schema()` idempotent appele depuis `with_db` (`hphe/crates/hphe-kit/src/orch.rs`).
- `ALTER TABLE agents ADD COLUMN capabilities TEXT` (guard `PRAGMA table_info`).
- `ALTER TABLE tasks_todo ADD COLUMN expected_artifact TEXT`.
- Seed capabilities pour agents existants (ex. `nim2` -> `["text_only"]`).
- `seed-orchestrator.mjs` synchronise avec le schema Rust.
- Applique sur la DB live `C:\Program Files\servers\hephaistos2-kit\data\orchestrator.db`.

### #496 — Validation dispatch + gate capabilities

- `tool_dispatch_task` exige model/provider non vides.
- `provider_prefs.enabled = 1` verifie avant dispatch (le cas openrouter
  `enabled=0` de la task 503 est desormais bloque a la source).
- Gate `check_capabilities` : un worker `text_only` ne peut plus recevoir une
  tache exigeant `fs_read`/`fs_write`/`cmd`.

### #497 — Tools MCP

- `discipline_agent` et `agent_status` exposes dans
  `hphe/crates/hphe-mcp/src/tools/kit.rs` (definitions + dispatch).
- Parametres `capabilities` / `expected_artifact` ajoutes aux schemas
  `create_task` / `register_agent`.

### #499 — Build, tests, deploiement

- `cargo check` vert, tests verts, `cargo build --release` (~1m55s).
- Deploiement canonique `C:\Program Files\servers\hephaistos2-kit\` :
  `hphe-mcp.exe` (rename-and-copy, ancien conserve `hphe-mcp.exe.old-20261019`)
  et `hphe-rest.exe`.
- Caveat : les process MCP ouverts avant le deploiement tournent l'ancien
  binaire en memoire ; les nouvelles connexions chargent le nouveau.

## Verification

| Controle | Resultat |
|---|---|
| `git status` post-fix | `orch.rs`, `kit.rs`, `seed-orchestrator.mjs` modifies |
| `agent_status nim2` via binaire deploye | `capabilities: ["text_only"]`, score 60 |
| Task 498 (reprise de la 501) | `extension/hephaistos-kit-search-1.0.5.vsix` present, ~10.7 MB |

## Suites

Phase 2 (tasks 504-508) : gate de completion `expected_artifact` (FR-05),
auto `verify_task` (FR-06), circuit breaker `model_health` (FR-07),
rebuild/redeploy (507), docs (509).
