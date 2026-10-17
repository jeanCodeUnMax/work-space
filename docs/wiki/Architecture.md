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
                                 KG        HPHE_MEMORY_ROOT (agentmemory)
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

## Gouvernance des Processus & Sécurité Machine Modeste

Pour préserver la réactivité sur les machines à ressources contraintes (RAM, CPU, GPU) et éradiquer la dérive d'instances orphelines :

- **Mutex Single-Flight ACP (`agent-adapters.js`)** : verrouillage anti-doublon d'injection ACP indexé par `providerId/sessionId`. Expiration par TTL absolu (120 s) et libération systématique dans les blocs `finally`. Interdit l'accumulation de cascades fantômes dans l'IDE.
- **Throttle CLI** : limitation stricte à 2 workers CLI simultanés au niveau de l'orchestrateur. Toute tâche supplémentaire est conservée en statut `pending`.
- **Priorité Système Légère** : tous les sous-processus CLI s'exécutent obligatoirement sous la classe de priorité `BELOW_NORMAL_PRIORITY_CLASS`.
- **Supervision & Nettoyage Réactif** : outils `reap_ghosts` et `reconcile_tasks` exposés nativement par `hphe-mcp`, orchestrés à la demande via le script `tools/reap-and-reconcile.ps1`.
- **Règles d'Architecture** : référence complète et analyse de faisabilité consignées dans `docs/architecture/ETUDE-FAISABILITE-ANTI-ZOMBIES-ACP-CLI.md`.

## PROJET vs INSTALL

| | PROJET | INSTALL |
|---|---|---|
| Chemin | `<repo>` (dossier du clone, libre) | `%ProgramFiles%\servers\hephaistos2-kit` (défaut, `HPHE_INSTALL`) |
| Contenu | sources, `.agent`, git, sous-modules, docs, tests | binaires, `data/`, `migrated-vec/`, junctions |
| Règle | seul endroit où l'on édite | régénéré par `install.ps1`, jamais édité à la main |

Shim de compatibilité historique : `<install>\..\everything-mcp\` = jonctions
vers les deux arbres ci-dessus.
