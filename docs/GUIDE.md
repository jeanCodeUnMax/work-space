# Guide local — Hephaistos2-Kit

Recherche filesystem ultra-rapide pour agents IA — index NTFS natif en Rust
(`$MFT` + USN), MCP unifié **57 outils**, REST :8792, sans `Everything.exe`.

## Composants

| Composant | Rôle | Chemin |
|---|---|---|
| `hphe-indexd` | démon SYSTEM : scan $MFT + USN live, pipe `\\.\pipe\hphe-index` | `INSTALL\extension\server\` |
| `hphe-mcp` | serveur MCP stdio (57 outils) — spawné par l'IDE | idem |
| `hphe-rest` | passerelle HTTP :8792 + boucle d'ingestion + gate d'écriture | idem |
| ext search | VSIX `hephaistos-kit-search` 1.0.3 | `extension/` |
| ext monitor | VSIX `orchestrator-monitor` 0.0.54 (panel + ws-bridge :7477) | `extensions/orchestrator-monitor/` |
| `.agent/` | kit agents/skills/scripts (intégré au repo) | racine |

## Prérequis

- Windows, PowerShell 7 (`pwsh`)
- `hphe-indexd` installé en tâche planifiée SYSTEM (`install.ps1 -Elevated`)
- Aucun droit admin requis pour les recherches (le démon porte les droits)

## Cycle de vie type

1. `install.ps1` → build Rust + deploy + config MCP Devin
2. `hphe-indexd` démarre (SYSTEM), charge/snapshot l'index MFT
3. `hphe-rest` démarre (Startup folder), boucle d'ingestion 900 s
4. À l'ouverture IDE : tâche `start-workspace.ps1` → junction mémoire +
   `content_ingest` via REST (mis en file si la boucle écrit)
5. Agents → outils `everything_search` / `content_search` / `fs_*` / `memory_*`

## Vérification rapide

```powershell
curl http://127.0.0.1:8792/health     # status, pipe_connected, ingest_busy
schtasks /query /tn hphe-indexd       # démon actif ?
```

## Documentation

- `INSTALL.md` — installation pas à pas
- `docs/MCP-TOOLS.md` — référence 57 outils
- `docs/VSIX.md` — fiches des extensions
- `docs/ONBOARDING.md` — accueil du projet dans l'org
- `docs/wiki/` — wiki complet
- `.agent/ARCHITECTURE.md` — architecture de référence

## Retraité (v1)

Python `server.py`/`fs_tools.py`, pont RAG, MCPs externes (qdrant, zvec,
orchestrator Node, agentMemory, nim-router, model-discovery) → `_archive/`
+ `servers\servers_backup\`. Ne plus lancer.
