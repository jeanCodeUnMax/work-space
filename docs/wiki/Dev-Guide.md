# Dev Guide

## Prérequis

- Windows 10/11, **PowerShell 7** (`pwsh`)
- Rust toolchain (stable) — build du workspace `hphe/`
- Python 3.11+ seulement pour les tests (`tests/test_pipe_client.py`, pywin32)
- Compte/agent `lascard-m` authentifié `gh` (push `projet-temporaire` + `lascard-m`)

## Layout (dépôts)

Repo umbrella `projet-temporaire/hephaistos2-kit` + 4 sous-modules :

| Chemin | Repo | Contenu |
|---|---|---|
| `hphe/` | `hephaistos2-engine` | workspace Rust (`crates/hphe-*`) |
| `extension/` | `hephaistos2-search-ext` | ext VS Code recherche + `server/` binaires |
| `extensions/orchestrator-monitor/` | `hephaistos2-monitor-ext` | ext monitor + `ws-bridge` |
| `.agent/` | `hephaistos2-agent` | scripts, agents, skills, workflows, règles |

Commit dans un sous-module → push → puis `git add <chemin>` dans l'umbrella
pour enregistrer le gitlink. Push umbrella ensuite.

## Build & deploy

```powershell
cd hphe ; cargo build --release --workspace   # build seul
pwsh -File ..\install.ps1                     # build + deploy vers INSTALL
pwsh -File ..\install.ps1 -SkipBuild          # redeploy binaires existants
pwsh -File ..\install.ps1 -Elevated           # + tâche hphe-indexd (admin)
```

`install.ps1` copie `hphe-mcp.exe`, `hphe-rest.exe`, `hphe-indexd.exe` vers
`INSTALL\extension\server\` (+ miroir projet), régénère les `.cmd`, écrit la
config MCP Devin, crée l'autostart REST et la tâche planifiée.

## Tests & smoke

```powershell
# pipe protocol (Python, faux serveur)
python -m pytest tests/test_pipe_client.py

# santé runtime
curl http://127.0.0.1:8792/health        # status/pipe_connected/ingest_busy
curl http://127.0.0.1:8792/tools | python -m json.tool | findstr /c:"name"

# smoke recherche
curl -X POST http://127.0.0.1:8792/tools/everything_search -d '{"query":"install.ps1","max_results":3}' -H "Content-Type: application/json"
```

## Workflow git

- `main` = branche par défaut (stable, tag `v2.0.0` posé)
- `dev` = ex-branche de travail (conservée à distance, non requise)
- Convention commit : `type(scope): message` (historique en français)
- **Avant push** : `git status` + scan secrets (patterns `nvapi-`, `sk-`,
  `ghp_/gho_`, `AIza`, `AKIA`, `PRIVATE KEY`) + `.env` hors index

## Règles propres au projet

- JAMAIS d'édition directe de `C:\Program Files\servers\hephaistos2-kit` —
  c'est du runtime régénéré par `install.ps1`.
- JAMAIS d'ingestion lancée à la main pendant le dev — la boucle
  `hphe-rest` + la tâche IDE s'en chargent ; le gate sérialise.
- `memory-maintenance` reste un writer SQLite externe — point d'attention
  connu (contention pendant les gros ingests ; voir `.agent/ARCHITECTURE.md`).

## Points d'entrée code

| Sujet | Fichier |
|---|---|
| routes REST + gate ingest | `hphe/crates/hphe-mcp/src/rest.rs` |
| registry des 57 outils | `hphe/crates/hphe-mcp/src/tools/` |
| orchestrateur (tasks/agents/dispatch/worktrees) | `hphe/crates/hphe-kit/src/orch.rs` |
| protocole pipe | `hphe/crates/hphe-ipc/src/protocol.rs` |
| daemon index | `hphe/crates/hphe-daemon/` (+ `hphe-index`, `hphe-mft`, `hphe-usn`) |
| extensions | `extension/src/`, `extensions/orchestrator-monitor/src/` |
