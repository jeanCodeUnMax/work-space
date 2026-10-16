# PRD — Hephaistos Engine (`hphe-*`)

> Product Requirements Document — implémentation du moteur de recherche/indexation
> autonome et unifié, selon la décision arrêtée le 2026-10-12 (cf.
> [03-FAISABILITE-UNIFICATION §0](03-FAISABILITE-UNIFICATION.md)).
>
> **Principe directeur** : chaque phase est livrable, testable et réversible en
> isolation. Rien n'est branché sur l'infrastructure vivante avant d'avoir prouvé
> sa parité — le système actuel (Everything.exe, Qdrant, Zvec, SQLite, MCP
> Python) reste intact pendant toute la construction (« troisième jambe de
> bois »). Bascule finale = variables d'environnement + procédure de rollback.

---

## 1. Objectifs

| # | Objectif | Mesure de succès |
|---|---|---|
| O1 | Remplacer `Everything.exe` : même vélocité de recherche fichier, moteur détenu | Bench parité : p50 ≤ 150 ms sur 15,8 M entrées ; 0 appel WM_COPYDATA restant |
| O2 | Ajouter la recherche de contenu (BM25) — capacité absente aujourd'hui | `content:"..."` en ms sur racines autorisées |
| O3 | Embarquer la recherche vectorielle (`usearch`) — supprimer Qdrant `:6333` + Zvec `:8001` | recall@10 ≥ 0,95 vs Qdrant sur vecteurs exportés ; 2 ports fermés |
| O4 | Unifier les MCP : `hphe-mcp.exe` sert `fs_*` + `everything_*` + `memory_*` + `semantic_*` | 1 binaire remplace 4 processus (everything-mcp, agentmemory, sqlite-node stores, Qdrant/Zvec clients) |
| O5 | Requêtes hybrides natives (nom + contenu + vecteur + métadonnées) en un appel | `hybrid_search` < 100 ms p50 ; fusion in-proc (plus de `fusion.py` côté client) |
| O6 | Watch temps réel → ingestion RAG incrémentale | Fichier modifié → ré-indexé < 5 s |
| O7 | Zéro dépendance externe dans le VSIX (ni Everything, ni Python) | Installation propre sur machine vierge testée |

### Non-objectifs

- Pas de GUI (l'extension VS Code reste l'interface).
- Pas de migration des données SQLite (mêmes fichiers, servis par rusqlite).
- Pas de portage du KG dans le démon (scénario D écarté).
- Pas de FAT32/exFAT/réseau en v1 (NTFS uniquement ; fallback traversal existant).
- Pas de ré-embedding : export/import des vecteurs existants.
- `orchestrator.db` : hors scope — accès exclusif Orchestrateur MCP.

---

## 2. Architecture cible (figée)

```
┌──────────────────────────── hphe-indexd.exe ────────────────────────────┐
│ Service Windows ÉLEVÉ — le seul composant privilégié                     │
│  ├─ MFT reader     : \\.\X: → FILE records (fixup, $FILE_NAME, $DATA…)  │
│  ├─ file index SoA : colonnes contiguës + name blob lowercase           │
│  ├─ USN deltas     : FSCTL_READ_USN_JOURNAL en continu + wrap recovery  │
│  ├─ tantivy        : index contenu BM25 + champs colonnes               │
│  ├─ usearch        : collections HNSW 2048D + 384D (mmap, quanti i8/f16)│
│  ├─ snapshot       : mmap persisté → warm start ~1-3 s                  │
│  └─ pipe API       : \\.\pipe\hphe-index (ACL) — NDJSON                 │
│      verbs: query count status rebuild watch content hybrid vec_*       │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ pipe local (pas de port réseau)
┌──────────────────────────────▼──────────────────────────────────────────┐
│ hphe-mcp.exe — MCP stdio NON ÉLEVÉ (remplace server.py + agentmemory +  │
│                sqlite-node stores + clients Qdrant/Zvec)                 │
│  ├─ fs_*          : port Rust de fs_tools.py + policy .mcp-access       │
│  ├─ everything_*  : client pipe → démon (même contrat qu'aujourd'hui)   │
│  ├─ memory_*      : rusqlite bundled → memory_mcp.db / graph-memory.db  │
│  ├─ semantic_*    : client pipe → usearch (search/upsert/delete/stats)  │
│  ├─ hybrid_*      : requête unique nom+contenu+vecteur+filtres          │
│  └─ caches        : rusqlite runtime-cache.db / option redb             │
└──────────────────────────────────────────────────────────────────────────┘

Reste inchangé : extension VS Code (parle aux tools MCP), fichiers .db SQLite,
Orchestrateur MCP + orchestrator.db, génération embeddings NVIDIA NIM.
Supprimé    : Everything.exe, Qdrant, Zvec, MCP agentmemory, sqlite-node
              (stores mémoire), server.py + dépendance Python.
```

### Stack Rust arrêtée

| Rôle | Choix | Alternative / fallback |
|---|---|---|
| MFT/NTFS | `ntfs` crate si suffisante, sinon reader maison (spec 01) | — |
| Scan substring | `memchr` SIMD + `regex` | `memmap` pour warm start |
| Contenu BM25 | `tantivy` | — |
| Vecteurs | `usearch` (cœur C++ statique) | `hnsw_rs` / `tantivy` seul / `zvec-rust` |
| SQLite | `rusqlite` feature `bundled` | — |
| KV caches | `redb` (optionnel) | conserver `rusqlite` |
| Service | `windows-service` ou tâche planifiée HIGHEST | — |
| Pipe | `named_pipe`/`interprocess` + ACL | — |
| Parallélisme | `rayon` (scan multi-cœurs) | — |
| Async MCP | `tokio` | threads simples si suffisant |

---

## 3. Phases détaillées

### P0 — POC lecteur MFT *(gate go/no-go)*

Objectif : prouver que lire `\\.\C:` + parser les FILE records donne >95 % des
entrées avec taille + 3 timestamps exactes.

- [ ] `cargo new` workspace `hphe/` (crates : `hphe-mft`, `hphe-index`, `hphe-daemon`, `hphe-mcp`)
- [ ] Évaluer crate `ntfs` : couvre-t-elle fixup USA, `$MFT` fragmenté (retrieval pointers), `ATTRIBUTE_LIST`, hardlinks ?
- [ ] CLI `hphe-mft scan C: --stats` → nb records, durée, RAM
- [ ] Comparer le compte vs `everything_count` (échantillons par volume)
- [ ] Doc `bench/p0.md` : mesures + décision crate (maison vs ntfs)

**Critère de sortie :** ≥ 95 % des entrées trouvées, métadonnées complètes,
lecture C: < 60 s. *Si échec → arrêt, coût support = POC seule.*

### P1 — Index fichier + deltas USN + pipe

- [ ] Index SoA : colonnes `name_lower | parent_frn | size | mtime | atime | ctime | attrs | flags`
- [ ] Résolution chemins parent→path (lazy + mémo) ; cascade rename dossier
- [ ] Query engine : parser syntaxe Everything (sous-ensemble `query_parser.py` porté) → prédicats compilés ; substring `memchr` SIMD ; wildcards ; `regex:` ; `ext:` `size:` `dm:` `path:` `folder:` `file:` ; tri multi-colonnes ; early exit `max_results`
- [ ] Boucle USN : `FSCTL_READ_USN_JOURNAL` continu, détection wrap/`UsnJournalID` change → rebuild ciblé
- [ ] Snapshot binaire + mmap warm start
- [ ] Named pipe `\\.\pipe\hphe-index` + ACL + proto NDJSON (`query`, `count`, `status`, `rebuild`)
- [ ] CLI de test `hphe-cli query "dots folder:"`

**Critère de sortie :** bench maison — latence ≤ Everything sur la suite de
requêtes de `docs/wiki/Benchmarks.md` ; RAM index ≤ ~3 Gio ; survie au wrap
journal simulé.

### P2 — Service + bascule backend + parité outils

- [ ] Packaging service Windows (démarrage auto, restart on crash, logs)
- [ ] `server.py` : backend `hphe` (client pipe) à côté du backend `everything`,
  sélection par `HPHE_BACKEND=hphe|everything` (défaut `everything`)
- [ ] Suite de parité : les 18 tools MCP produisent résultats équivalents sur
  les deux backends (test automatisé comparatif)
- [ ] Benchmarks documentés `bench/p2.md`

**Critère de sortie :** `HPHE_BACKEND=hphe` passe la suite de parité à 100 % ;
Everything.exe n'est plus sollicité quand le flag est posé.

### P3 — Index contenu BM25 + watch → RAG

- [ ] `tantivy` sur racines autorisées ; schéma `path | file_id | mtime | content | ext | project_tag`
- [ ] Ingest incrémentale pilotée par le watch stream USN (`mtime`/`size` change → re-chunk)
- [ ] `.ragignore` + `.mcp-access` appliqués à l'ingest ; filet secrets (`*.pem`, `*.db`, `.env`…)
- [ ] Verbe pipe `content` + tool MCP `fs_search_content`
- [ ] Bascule `beacon_ingest` : watch stream au lieu de scans périodiques

**Critère de sortie :** `content:"retry policy"` retourne en ms ; fichier
modifié → ré-indexé < 5 s ; ingestion Beacon live validée sur workspace test.

### P4 — Vecteurs `usearch` + migration + décommission

- [ ] Store usearch : collection `knowledge_2048` (5 domaines : code/doc/config/workflow/skill) + `semantic_384` (6 index : entities/concepts/actions/relations/context/learning_insights)
- [ ] Script export : scroll API Qdrant + dump Zvec → fichiers vecteurs (id + payload + vector)
- [ ] Import usearch + indexation ; **bench recall@10 ≥ 0,95 vs Qdrant** sur requêtes réelles
- [ ] Verbe pipe `hybrid` : fusion native BM25 + ANN 2048D + ANN 384D + boost KG + filtres colonnes (remplace `fusion.py` côté client — poids recalibrés sur bench)
- [ ] `semantic-cache.db` absorbé (TTL porté)
- [ ] **Décommission** : arrêt services Qdrant `:6333` et Zvec `:8001` ; snapshots conservés en archive ; flag rollback documenté

**Critère de sortie :** recall parity validée, 2 ports fermés, requêtes
sémantiques servies par le démon. *Fallback si recall < 0,95 : évaluer
`hnsw_rs`, `tantivy` seul, ou `zvec-rust` embarqué avant de garder Qdrant.*

### P5 — MCP unifié `hphe-mcp.exe`

- [ ] Port Rust de `server.py` : NDJSON JSON-RPC stdio, 18 tools `everything_*`/`fs_*`/`search` — contrat identique
- [ ] Port Rust de `fs_tools.py` + `.mcp-access` + profils `EVERYTHING_MCP_AGENT`
- [ ] Tools `memory_*` via `rusqlite` bundled sur `memory_mcp.db`/`graph-memory.db` (mapping 1:1 des outils agentmemory : create_entities, add_observations, create_relations, search_nodes, read_graph…)
- [ ] Tools `semantic_*`/`hybrid_*` → client pipe démon
- [ ] Caches : `runtime-cache.db` via rusqlite (option `redb` si bench le justifie)
- [ ] Bascule config MCP clients → `hphe-mcp.exe` unique

**Critère de sortie :** 1 binaire = 4 processus retirés ; extension et agents
in changés ; tests e2e tools mémoire + fichier + sémantique verts.

### P6 — Packaging VSIX + durcissement

- [ ] Installateur service élevé (port de `elevated_setup.ps1` → service)
- [ ] VSIX bundle `hphe-mcp.exe` ; suppression `spawn python` (fin `ENOENT`)
- [ ] Runbook rollback : ré-installer Everything + flag backend + restore services Qdrant/Zvec depuis snapshots
- [ ] Docs wiki : Architecture, Benchmarks, migration
- [ ] Audit sécurité final : ACL pipe, racines, secrets non indexés

**Critère de sortie :** installation propre sur machine vierge ; audit
`security-auditor` passé ; runbook rollback exercé une fois.

---

## 4. Matrice de délégation — Orchestrateur MCP

Toutes les tâches passent par l'Orchestrateur (`create_task`/`dispatch_task`,
session tag **`devin-hphe-engine-2026-10-12`**). Jamais d'accès direct à
`orchestrator.db`. Règle maison : délégation via `dispatch_task` (skill → agent
→ modèle free live → prompt de rôle) ; `worktree: true` pour les tâches de code
(isolation `.kilo/worktrees/task-<id>`).

### Roster actif (décision 2026-10-12, amendée même jour)

| Agent | Transport | Providers | Rôle |
|---|---|---|---|
| `agy` | Antigravity CLI (abonnement) | antigravity-subscription | Défaut — tout type de tâche, toujours dispo |
| `vibe` | Mistral Vibe CLI | mistral-vibe (`devstral-2`) | Code/review/docs/test/refactor — requêtes **illimitées** |
| `kilo-nim1` | KiloCode CLI → NIM | nvidia-nim, nvidia-nim2 | Canal NIM agentique — **validé : T-002 livré en ~3 min** (#309) |
| `ollama-cloud` | Hermes CLI (scopé provider) | ollama-cloud | Forfait payé — **1 connexion à la fois** |
| `devin` | agent principal | — | Couture : intégration server.py, packaging, décommission |

**Modèles NIM — deux voies autorisées** (règle 2026-10-12) :
- **Agentique** (tâche orchestrée avec outils fichiers) → `kilo-nim1` (dispatch_task),
  transport KiloCode validé par la livraison T-002.
- **Non-agentique** (raisonnement, rédaction, embeddings, sous-appels invoqués par
  Devin ou un agent CLI) → outils `nim_*` du MCP **nim-router** en direct
  (`nemotron-3-super-120b`, `lightning-30b`, `ultra-550b`, `embed-1b`,
  multi-appels concurrents sur la même clé).

**Désactivés** (`active: 0`) : `kilo`, `kilo-free`, `hermes` — dernier recours
absolu uniquement, et alors **avec les modèles NIM exclusivement**.

**Clôture des tâches — règle renforcée (2026-10-12)** : l'orchestrateur
auto-marque `completed` à la sortie du process CLI même sans `update_task`
→ risque de clôture vide (cf. #308). Les 6 templates de rôle exigent
désormais un appel final `update_task` avec `result` (livrables + chemins +
état build/tests) ; `status:'failed'` + explication si blocage. Devin vérifie
systématiquement le livrable **sur disque** avant d'accepter la complétion.

### Tâches prêtes à pousser

| ID | Titre | Phase | `task_type` | Agent proposé | Dépendances |
|---|---|---|---|---|---|
| T-001 | POC lecteur MFT `C:` — stats + décision crate | P0 | `code` | `agy` | — | **FAIT** (#310, mergé `a63b19a` : 8 modules, 10/10 tests, gate GO, scan réel = élevé) |
| T-002 | Éval crates `ntfs`/`usearch`/`tantivy`/`rusqlite`/`redb` | P0 | `explore` | `kilo-nim1` | — | **FAIT** (#309) |
| T-020-prep | Recherche API journal USN (FSCTL, wrap) | P0 | `explore` | `kilo-nim1` | — | **FAIT** (#312) |
| T-010-prep | Design index SoA (layout, memchr, paths) | P0 | `explore` | `kilo-nim1` | — | **FAIT** (#313) |
| T-010 | Index SoA + scan `memchr` SIMD + résolution paths | P1 | `code` | `vibe` | T-001 | **FAIT** (#314/#315, 1,85 Gio @16M, 1,19 Md l/s, `p1-index.md`) |
| T-011 | Query engine (parser syntaxe Everything → prédicats) | P1 | `code` | `vibe` | T-010 | **FAIT** (ollama #327, 37 tests, `089ba52`, `p1-query.md`) |
| T-020 | Deltas USN continus + wrap recovery | P1 | `code` | `vibe` | T-010 | **FAIT** (vibe+agy #328/#332, `3d1422f` + fix overlay) |
| T-021 | Snapshot mmap + warm start | P1 | `code` | `vibe` | T-010 | **FAIT** (agy #326, `dbbf55d`, 95 ms @1M, `p1-snapshot.md`) |
| T-030 | Named pipe + ACL + proto NDJSON | P1 | `code` | `vibe` | T-010 | **FAIT** (vibe+agy #329/#333, `1bb6524`, `p1-pipe.md`) |
| T-031 | Review sécurité pipe/ACL/snapshot | P1 | `review` | `agy` | T-030 | **FAIT** (devin, `a5e7c62` — fix traversal F1 + cap limit F2, `p7-security.md`) |
| T-040 | Backend `hphe` dans `server.py` (client pipe, flag) | P2 | `code` | `devin` | T-030 | **FAIT** (agy #335, `b4da815`, 13/13 tests, fallback Everything.exe) |
| T-050 | Suite parité 18 tools + bench `p2.md` | P2 | `test` | `vibe` | T-040 | **FAIT** (agy #343, `d93e104`, 18/18 conformes, `p5-parity.md`) |
| T-060 | Service Windows + watchdog + install | P2 | `code` | `agy` | T-050 | **FAIT** (agy #336, `46c2e34`) |
| T-070 | Index contenu `tantivy` + watch→ingest | P3 | `code` | `vibe` | T-020 | **FAIT** (ollama #331, `d3e2134`, 71,6k docs/s, `p3-tantivy.md`) |
| T-071 | Bascule `beacon_ingest` sur watch stream | P3 | `code` | `vibe` | T-070 | **FAIT** (ollama #342, `ea07785`, mode `--watch` + fallback poll, 9/9 pytest) |
| T-080 | Store `usearch` 2048D/384D + verbe `hybrid` | P4 | `code` | `vibe` | T-030 | **FAIT** (ollama #334, recall@10 0.995, `p4-vec.md`) |
| T-081 | Export Qdrant/Zvec → import + recall@10 parity | P4 | `code` | `vibe` | T-080 | **FAIT** (ollama #337 + devin, toléré 1.0000 ×5 coll., `p4-real.md`) |
| T-082 | Décommission Qdrant/Zvec + runbook rollback | P4 | `code` | `devin` | T-081 | **FAIT infra** (devin, `hphe-vec import` + `p8-migration.md`, 23,7k vec migrés — bascule applicative et decommission = étapes opérationnelles documentées) |
| T-090 | Port `hphe-mcp.exe` (fs_*, policy, memory_*, semantic_*) | P5 | `code` | `agy` | T-040 | **FAIT** (agy #338, `5f186d5`, 18 outils + stubs V1 content/vec/memory) |
| T-091 | Tests e2e MCP unifié | P5 | `test` | `vibe` | T-090 | **FAIT** (agy #341, `e186382`, 1049 l e2e, `p5-e2e.md`) |
| T-100 | VSIX packaging + suppression `spawn python` | P6 | `code` | `devin` | T-060, T-091 | **FAIT** (ollama #344, `228d81d`, vsix 1.75 MB autonome, preferHphe) |
| T-092 | Vrais outils content/vec/hybrid dans hphe-mcp | P5 | `code` | `agy` | T-090 | **FAIT** (agy #345, `7ec1800`, stubs V1 remplacés, `p5-tools.md`) |
| T-110 | Docs wiki + runbook rollback final | P6 | `docs` | `ollama-cloud` | T-100 | **FAIT** (devin, `RUNBOOK.md` + p7/p8) |
| T-120 | Audit sécurité final (pipe, racines, secrets) | P6 | `review` | `agy` | T-100 | **FAIT** (devin, `p9-audit-final.md` — PASS, F1/F2 corrigés) |

### Rôle de Devin (agent principal)

Conformément aux règles : Devin garde **architecture, contrats, synthèse,
validation finale, gestion des conflits**. Les tâches marquées `devin`
(intégration `server.py`, décommission services, packaging VSIX) sont les points
de couture où le contexte local est critique.

### Fallback si l'Orchestrateur est défaillant

L'orchestrateur « tourne sur trois pattes » — plan B documenté :

1. `create_task` + `update_task` manuels (registry des tâches sans dispatch auto)
2. `suggest_agent(task_type)` pour confirmer l'agent
3. Appel CLI direct en dernier recours :
   `agy.exe --dangerously-skip-permissions --print="{msg}"`,
   `vibe.exe -p "{msg}" --max-turns 40`,
   `kilo run -m "{nim-model}"` ou `hermes -z "{msg}" -m "{nim-model}"`
   (dernier recours, **modèles NIM uniquement**)
4. Personas `.agent/agents/*.md` comme lentilles de review (security-auditor
   pour T-031/T-120, performance-optimizer pour les benches, database-architect
   pour le schéma tantivy/usearch, test-engineer pour T-050/T-091)

---

## 5. Métriques cibles

| Métrique | Cible | Référence actuelle |
|---|---|---|
| Latence query fichier p50 | ≤ 100 ms | Everything ~50-150 ms |
| Build à froid (MFT, 4 volumes) | < 2 min total | Everything : s→dizaines de s |
| Warm start (snapshot mmap) | < 3 s | — |
| RAM démon (index + contenu + vecteurs) | ≤ 6 Gio | Everything ~600 Mo + Qdrant + Zvec séparés |
| `hybrid_search` p50 | < 100 ms | Aujourd'hui : 3 appels + fusion client |
| Ré-indexation après modif fichier | < 5 s | Beacon : scan périodique |
| Processus runtime | 2 | 5+ (python MCP, Everything, Qdrant, Zvec, agentmemory) |
| Ports réseau locaux exposés | 0 | `:6333`, `:8001` |

---

## 6. Risques et rollback

| Risque | Mitigation | Rollback |
|---|---|---|
| POC MFT insuffisant (records manquants) | Gate P0 ; crate `ntfs` évaluée avant maison | Arrêt sans coût — infra intacte |
| Goulot RAM vecteurs 2048D | Quantification `i8`/`f16` usearch ; mmap on-disk | Garder Qdrant jusqu'au bench |
| Recall vectoriel < Qdrant | Bench parity obligatoire P4 ; fallbacks `hnsw_rs`/`zvec-rust` | Ne pas décommissionner |
| Fuite de privilèges via pipe | ACL stricte + review T-031/T-120 | Démon arrêté, backend `everything` |
| Orchestrateur instable | §4 fallback : create_task manuel → CLI direct | n/a |
| Corruption snapshot | Rebuild from MFT + deltas USN ; validation CRC | Snapshot supprimé → cold rebuild |
| Fraîcheur contenu (BM25 ≠ USN speed) | Watch prioritaire par mtime ; « quasi-live » accepté | Re-scan périodique Beacon |

**Rollback global** : à toute phase ≤ P5, revenir = `HPHE_BACKEND=everything`
(ou config MCP d'origine) — les systèmes remplacés ne sont arrêtés qu'après
validation de la phase suivante. Everything reste installé jusqu'à P6 validé.

---

## 7. Prochaine action

Pousser **T-001 + T-002** dans l'Orchestrateur (session
`devin-hphe-engine-2026-10-12`) dès GO utilisateur :

```text
orchestrator.dispatch_task(
  title="POC lecteur MFT C: — stats + décision crate",
  task_type="code", agent_name="agy", worktree=true,
  files=["docs/hephaistos-engine/01-SPEC-MOTEUR.md",
         "docs/hephaistos-engine/04-PRD.md",
         "_obsolete/ntfs_index.py"],
  workspace="<workspace-du-projet>",
  session="devin-hphe-engine-2026-10-12")
```

Puis T-002 (`explore`, `hermes`) en parallèle — évaluation crates indépendante.
