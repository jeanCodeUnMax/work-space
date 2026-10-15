# Architecture

Trois binaires Rust + deux extensions. Zéro dépendance externe à la recherche.

## Vue d'ensemble

```
IDE / agents (Devin, Antigravity, …)
  │  stdio MCP (NDJSON)                │  HTTP
  ▼                                    ▼
hphe-mcp.exe ◄──── mêmes 58 outils ────► hphe-rest.exe  (127.0.0.1:8792)
  │                                    │  + boucle d'ingestion 900 s
  │                                    │  + gate mutex (file d'écriture)
  ├───────── pipe NDJSON ──────────────┤
  ▼                                    ▼
hphe-indexd (SYSTEM)            stores d'état
  $MFT scan + USN live           Tantivy  data\content-index
  snapshot mmap                  usearch   migrated-vec (2048D)
  \\.\pipe\hphe-index            sqlite    data\orchestrator.db
                                 KG        F:\Sqlite-DB\agentmemory
```

## `hphe-indexd` — le moteur de vélocité

- Tâche planifiée **SYSTEM** (accès direct au volume).
- Scan `$MFT` complet (~6,4 M entrées sur la machine de dev), index SoA en
  mémoire + snapshot mmap pour redémarrage instantané.
- Suit le **journal USN** en continu : l'index est vivant, jamais reconstruit.
- Sert les requêtes sur le named pipe `\\.\pipe\hphe-index` en NDJSON.

## `hphe-mcp` — le serveur unifié

- stdio MCP classique, spawned par l'IDE (`Hephaistos-everything-search`).
- Absorbe les anciens MCP : `orchestrator`, `nim-router`, `model-discovery`,
  `agentmemory`, `qdrant`, `zvec`, pont RAG Python.
- Applique la politique `.mcp-access` + allowlist `EVERYTHING_MCP_ROOTS`
  (noms d'env conservés pour compat).

## `hphe-rest` — passerelle + ordonnanceur d'écriture

- Mêmes outils en HTTP (`GET /tools`, `POST /tools/{name}`, `POST /call`,
  `GET /health` → `status`, `pipe_connected`, `ingest_busy`).
- **Boucle d'ingestion** : `HPHE_INGEST_ROOTS` + registre persistant
  `data/ingest-roots.txt` + découverte `HPHE_INGEST_SCAN` (marqueur `.agent/`),
  cycle `HPHE_INGEST_INTERVAL_S` (900 s).
- **Gate mutex** interne : un seul writer Tantivy. Les appels manuels
  (`content_ingest`, `hephaistos_update[_force]`) sont **mis en file** au
  lieu d'échouer en `LockBusy`. Le gate est pris par racine → attente
  bornée à l'ingest d'une racine.

## PROJET vs INSTALL

| | PROJET | INSTALL |
|---|---|---|
| Chemin | `C:\Program Files\Projet-complet\hephaistos2-kit` | `C:\Program Files\servers\hephaistos2-kit` |
| Contenu | sources, `.agent`, git, sous-modules, docs, tests | binaires, `data/`, `migrated-vec/`, junctions |
| Règle | seul endroit où l'on édite | régénéré par `install.ps1`, jamais édité à la main |

Shim de compatibilité : `C:\Program Files\servers\everything-mcp\` = jonctions
vers les deux arbres ci-dessus.
