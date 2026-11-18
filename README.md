<p align="center">
  <img src="media/hephaistos-kit_banderole.jpg" alt="Hephaistos2-Kit — The Developer's Forge" width="100%">
</p>

# Hephaistos2-Kit

> **IDE visuel d'orchestration multi-agents** : définis ton équipe d'agents IA
> sur un canvas (rôles, providers, modèles, skills, MCP, services), relie-les
> par des dépendances d'exécution et des edges outils, lance le workflow —
> l'agent chef n'a plus que la supervision à faire.
>
> Moteur : indexation filesystem NTFS ultra-rapide en Rust (`$MFT` + USN),
> serveur MCP unifié (**58 outils**), bridge HTTP/WS temps réel, bus
> inter-agents — sans `Everything.exe`.

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Backend](<https://img.shields.io/badge/backend-Rust%20%24MFT%2BUSN-orange>)
![Canvas](<https://img.shields.io/badge/canvas-React%20Flow-61DAFB>)
![Outils](https://img.shields.io/badge/outils_MCP-58-informational)
![Statut](https://img.shields.io/badge/statut-beta%20publique-yellow)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

**Beta publique** — le kit est fonctionnel sur la machine de dev ; l'installation
reproductible multi-machines est en cours (voir [État de la beta](#état-de-la-beta)).

---

## Sommaire

- [Ce que fait le kit](#ce-que-fait-le-kit)
- [IDE visuel — hephaistos-chats](#ide-visuel--hephaistos-chats)
- [Services externes](#services-externes)
- [Couche agent](#couche-agent)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Extensions VS Code](#extensions-vs-code)
- [Gouvernance et sécurité machine](#gouvernance-et-sécurité-machine)
- [Mémoire unifiée](#mémoire-unifiée)
- [État de la beta](#état-de-la-beta)
- [Documentation](#documentation)

## Ce que fait le kit

| Capacité | Détail |
|---|---|
| **Orchestration visuelle** | Canvas React Flow : pose des cartes agent/service/skill/role, relie par edges exec ou outils |
| **SWAT workflows** | Schémas persistés, switching live, DAG d'exécution, boucles de feedback |
| **Bleubites** | Workers `chat-*` outillés (fs read/write/list confinés workspace), providers free ou perso |
| **Sessions ACP réelles** | Détection des agents IDE ouverts (Devin, Antigravity), injection de prompts, binding carte↔session |
| **Recherche filesystem** | ~6,4M entrées indexées, <50 ms, `content_search`/`semantic_search`/`hybrid_search` |
| **Mémoire unifiée** | KG + vector store + SQLite, outils `memory_*`, séparation workspace/global |
| **Orchestrateur de tâches** | `create_task`/`dispatch_task`/`update_task`, bus `comms.jsonl`, wake-up IDE |
| **Multi-IDE** | Devin Desktop, Antigravity, Cursor — même couche `.agent` propagée par `sync-agent-layer.ps1` |

## IDE visuel — hephaistos-chats

Extension VS Code-fork (`extensions/hephaistos-chats`, VSIX `0.3.59`) :

- **Canvas React Flow** avec minimap : les cartes sont les nœuds, les edges sont
  le routing d'exécution — l'utilisateur définit manuellement l'orchestration.
- **Palettes drag & drop** : agents, skills, rôles, providers, services, cartes préconfigurées.
- **Deux types d'edges** :
  - *exécution* (plein) : dépendances du DAG — l'étape n démarre quand ses parents ont rendu ;
  - *outil* (pointillé, port dédié ⛁) : le service est pré-fetché et son résultat
    injecté dans le prompt du worker (un outil perso pour un agent, ou vers
    l'entrée = tout le SWAT).
- **Inspecteur** : rôle, mission, provider/modèle, paramètres par type de carte.
- **Persistance** : schémas sauvegardés (banque + roster actif), positions React Flow
  conservées, switching de workflow à chaud.
- **Binding ACP** : `workspace-roster` détecte les sessions vivantes (`acp-listed`)
  et lie une carte à une vraie session ; `acp-inject` injecte les missions.
- **Commandes** : `newChat`, `openChat`, `openWorkspace`, `openComfyUI`.

### Cartes service

| Carte | Couleur | Fonction |
|---|---|---|
| `svc/n8n/<workflowId>` | rouge `#EA4B71`, logo n8n | Dropdown **live** des workflows n8n dans l'inspecteur ; invocation via `POST /n8n/workflows/:id/invoke` (secret côté bridge, jamais dans l'extension) |
| `svc/comfyui/<id>` | orange `#F5A623`, logo ComfyUI | Placeholder propre — transports `svc/*` non câblés refusés explicitement par le runner |

## Services externes

- **n8n** (:5678) — workflows packagés (bot Telegram, hub Obsidian, génération
  image, polling `/tg/poll`), lecture DB read-only pour lister les workflows.
- **ComfyUI** — backend Desktop local *et* chemin distant GPU **Kaggle**
  (`kaggle_push`, tunnel Cloudflare nommé, arrêt auto GPU après 10 min d'idle,
  `kaggle-ctl.ps1`). Prompts/negative-prompts forwardés.
- **Providers LLM** — NVIDIA NIM, OpenRouter, OmniRoute, devin-cli,
  antigravity-acp, ollama-cloud : sélection par carte dans l'inspecteur.

## Couche agent

`.agent/` = architecture déclarative propagée aux workspaces :

```
.agent/
├── agents/        # définitions d'agents (frontmatter triggers -> routing auto)
├── skills/        # skills packagées (flux, binome, cli-anything, comfyui…)
├── rules/         # global_rules.md — gouvernance (git, secrets, .agent pas une poubelle)
├── workflows/     # schémas SWAT de référence
├── agent-bridge/  # bridge HTTP/WS, runner SWAT, roster, acp-inject
├── flux/          # /flux : vérifie schéma actif + pipeline revue/sécu/arbitrage/commit
├── scripts/       # install, sync, health, watchers
└── state/, chats/, queue/  # runtime (gitignoré)
```

Principes : secrets jamais commités (`.env`, `*.token`, `local-paths.json`
gitignorés), chemins machine externalisés (`local-paths.js`), `.agent` n'est
pas un dépôt d'artefacts projet.

## Architecture

```
IDE (Devin / AGY / Cursor)
   │  hephaistos-chats (React Flow)          hephaistos-kit-search
   │        │                                     │
   ├──HTTP──┼──► bridge-api :7478 ──┐   ──stdio──► hphe-mcp.exe (58 outils)
   ├──WS────┼──► bus        :7477  │            │
   │        │    ├─ /swat/* runner │            ├─► pipe \.\pipe\hphe-index
   │        │    ├─ /n8n/* svc     │            │     ► hphe-indexd (SYSTEM)
   │        │    ├─ /tools/call    │            │     $MFT ~6,4M + USN + mmap
   │        │    └─ /diagnostics   │            ├─► Tantivy (content index)
   │        └─► MCP gateway :8767  │            ├─► usearch (vec 2048D)
   │                               │            └─► orchestrator.db + memory KG
   └─ACP──► sessions IDE (devin/agy/chat-*) ◄── acp-inject + roster
```

- **`hphe-indexd`** — tâche planifiée SYSTEM : scan `$MFT`, suit le journal USN,
  expose l'index via named pipe.
- **`hphe-mcp`** — serveur MCP stdio unique : recherche, contenu, vecteurs,
  mémoire, orchestrateur, beacon. Absorbe les anciens MCP séparés.
- **`hphe-rest`** (:8792) — REST des mêmes outils + boucle d'ingestion
  (Mutex = sérialisation unique des écritures Tantivy).
- **`agent-bridge`** (:7478 HTTP + :7477 WS) — runner SWAT (DAG + tool edges +
  pre-fetch `svc/n8n`), roster live, injection ACP, diagnostics.

## Installation

```powershell
git clone --recurse-submodules https://github.com/art-qalam-fr/hephaistos2-kit.git
cd hephaistos2-kit
pwsh -ExecutionPolicy Bypass -File install.ps1          # build + deploy runtime
```

Prérequis : Windows 10/11 NTFS, PowerShell 7, Rust stable (`cargo`), Node ≥20,
un VS Code-fork compatible ACP. Droits admin uniquement pour la tâche
planifiée `hphe-indexd` (`-Elevated`). Détails : [INSTALL.md](INSTALL.md),
manifeste déclaratif [kit.toml](kit.toml).

## Configuration

| Élément | Mécanisme |
|---|---|
| Secrets (clés API) | variables d'env / prompt — **jamais** en dur ; modèle [.env.example](.env.example) |
| Chemins machine | `local-paths.json` gitignoré, lu par `local-paths.js` |
| Accès MCP par profil | [.mcp-access](.mcp-access) — règles `allow`/`read`/`deny` à tokens `<INSTALL_ROOT>` |
| Bridge | tokens `.agent/ws-bridge.token` / `HPHE_REST_TOKEN` (générés, gitignorés) |


## Extensions VS Code

| Extension | Source | Rôle |
|---|---|---|
| `hephaistos-chats` | `extensions/hephaistos-chats` (in-repo) | IDE visuel — canvas React Flow, cartes agents/services, SWAT, roster ACP |
| `hephaistos-kit-search` | `extensions/search-ext` (sous-module) | Recherche NTFS dans l'IDE, embarque le MCP |
| `orchestrator-monitor` | `extensions/orchestrator-monitor` (sous-module) | Panel agents/tâches/providers, wake-up bridge, bus multi-workspaces |
| `postdev` | VSIX packagé (`extensions/vsix/postdev-1.2.3.vsix`) | Utilitaires post-dev ; source externe, publication en cours |

Fiches techniques : [docs/VSIX.md](docs/VSIX.md).

## Gouvernance et sécurité machine

- **Mutex Single-Flight ACP** — verrou par `providerId/sessionId` (TTL 120 s) : pas de cascades dupliquées.
- **Throttle CLI** — 2 workers CLI max simultanés, priorité `BELOW_NORMAL`.
- **Anti-zombies** — `tools/reap-and-reconcile.ps1` + `reconcile_tasks`/`reap_ghosts`.
- **`.agent` n'est pas une poubelle** — artefacts projet hors du layer (règle gravée dans `global_rules.md`).

## Mémoire unifiée

`AGENT_DB_ROOT` → racine mémoire (`<AGENT_DB_ROOT>\current_workspace\<projet>`). Junction locale `memory-database/` créée par `start-workspace.ps1`. Écritures uniquement via outils `memory_*` / `sqlite-node`.

## État de la beta

✅ Orchestration visuelle, SWAT runner, edges outils, cartes n8n/ComfyUI, bridge, MCP 58 outils — fonctionnels et testés (16/16 bridge, 14/14 extension).

⚠️ Limites connues : les sous-modules (`hphe`, `search-ext`, `orchestrator-monitor`, `postdev`) pointent des dépôts privés en cours de publication ; quelques chemins par défaut restent à paramétrer par machine ; install reproductible en cours de durcissement.

## Documentation

| Doc | Contenu |
|---|---|
| [INSTALL.md](INSTALL.md) | Installation pas à pas |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) | Référence des 58 outils |
| [docs/VSIX.md](docs/VSIX.md) | Extensions : build, version, install |
| [.agent/ARCHITECTURE.md](.agent/ARCHITECTURE.md) | Architecture de référence |
| [docs/wiki/](docs/wiki/) | Wiki projet |
| [AGENTS.md](AGENTS.md) | Protocole agents (Cash/Tango/Bleubites) |

## Rollback

Serveurs legacy archivés dans `_archive/` et `%ProgramFiles%\servers\servers_backup\`. Successeur de `everything-mcp` v1 et `Hephaistos-Kit` v1.

---

*The Developer's Forge — forge ton équipe d'agents, supervise.*
