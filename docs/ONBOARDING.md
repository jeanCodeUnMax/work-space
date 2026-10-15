# ONBOARDING — accueillir Hephaistos2-Kit dans `projet-temporaire`

Guide pour recevoir, cloner et faire tourner le projet dans l'organisation.

## Le projet en 30 secondes

**Hephaistos2-Kit** = plateforme Windows de recherche filesystem ultra-rapide
pour agents IA. Un démon Rust lit directement le `$MFT` NTFS (~6,4 M entrées)
et suit le journal USN en continu → recherches en **< 50 ms** sur tout le PC,
**sans Everything.exe**. Un serveur MCP unique (`hphe-mcp`, **58 outils**)
couvre recherche, contenu (Tantivy), vecteurs (usearch), orchestration
multi-agents, routage NIM, mémoire unifiée et ingestion.

## Structure des dépôts

```
projet-temporaire/
├── hephaistos2-kit            ← UMBRELLA (ce guide, docs, install.ps1, tests)
│   └── .gitmodules pointe sur les 3 sous-modules ci-dessous
├── hephaistos2-engine         ← hphe/ : workspace Rust (indexd, mcp, rest, kit)
├── hephaistos2-search-ext     ← extension/ : ext VS Code recherche (VSIX 1.0.3)
├── hephaistos2-monitor-ext    ← extensions/orchestrator-monitor/ (VSIX 0.0.33)
└── (intégré) .agent/          ← scripts, agents, skills, workflows — dossier du repo
```

Miroir personnel complet : `lascard-m/hephaistos2-*` (mêmes commits, même tag).

| Repo | Remote dev | Remote perso | Tag |
|---|---|---|---|
| umbrella | `projet-temporaire/hephaistos2-kit` | `lascard-m/hephaistos2-kit` | `v2.0.0` |
| engine | `projet-temporaire/hephaistos2-engine` | `lascard-m/hephaistos2-engine` | `v2.0.0` |
| search-ext | `projet-temporaire/hephaistos2-search-ext` | `lascard-m/hephaistos2-search-ext` | `v2.0.0` |
| monitor-ext | `projet-temporaire/hephaistos2-monitor-ext` | `lascard-m/hephaistos2-monitor-ext` | `v2.0.0` |

## Clonage

```powershell
git clone --recurse-submodules https://github.com/projet-temporaire/hephaistos2-kit.git
# ou après clone simple :
git submodule update --init --recursive
```

## Installation (PROJET → INSTALL)

Le projet vit en `C:\Program Files\Projet-complet\hephaistos2-kit` (sources),
le runtime en `C:\Program Files\servers\hephaistos2-kit` (binaires + data) :

```powershell
pwsh -ExecutionPolicy Bypass -File install.ps1            # build + deploy
pwsh -ExecutionPolicy Bypass -File install.ps1 -Elevated  # + tâche hphe-indexd
```

Détail complet : [INSTALL.md](../INSTALL.md).

## Sécurité — ce qui n'entre JAMAIS dans le repo

`.env` réel (ignoré ; `.env.example` fourni), clés API (HKCU env vars
uniquement), `data/`, `target/`, `*.db`, logs, `memory-database/` (junction),
`.kilo/` worktrees, `comms.jsonl`. Le `.ragignore` exclut `_archive/` et les
artefacts de l'ingestion. Scan de secrets obligatoire avant tout push
(cf. `docs/wiki/Security.md`).

## Où sont les choses

- **Serveur MCP** : `Hephaistos-everything-search` → `INSTALL\extension\server\hphe-mcp.exe`
- **REST/health** : `http://127.0.0.1:8792/health` (`ingest_busy`, `pipe_connected`)
- **Démon index** : tâche planifiée `hphe-indexd` (SYSTEM), pipe `\\.\pipe\hphe-index`
- **Orchestrateur** : `INSTALL\data\orchestrator.db` (provider_prefs = ordre des providers)
- **Mémoire** : `AGENT_DB_ROOT` (`.env`) → `F:\Sqlite-DB\current_workspace`
- **Rollback** : `servers\servers_backup\` (legacy) + `_archive/` (projet)

## Contribution rapide

- Code Rust → `hephaistos2-engine` (sous-module `hphe/`)
- Kit agent (scripts, skills, workflows) → `.agent/` (intégré, pas de sous-module)
- Extensions → leur sous-module respectif
- Docs transverses, install, tests → umbrella `hephaistos2-kit`

Chaque sous-module se commit/push indépendamment ; l'umbrella enregistre le
gitlink (`git add <sous-module>`) puis push.
