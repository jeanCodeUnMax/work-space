# Hephaistos2-Kit

Plateforme unifiée : indexation NTFS native ($MFT + USN) + MCP unique Rust
(**57 outils**) couvrant recherche, contenu, vecteurs, orchestration,
NIM/model-discovery, mémoire et ingestion.

## Layout

```
hephaistos2-kit/
├── hphe/                    # workspace Rust (crates hphe-*)
│   └── crates/hphe-kit/     # orch + models + nim + memory + ingest
├── extension/               # ext VS Code "Hephaistos Everything Search"
│   └── server/              # hphe-mcp.exe, hphe-rest.exe, hphe-indexd.exe
├── extensions/
│   └── orchestrator-monitor/# source ext monitor (UI inchangée)
├── .agent/                  # agents, skills, workflows, knowledge
├── data/                    # content-index Tantivy + orchestrator.db
├── migrated-vec/            # collections usearch 2048D
├── memory-database ->       # jonction F:\Sqlite-DB\current_workspace
├── install.ps1              # installation complète
└── install.cmd
```

## MCP (Devin) : `Hephaistos-everything-search`

`extension/server/hphe-mcp.exe` — stdin/stdout MCP, 57 outils.
CLI direct : `hphe-mcp.exe --tool hephaistos_update --args '{"root":".","force":true}'`

## REST : `hphe-rest` sur 127.0.0.1:8792

Les mêmes 57 outils en HTTP + `/health` + boucle d'ingestion auto
(`HPHE_INGEST_ROOTS`, `HPHE_INGEST_INTERVAL_S`). Autostart : Startup\hphe-rest.cmd.

## Démon : `hphe-indexd` (tâche planifiée SYSTEM)

Scanne $MFT (~6,4M entrées), suit le journal USN en direct, snapshot mmap.
Ancien chemin `servers\everything-mcp\...` → jonctions vers ce répertoire.

## Rollback

`servers/servers_backup/` contient tous les anciens serveurs (orchestrator
Node, agentMemory, nim-router, model-discovery, qdrant, zvec, …).
