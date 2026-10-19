---
titre: Phase 4 — CLI hphe-orch (pilotage orchestrateur sans IDE)
statut: draft
date: 2026-10-18
---

# Phase 4 — CLI `hphe-orch`

## Contexte

L'orchestrateur n'est joignable que par un client MCP (IDE). Cron, CI et
agents shell-only n'ont aucun point d'entrée : lister les tâches, dispatcher,
tuer, vérifier ou discipliner exige aujourd'hui soit un IDE ouvert, soit —
interdit — un accès SQLite direct à `orchestrator.db`.

Pattern de référence : `cli-anything-*` (sous-commandes, `--json`, exit
codes propres). Objectif 2.1 : maximum Rust — le CLI est un **nouveau crate
binaire** `hphe-orch` dans le workspace `hphe/crates/`, réutilisant
`hphe-kit::orch::*` directement (même DB, mêmes gates des phases 1–2, zéro
duplication de logique, zéro dépendance Node).

Prérequis : phases 1–3 livrées (gates, `verify_task`, `discipline_agent`,
`agent_status`, breaker, `pairs`). Le CLI ne réimplémente rien : il appelle
les mêmes `tool_*` que `hphe-mcp`.

## Exigences fonctionnelles

### FR-4.1 — Sous-commandes

```
hphe-orch list      [--status pending|in_progress|completed|failed]
                    [--agent <name|id>] [--limit N]
hphe-orch get       <task_id>
hphe-orch dispatch  --title T --task-type X [--context C] [--files a,b]
                    [--agent A] [--provider P] [--model M]
                    [--expected-artifact GLOB] [--workspace W]
                    [--worktree] [--priority low|medium|high] [--session S]
hphe-orch kill      <task_id>          # status=failed ; --pid pour kill proc
hphe-orch verify    <task_id> [--reviewer R]
hphe-orch status    [--agent A] [--providers] [--pairs]
hphe-orch discipline <agent> penalize|reward <points> <reason...>
hphe-orch discipline status
hphe-orch create    --title T [mêmes options que dispatch, sans spawn]
hphe-orch update    <task_id> [--status S] [--result R] [--assign A]
hphe-orch heartbeat <task_id>          # tick manuel (debug/wrapper simple)
```

### FR-4.2 — Sortie JSON agent-native

- **Toujours JSON** sur stdout (`--json` accepté pour compat pattern
  cli-anything-\*, défaut ; `--pretty` pour humains ; `--quiet` → ids seuls).
- Enveloppe stable : succès → `{"ok":true,"data":{...}}` ;
  erreur → `{"ok":false,"error":{"code":"PROVIDER_DISABLED",
  "message":"...","details":{...}}}` — les `code` sont ceux des gates
  (-32041 EMPTY_MODEL → `EMPTY_MODEL`, etc. : le string d'erreur structuré
  des phases 1–2 est décodé, jamais reformaté).
- stderr réservé aux diagnostics humains ; stdout jamais pollué → pipeable
  (`hphe-orch list --status pending | jq '.data[].id'`).

### FR-4.3 — Stratégie de connexion

Deux modes, résolution automatique :

1. **Direct (défaut)** : le binaire linke `hphe-kit` → `tool_*` in-process
   sur `orchestrator.db` (même `with_db`, WAL). Lecture **et** écriture par
   les chemins officiels — pas de SQL ad hoc dans le CLI.
2. **`--mcp` / `HPHE_ORCH_TRANSPORT=mcp`** : spawn `hphe-mcp.exe` en stdio
   JSON-RPC (`tools/call`), pour les hôtes qui n'ont que le binaire MCP
   déployé ou pour vérifier la parité de surface. `--mcp-bin <path>` pour
   surcharger.

Résolution DB : `--db <path>` > `HPHE_ORCH_DB` >
`%ProgramFiles%\servers\hephaistos2-kit\data\orchestrator.db` (même
convention que `bridge.js`/`agent-discipline.mjs`). La lecture read-only
directe (hors outils) n'est **pas** un mode supporté — tout passe par les
`tool_*` qui possèdent les gates et le journal `task_events`.

### FR-4.4 — Cas d'usage

- cron/CI : `hphe-orch list --status failed | jq` dans un fix-report
  nocturne ; `hphe-orch dispatch` depuis une pipeline.
- agents shell-only (hermes -z, kilo run) : pilotage orchestrateur complet
  sans client MCP.
- supervision : `hphe-orch status --providers` → état breakers ;
  `--pairs` → paires established (table phase 3).

### FR-4.5 — Sécurité

- **Jamais de secrets en argv** : aucun flag n'accepte de clé API ; les
  providers sous-jacents utilisent leur config propre. Les args sensibles
  futurs passeraient par env ou stdin, pas par la ligne de commande
  (visible dans `tasklist`/ps).
- Pas d'interpolation shell : le CLI ne construit aucune commande shell ;
  les valeurs vont en `params![]` rusqlite via les `tool_*` existants.
- `--db` refuse les chemins hors des racines canoniques sauf
  `HPHE_ORCH_DB_ANY=1` (garde-fou contre les typos de prod).
- Exit codes : `0` ok · `1` erreur interne · `2` usage/params
  (équivalent -32602) · `3` refus métier (gates -3204x) · `4` I/O DB ·
  `5` transport MCP indisponible.

## Spécifications

### Arborescence crate

```
hphe/crates/hphe-orch/
  Cargo.toml          # deps: hphe-kit, serde_json, clap(ou parse maison
                      #       pour rester léger — décision implémentation)
  src/main.rs         # parse argv → dispatch subcommand → serde_json::print
  src/transport.rs    # trait Transport { call(tool,args) } : Direct|Mcp
  src/mcp.rs          # spawn hphe-mcp stdio, framing JSON-RPC, timeout 30s
```

`transport.rs` : `Direct` = `hphe_kit::orch::tool_*` (async via
`tokio::runtime::Handle` minimal ou `block_on` — `tool_dispatch_task` est
`pub async fn`). `Mcp` = `initialize` → `tools/call` → parse `content[0]`
→ remonte `isError` en `error.code`.

### Mapping sous-commande → outil

| sous-commande          | outil MCP                                     |
|------------------------|-----------------------------------------------|
| `list` / `get`         | `list_tasks`                                  |
| `dispatch`             | `dispatch_task`                               |
| `create` / `update`    | `create_task` / `update_task`                 |
| `kill`                 | `update_task status=failed` (+ pid kill local) |
| `verify`               | `verify_task` (phase 2)                       |
| `status`               | `agent_status` + `list_agents` + provider_prefs + `pairs` (phase 3) |
| `discipline`           | `discipline_agent` / `agent_status`           |
| `heartbeat`            | `task_heartbeat` (phase 3)                    |

### Format de sortie (exemples)

```jsonc
// hphe-orch list --status in_progress
{"ok":true,"data":[{"id":512,"title":"...","status":"in_progress",
  "assigned_to":3,"model":"gpt-oss:120b-cloud","provider":"ollama-cloud",
  "last_heartbeat":"2026-10-18T14:01:02Z"}]}

// hphe-orch dispatch ... (refus gate)
{"ok":false,"error":{"code":"PROVIDER_DISABLED","rpc":-32042,
  "message":"provider 'openrouter-free' disabled in provider_prefs",
  "details":{"provider":"openrouter-free","retry_after":null}}}

// hphe-orch status --providers
{"ok":true,"data":{"providers":[
  {"provider":"nvidia-nim","enabled":1,"position":0,
   "breaker":{"failures":0,"open_until":null,"open_count":0}},
  {"provider":"openrouter-free","enabled":1,"position":4,
   "breaker":{"failures":3,"open_until":"2026-10-18T14:30:00Z",
    "open_count":2,"last_error":"503"}}]}}
```

### Exemples d'usage

```bash
hphe-orch dispatch --title "fix gate mtime" --task-type debug \
  --agent kilo-1 --expected-artifact "hphe/crates/hphe-kit/src/orch.rs"
hphe-orch status --providers | jq '.data.providers[] | select(.breaker.open_until)'
hphe-orch discipline nim-1 penalize 25 "completed sans livrable"
hphe-orch kill 512 && hphe-orch verify 511
HPHE_ORCH_TRANSPORT=mcp hphe-orch list --status pending   # parité MCP
```

## Plan de test

- `cargo check -p hphe-orch -p hphe-kit -p hphe-mcp` + `cargo test` :
  parse args (sous-commandes, flags inconnus → exit 2), mapping tool →
  args JSON, décodage erreur structurée → exit 3 + `error.code`.
- Parité : chaque sous-commande exécutée en mode direct puis `--mcp` →
  sorties `data` identiques (diff ignoré sur champs volatile ts).
- Réel : `dispatch` sur DB de test → gate `EMPTY_MODEL`/`CAPABILITY_-
  MISMATCH` propagés avec exit 3 ; `discipline` → score/status conformes
  aux seuils 80/50/20 ; `kill` → task_events `status=failed` + pid mort.
- `hphe-orch status --pairs` sur DB avec table `pairs` (phase 3).
- Propagation : build release canonique → copie `hphe-orch.exe` vers
  `servers\hephaistos2-kit\bin\` ; `fix-report-2026-10-18.md`.

## Critères d'acceptation

- [ ] `list/dispatch/kill/verify/status/discipline` fonctionnels sans IDE,
      en mode direct et `--mcp`.
- [ ] stdout = JSON valide dans 100 % des cas (succès et erreur) ; exit
      codes conformes au tableau FR-4.5.
- [ ] Aucun accès SQL dans le crate hphe-orch (grep `SELECT|UPDATE|INSERT`
      → zéro hit hors tests) : tout passe par `hphe-kit::orch`.
- [ ] Aucun secret accepté en argument ; `--db` gardé par la racine
      canonique.
- [ ] `cargo check` propre ; binaire propagé canonique → `servers`.

## Risques

- **Dérive de surface** : le CLI expose les mêmes `tool_*` — toute nouvelle
  gate est automatiquement héritée ; risque résiduel = oubli de
  sous-commande pour un nouvel outil (checklist à ajouter au template de
  fix-report).
- **Concurrence DB** : `with_db` utilise une connexion process-local WAL —
  le CLI CLI court n'a pas de contention avec hphe-mcp.exe (WAL
  multi-connexion OK, `busy_timeout` actif).
- **Spawn stdio MCP** : `hphe-mcp.exe` en `--mcp` peut laisser un process
  si timeout → kill explicite du child + timeout 30 s.
- **clap vs parse maison** : clap ajoute ~1 Mo ; si la légèreté prime
  (objectif 2.1), parse argv maison ~150 l. suffit vu le schéma plat —
  décision à l'implémentation, critère : `hphe-orch.exe < 3 Mo` en release.
- **Compat cli-anything-\*** : le `--json` implicite diffère des CLIs qui
  l'exigent — documenté, alias `--json` accepté silencieusement.
