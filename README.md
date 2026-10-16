  

<p align="center">
  <img src="media/hephaistos-kit_banderole.jpg" alt="Hephaistos2-Kit — The Developer's Forge" width="100%">
</p>

# Hephaistos2-Kit

> Plateforme unifiée de recherche filesystem **ultra-rapide** pour agents IA :
> indexation NTFS native en Rust (`$MFT` + journal USN), serveur MCP unique
> (**58 outils dans la source**) et boucle d'ingestion REST — **sans `Everything.exe`**.
>
> Le runtime installé reste à 57 outils; par décision utilisateur, le nouveau binaire n'est pas déployé et Beacon reste désactivé.

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Backend](<https://img.shields.io/badge/backend-Rust%20%24MFT%2BUSN-orange>)
![Protocole](<https://img.shields.io/badge/protocole-MCP%20stdio%20%2F%20REST%208792-blueviolet>)
![Outils](https://img.shields.io/badge/outils-58-informational)
![Index](<https://img.shields.io/badge/index%20NTFS-~6%2C4M%20entr%C3%A9es-success>)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

| Chiffres clés       | Valeur                                              |
| -------------------- | --------------------------------------------------- |
| Entrées indexées   | ~6,4 M (démon`hphe-indexd`, 4 volumes NTFS)      |
| Latence de recherche | **< 50 ms** typique, snapshot mmap + USN live |
| Backend              | Rust — aucune dépendance à Everything.exe        |
| Index contenu        | Tantivy (incrémental, file d'attente sérialisée) |
| Transport            | stdio MCP + named pipe + REST`127.0.0.1:8792`     |

Successeur direct de `everything-mcp` v1 (thin client Python sur Everything.exe)
et de `Hephaistos-Kit` v1. Les anciens serveurs sont archivés, pas supprimés —
voir [Rollback](#rollback).

---

## Sommaire

- [Architecture](#architecture)
- [Layout PROJET / INSTALL](#layout-projet--install)
- [Installation](#installation)
- [Configuration MCP](#configuration-mcp)
- [Ingestion](#ingestion)
- [Extensions VS Code](#extensions-vs-code)
- [Orchestrateur et providers](#orchestrateur-et-providers)
- [Mémoire unifiée](#mémoire-unifiée)
- [Rollback](#rollback)
- [Documentation](#documentation)

## Architecture

```
Devin / IDE ──stdio──► hphe-mcp.exe      (58 outils MCP unifiés)
                    ──REST:8792──► hphe-rest.exe   (mêmes outils + /health
                                   + boucle d'ingestion + gate d'écriture)
                                   │
                                   ├─► pipe \\.\pipe\hphe-index ──► hphe-indexd (SYSTEM)
                                   │      $MFT ~6,4M entrées + USN live + mmap snapshot
                                   ├─► Tantivy  INSTALL\data\content-index
                                   ├─► usearch   INSTALL\migrated-vec (2048D)
                                   ├─► orchestrator.db / memory KG
                                   └─► registre ingest-roots.txt (racines persistantes)
```

- **`hphe-indexd`** — tâche planifiée SYSTEM : scan `$MFT`, suit le journal
  USN en direct, expose l'index via named pipe. C'est la source de la
  vélocité de recherche.
- **`hphe-mcp`** — serveur MCP stdio unique. Remplace les anciens MCP
  `orchestrator`, `nim-router`, `model-discovery`, `agentmemory`, `qdrant`,
  `zvec` (tous absorbés en Rust).
- **`hphe-rest`** — passerelle HTTP des mêmes outils + boucle d'ingestion
  automatique. **Point de sérialisation unique** : un `Mutex` interne met
  en file les écritures d'index (`ingest_busy` exposé par `/health`),
  ce qui rend les `LockBusy` Tantivy impossibles.

## Layout PROJET / INSTALL

```
PROJET (dev)  : <repo>/  (dossier du clone — emplacement libre)
├── hphe/                    # workspace Rust (crates hphe-*)
│   └── crates/hphe-kit/     # orch + models + nim + memory + ingest
├── extension/               # ext VS Code "Hephaistos-Kit Search" (VSIX 1.0.3)
│   └── server/              # binaires déployés (miroir de l'install)
├── extensions/
│   └── orchestrator-monitor/# ext monitor (VSIX 0.0.59)
├── .agent/                  # agents, skills, workflows, scripts — LE KIT
├── memory-database ->       # jonction/dossier vers la mémoire ($AGENT_DB_ROOT)
├── install.ps1              # deploy PROJET -> INSTALL (chemins auto-détectés)
└── tests/ docs/ tools/ bench/ _archive/ (héritage v1, non chargé)

INSTALL (runtime) : %ProgramFiles%\servers\hephaistos2-kit\  (défaut;
├── extension/server/        #   surcharge : -InstallRoot / HPHE_INSTALL)
│                            # hphe-mcp.exe, hphe-rest.exe, hphe-indexd.exe + .cmd
├── data/                    # content-index Tantivy + orchestrator.db + logs
│                            #   + ingest-roots.txt (registre persistant)
├── migrated-vec/            # collections usearch 2048D
└── memory-database ->       # jonction/dossier mémoire ($HPHE_MEMORY_ROOT)
```

## Installation

```powershell
pwsh -ExecutionPolicy Bypass -File install.ps1            # build + deploy
pwsh -ExecutionPolicy Bypass -File install.ps1 -Elevated  # + tâche hphe-indexd SYSTEM
pwsh -ExecutionPolicy Bypass -File install.ps1 -SkipBuild # redeploy sans rebuild
```

Étapes détaillées : [INSTALL.md](INSTALL.md). Vérification :

```powershell
curl http://127.0.0.1:8792/health
# {"status":"healthy","pipe_connected":true,"ingest_busy":false,...}
schtasks /query /tn hphe-indexd
```

## Configuration MCP

Nom canonique : **`Hephaistos-everything-search`** (unifié dans Devin).

```json
{
  "mcpServers": {
    "Hephaistos-everything-search": {
      "command": "<INSTALL>\\extension\\server\\hphe-mcp.exe",
      "env": {
        "HPHE_CONTENT_DIR": "<INSTALL>\\data\\content-index",
        "HPHE_VEC_DIR":     "<INSTALL>\\migrated-vec",
        "HPHE_ORCH_DB":     "<INSTALL>\\data\\orchestrator.db",
        "HPHE_MEMORY_ROOT": "<MEMORY_ROOT>",
        "HPHE_PIPE":        "\\\\.\\pipe\\hphe-index"
      }
    }
  }
}
```

(`<INSTALL>` = `%ProgramFiles%\servers\hephaistos2-kit` par défaut ;
`<MEMORY_ROOT>` = `<INSTALL>\data\agentmemory` par défaut.)

`install.ps1` écrit cette entrée automatiquement dans
`%APPDATA%\devin\mcp_config.json` et retire l'ancienne `everything-search`.

Les 58 outils par famille : [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).

## Ingestion

- **Boucle auto** (`hphe-rest`) : `HPHE_INGEST_ROOTS` + registre persistant
  `data/ingest-roots.txt` + découverte `HPHE_INGEST_SCAN` (marqueur `.agent/`),
  cycle `HPHE_INGEST_INTERVAL_S` = 900 s.
- **Démarrage IDE** : `.agent/scripts/start-workspace.ps1` appelle
  `ingest-workspace.ps1` → `POST /tools/content_ingest`. L'appel **attend son
  tour** derrière la boucle (gate Rust) — le script affiche
  *« appel en file d'attente, patience »* au lieu de paraître gelé.
- **Manuel** : `hphe-ingest.cmd`, ou `hephaistos_update` /
  `hephaistos_update_force` via MCP/REST.

Jamais deux writers Tantivy en parallèle : tout passe par `hphe-rest`.

- **Beacon** : `hphe-mcp beacon_ingest` lit le journal JSONL par offset, filtre au workspace et écrit des résumés redacted dans la mémoire HPHE. `beacon.enabled` reste désactivé jusqu’au déploiement du binaire et à l’accord d’activation.

## Extensions VS Code

| Extension                                   | VSIX                                                                 | Rôle                                                                |
| ------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `projet-temporaire.hephaistos-kit-search` | `extension/hephaistos-kit-search-1.0.3.vsix`                       | Recherche NTFS dans l'IDE, embarque le MCP                           |
| `hephaistos.orchestrator-monitor`         | `extensions/orchestrator-monitor/orchestrator-monitor-0.0.59.vsix` | Panel agents/tâches/providers, wake-up bridge, bus multi-workspaces |

Fiches techniques : [docs/VSIX.md](docs/VSIX.md).

## Orchestrateur et providers

L'orchestrateur (`orchestrator.db` + outils `list_agents`/`create_task`/
`dispatch_task`/…) chaîne les providers dans l'ordre :
**antigravity-subscription → mistral-vibe → nvidia-nim → ollama-cloud**.
Le monitor (extension + `ws-bridge` :7477) réveille Devin et Antigravity
à chaque événement de tâche.

## Mémoire unifiée

`AGENT_DB_ROOT` (`.env` ou variable utilisateur HKCU) → racine mémoire de
votre choix (`<AGENT_DB_ROOT>\current_workspace\<projet>\agentmemory`).
Junction locale `memory-database/` créée par `start-workspace.ps1`. Toute
donnée mémoire passe par les outils `memory_*` / `sqlite-node` — jamais
d'écriture directe concurrente (voir `.agent/ARCHITECTURE.md`).

## Rollback

`%ProgramFiles%\servers\servers_backup\` contient les serveurs legacy
complets (orchestrator Node, agentMemory, nim-router, model-discovery,
qdrant, zvec, pont RAG Python) s'ils ont été déployés sur la machine.
`_archive/` dans le projet conserve les scripts et configurations supprimés
de l'arbre v2.

## Documentation

| Doc                                             | Contenu                            |
| ----------------------------------------------- | ---------------------------------- |
| [INSTALL.md](INSTALL.md)                         | Tutoriel d'installation pas à pas |
| [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md)           | Référence des 58 outils          |
| [docs/VSIX.md](docs/VSIX.md)                     | Fiches techniques des extensions   |
| [.agent/ARCHITECTURE.md](.agent/ARCHITECTURE.md) | Architecture de référence        |
| [docs/wiki/](docs/wiki/)                         | Wiki projet                        |
