# Faisabilité — intégration au Hephaistos-Kit et unification des bases

> Deux questions distinctes :
> 1. Le moteur (`hphe-indexd`) peut-il s'intégrer au système d'indexation du
>    Hephaistos-Kit (pipeline RAG, Beacon, mémoire unifiée) ?
> 2. Peut-on remplacer **en partie ou en totalité** l'architecture de stockage
>    actuelle (Qdrant + Zvec + SQLite) par un système intégré dans ce processus ?

**Réponse courte :** l'intégration est non seulement faisable, c'est l'argument
le plus fort du projet. Le remplacement total est techniquement possible mais
inégal en valeur : **les stores vectoriels (Qdrant/Zvec) = remplacement à forte
valeur ; les SQLite (KG, cache, orchestrateur) = conserver** — ils ne sont pas
le goulot et le risque de migration dépasse le gain.

---

## 0. Décision arrêtée (2026-10-12)

Suite à l'étude ci-dessous, la cible est **arrêtée** :

| Sujet | Décision |
|---|---|
| Store vectoriel embarqué | **`usearch` sélectionné** — bindings Rust officiels, HNSW SIMD, mmap, quantification `f16`/`i8`. *Honnêteté technique :* cœur C++ compilé statiquement dans le binaire (même pattern que `zvec-rust`) — déploiement « embarqué pur », aucun serveur. Alternatives **pur Rust** si la contrainte « zéro C++ » devient dure : `hnsw_rs`, `hora`, ou `tantivy` seul (HNSW intégré depuis 0.22 = un seul crate pour contenu + vecteurs). Arbitrage final sur bench **recall@10 ≥ 0,95 vs Qdrant** en phase P4. |
| Qdrant + Zvec (serveurs) | **Décommissionnés en cible** — export des vecteurs avant arrêt (scroll Qdrant + dump Zvec → import usearch, sans ré-embedding). Ferme les ports `:6333` et `:8001`. |
| SQLite | **Conservé, servi par `rusqlite` (feature `bundled`)** — SQLite compilé statiquement dans `hphe-mcp.exe` : mêmes fichiers `.db`, zéro migration, zéro dépendance déployée. `redb` (KV pur Rust, ACID) optionnel pour `runtime-cache`/`semantic-cache`. `limbo` (réécriture Rust de SQLite) en watch-list. Optimisations : WAL, `synchronous=NORMAL`, `mmap_size`, covering indexes. |
| MCP `agentmemory` | **Absorbé** — les tools mémoire (`entities`/`observations`/`relations` CRUD + search) sont servis par `hphe-mcp.exe` directement sur les mêmes `.db` via rusqlite. Le serveur MCP séparé disparaît du runtime ; **zéro migration de données**. Bonus : liaison des observations par **FRN** (identité NTFS survivant aux renommages) en v2. |
| Serveur MCP unifié | **`hphe-mcp.exe` unique** exposant `fs_*` + `everything_*` + `memory_*` + `semantic_*`/`hybrid_*`. Remplace : `everything-mcp` (Python), `agentmemory`, `sqlite-node` (pour les stores mémoire), `server.py`. `orchestrator.db` reste exclusif à l'Orchestrateur MCP (règle d'architecture, hors scope). |
| Split processus | **2 processus** : `hphe-indexd` (service **élevé** : index fichier + contenu + vecteurs + watch) / `hphe-mcp` (**non élevé** : façade tools + KG SQLite direct + client pipe). La séparation suit le privilège, pas le domaine. |
| SQLite « en Rust » | `rusqlite` bundled = SQLite dans le binaire. Pas de migration de format — jamais. |

Ce qui est supprimé du runtime : `Everything.exe`, `Qdrant (:6333)`,
`Zvec (:8001)`, `agentmemory` (serveur MCP), `sqlite-node` (stores mémoire),
`server.py`/Python. Ce qui reste : les fichiers `.db` SQLite, l'Orchestrateur
MCP, les embeddings NVIDIA NIM (génération).

---

## 1. Inventaire de l'existant (constaté dans `.agent/`)

| Store | Techno | Contenu mesuré | Accès |
|---|---|---|---|
| `memory_mcp.db` | SQLite | KG : ~225k entités, ~315k observations, ~676k relations | MCP agentmemory / sqlite-node |
| `graph-memory.db` | SQLite | edges (from,to,type) — traversals | sqlite-node |
| `runtime-cache.db` | SQLite | kv (key,value,updated_at) | sqlite-node |
| `semantic-cache.db` | SQLite | kv + embedding BLOB + TTL | sqlite-node |
| `orchestrator.db` | SQLite | registry de tâches | Orchestrateur MCP **exclusivement** |
| **Qdrant** | serveur `:6333` | 5 collections 2048D (code, doc, config, workflow, skill) | HTTP |
| **Zvec** | embarqué `:8001` | 6 index HNSW 384D (entities, concepts, actions, relations, context, learning_insights) | zvec_semantic_search |
| Pipeline RAG | Python ~4,6 k lignes | chunker, tagger, router (dual), embedder, fusion, beacon_ingest, `.ragignore` | fichiers `.agent/rag/` |
| Embeddings | NVIDIA NIM `nemotron-3-embed-1b` (2048D) + local `all-MiniLM-L6-v2` (384D) | génération externe/locale | API / lib |

Flux actuel : Beacon capture → `beacon_ingest` distille → chunker/tagger →
router dual → Qdrant **et/ou** Zvec → memory_mcp graphe → `fusion.py`
re-fusionne côté client en 3 appels.

---

## 2. Intégration au système d'indexation Hephaistos

### 2.1 Ce que le moteur apporte immédiatement

Le démon connaît déjà **chaque fichier** du PC (nom, chemin, taille, dates,
attributs) et maintient un flux de changements. C'est exactement la couche
« découverte » dont l'ingest RAG a besoin :

| Besoin RAG actuel | Couvert par le moteur |
|---|---|
| Énumérer les fichiers indexables d'un workspace | `query("path:X:/projet ext:md;py;json", vol)` — **ms** au lieu d'un `os.walk` |
| Détecter les fichiers modifiés pour ré-indexer | `watch` stream (verbe prévu v2) : deltas USN → invalidation par `mtime`/`size` |
| Respecter les exclusions | `.ragignore`/`.mcp-access` appliqués au niveau requête |
| Résoudre chemin ↔ chunks | `file_id` stable dans l'index → jointure directe chunk→fichier |

Concrètement : `beacon_ingest`/`ingest-workspace.ps1` deviennent des clients du
watch stream — **ingestion incrémentale temps réel** au lieu de scans
périodiques. C'est la première intégration, sans toucher à aucun store.

### 2.2 Deuxième niveau : index de contenu

Le démon sait où sont les fichiers ; y ajouter un index de **contenu** (BM25
via `tantivy`, Rust, ~l'équivalent Lucene) sur les racines autorisées donne la
« recherche extrêmement rapide au niveau document » que l'intuition visait :

- `grep-like` instantané sur le contenu de tout le PC (tantivy = ms à dizaines
  de ms sur corpus locaux) — chose qu'Everything ne fait même pas.
- Chaque document indexé peut porter son **vecteur** (tantivy supporte HNSW
  depuis 0.22, ou `usearch`/`hnsw_rs` en store dédié) → recherche hybride
  *lexicale + sémantique* dans le même processus.

C'est le pont naturel vers la question 2.

---

## 3. Remplacement des bases — composant par composant

### 3.1 Qdrant (serveur :6333, 2048D) — **remplaçable, forte valeur**

| Alternative embarquée | Profil |
|---|---|
| `usearch` | HNSW SIMD in-process, n'importe quelle dimension, mmap — le plus simple et le plus rapide |
| `hnsw_rs` | HNSW Rust natif, éprouvé |
| `tantivy` | HNSW + BM25 + colonnes dans **un** index — le plus intégré |
| `sqlite-vec` | KNN dans SQLite — proche de l'existant, mais scan brut (pas HNSW) : OK < ~1 M vecteurs |

**Pour :** suppression d'un serveur et d'un port (le skill `mcp-security-audit`
documente le sujet des ports locaux exposés — retirer :6333 et :8001 ferme
deux surfaces), latence in-proc, payloads colocalisés avec les chunks,
snapshot = fichiers (backup trivial). Les vecteurs existants sont
**exportables** via l'API scroll de Qdrant → ré-import en store embarqué
**sans ré-embedding** (coût de migration ≈ un script).

**Contre :** perte des fonctionnalités Qdrant (filtres payload pendant ANN,
dashboard, snapshots managés, montée en charge) — peu utilisées à l'échelle
locale ; maturité des libs embarquées bonne mais à valider sur collections de
la taille réelle.

**Verdict : REMPLACER — `usearch` sélectionné** (cf. §0). Bench recall@10
obligatoire en phase P4 avant décommission ; fallback pur Rust `hnsw_rs`/
`tantivy` si écart.

### 3.2 Zvec (embarqué, 384D) — **remplaçable, valeur unification**

Zvec est *déjà* embarqué — le gain de vélocité est marginal. L'intérêt est
d'unifier : un seul store de vecteurs au lieu de deux implémentations.

**Attention dimensions** : Qdrant = 2048D (NVIDIA NIM), Zvec = 384D (MiniLM) —
deux espaces sémantiques différents, pas interchangeables. Le store unifié
doit gérer **deux collections à dimensions distinctes** (usearch/tantivy le
permettent) ; ou re-embedder tout en un seul modèle — coûteux et change la
sémantique : **conserver le dual-dimensionnel**, unifier le contenant.

**Verdict : REMPLACER/FUSIONNER** dans le store `usearch` unique (collections
2048D + 384D distinctes). Rappel : zvec est *déjà* une lib in-process (cœur
C++, SDK Rust officiel) — conserver son moteur embarqué via `zvec-rust` reste
un plan B si `usearch` déçoit au bench.

### 3.3 SQLite KG + caches — **conserver (sauf opportunité)**

| Base | Analyse |
|---|---|
| `memory_mcp.db` (225k entités / 676k relations) | SQLite n'est **pas** le goulot : requêtes entité/relation = ms. Migrer vers un graphe maison = réécrire ce que SQLite fait déjà bien, avec risque sur 676k relations. **Conserver.** Option v2 : colocaliser les adjacences dans le démon uniquement si la fusion graphe+vecteur devient un goulot — pas aujourd'hui. |
| `graph-memory.db` | Idem — éventuellement fusionnable dans `memory_mcp` (simplification SQLite→SQLite, indépendante du moteur). |
| `runtime-cache.db` | Remplaçable trivialement par kv embarqué (`redb`/`fjall`/`heed`) si le démon existe — mais le gain est symbolique. **Indifférent.** |
| `semantic-cache.db` | Cas particulier : c'est déjà un mini store vectoriel → absorber dans le store unifié si migration. |
| `orchestrator.db` | **Hors scope** — règle d'architecture : accès exclusivement via l'Orchestrateur MCP. Ne pas toucher. |

### 3.4 Pipeline RAG Python — **migration progressive, pas big-bang**

| Module | Sort |
|---|---|
| `chunker.py`/`tagger.py` | restent Python en premier lieu (logique riche, itérative) ; portage Rust optionnel plus tard |
| `router.py` (dual qdrant/zvec) | **s'élimine** — un seul store, le routage devient un paramètre de collection |
| `fusion.py` | **s'intègre** au moteur — la fusion hybride devient native (§4) |
| `embedder.py` | la génération reste externe (NIM API) ou locale — inchangée côté client |
| `beacon_ingest.py` | bascule sur watch stream (§2.1) |

---

## 4. Le vrai gain : la recherche hybride native

Aujourd'hui `fusion.py` fait côté client : 1 appel HTTP Qdrant + 1 appel Zvec
+ 1 lookup KG, puis pondère `0.5/0.4/0.1`. Dans le moteur unifié, la même
requête est **une seule évaluation in-process** :

```
search("gestion des credentials")
  → BM25 (tantivy, contenu)          ~ms
  → ANN 2048D (usearch)              ~ms   ──┐ fusion native (même processus,
  → ANN 384D (usearch)               ~ms      │ scores comparables, pas de
  → boost graphe (adjacences KG)     ~ms   ──┘ sérialisation)
  → + filtres colonnes (path:, ext:, dm:)
```

**Honnêteté sur le « boost embeddings »** : la *recherche* vectorielle gagne
un peu (in-proc vs HTTP roundtrip — Qdrant local répond déjà en ms, donc gain
modeste, pas ×10). Le vrai gain est **capacitaire et architectural** :

- requêtes **impossibles aujourd'hui** : `path:F:/projet AND content~"retry
  policy" AND similar(chunk_vec)` en un appel ;
- fusion dans le moteur = scores comparables nativement (aujourd'hui 3
  systèmes à normaliser à la main) ;
- la *génération* d'embeddings ne change pas — elle reste NVIDIA NIM (ou
  modèle local via `ort`/`candle` si on veut aussi s'en affranchir).

---

## 5. Architecture cible si unification poussée

```
hphe-indexd.exe (service élevé)
├─ file index SoA        (noms/chemins/métadonnées — phase 1)
├─ content index tantivy (BM25 + champs colonnes)          ── nouveau
├─ vector store usearch  (collections 2048D + 384D)        ── remplace Qdrant+Zvec
├─ watch stream          (deltas → ingest RAG, extension)
└─ pipe API              (query/count/status/rebuild/watch/search_hybrid)

hphe-mcp.exe (non élevé — MCP stdio unique)
├─ fs_* tools            (port Rust de fs_tools.py + policy .mcp-access)
├─ everything_* tools    (client du pipe hphe-indexd)
├─ memory_* tools        (rusqlite bundled sur memory_mcp.db /
│                         graph-memory.db — remplace le serveur agentmemory)
├─ semantic_*/hybrid_*   (client du pipe — fusion native côté démon)
└─ caches kv             (rusqlite sur runtime-cache.db /
                          option redb)

Conservés hors processus :
├─ memory_mcp.db / graph-memory.db (fichiers SQLite — servis par hphe-mcp)
├─ orchestrator.db (tâches)                      — Orchestrateur MCP exclusif
└─ runtime-cache.db                              — kv SQLite (indifférent)
```

Le démon devient le **magasin documentaire** ; `hphe-mcp` sert les SQLite
**relationnels** directement (rusqlite bundled). Chaque technologie à son
rôle — on ne force pas le KG dans le moteur, on ne force pas les vecteurs
dans SQLite, et un seul MCP remplace quatre processus.

---

## 6. Matrice de décision

| Composant | Remplacer ? | Valeur | Effort | Risque |
|---|---|---|---|---|
| Qdrant → `usearch` | **Oui — arrêté** | Forte : -1 serveur, -1 port, fusion native | Moyen (export/import vecteurs) | Maturité filtres payload — mitigé par post-filtrage |
| Zvec → même store `usearch` | **Oui — arrêté** | Moyenne : unification | Faible-moyen | Gérer 2 dimensions |
| semantic-cache → store unifié | Oui | Moyenne | Faible | TTL à porter |
| MCP agentmemory → `memory_*` dans `hphe-mcp` | **Oui — arrêté** | Forte : -1 MCP, joins mémoire↔fichier in-proc | Faible (mêmes `.db`, rusqlite) | Renommage des tools à mapper 1:1 |
| Serveur `everything-mcp` Python → `hphe-mcp.exe` | **Oui — arrêté** | Forte : fin `spawn python ENOENT`, binaire unique | Moyen-élevé | Port fs_tools/policy — spec 02 |
| SQLite → `rusqlite` bundled | **Oui (contenant)** | Moyenne : zéro dépendance, mêmes fichiers | Trivial | — |
| memory_mcp/graph-memory (données) | **Non** | Faible : SQLite OK | Élevé | Perte KG 676k relations |
| runtime-cache | Indifférent (`redb` possible) | Symbolique | Trivial | — |
| orchestrator.db | **Non** | n/a | n/a | Règle d'architecture |
| fusion.py → moteur | Oui (si P3) | Forte | Moyen | Recalibrer les poids |
| embeddings (NIM) | **Non** | n/a — génération externe | n/a | Option modèle local `ort` plus tard |

## 7. Scénarios

| Scénario | Périmètre | Appréciation |
|---|---|---|
| **A — Moteur fichier seul** | remplace Everything | Valeur forte, risque contenu — **point de départ** |
| **B — A + contenu BM25** | + tantivy sur racines autorisées | Capacité nouvelle (grep PC instantané) — fort ROI |
| **C — B + vecteurs embarqués + MCP unifié** | + usearch 2048D/384D, migration Qdrant/Zvec, `memory_*` dans `hphe-mcp` | **Cible arrêtée** — suppression serveurs+MCP, hybride natif |
| **D — C + KG/caches dans le démon** | tout intégré | **Écarté** : effort maximal pour gains marginaux ; SQLite via rusqlite dans `hphe-mcp` suffit |

**Décision : C confirmé (2026-10-12), A→B→C comme séquence de livraison.**
D écarté — le KG reste en SQLite servi par `hphe-mcp`, pas porté dans le
démon. Le détail d'exécution est dans [04-PRD](04-PRD.md).

---

## 8. Risques et points d'attention

| Risque | Détail | Mitigation |
|---|---|---|
| Taille du scope | A→C = un mini « search engine + vector DB » maison | phases indépendantes, chacune livrable/réversible ; POC P0 avant engagement |
| Filtres vectoriels | usearch/tantivy filtrent moins richement que Qdrant (payload indexé) | post-filtrage sur colonnes — suffisant à notre échelle (<1-2 M docs) |
| Migration vecteurs | export scroll Qdrant → import ; vérifier comptage + recall@k sur échantillon | script de migration + test de parité recall |
| SPOF démon | un crash = plus d'index fichier ni vecteurs | snapshot mmap + restart service + watchdog (déjà prévu spec) |
| Sécurité | contenu indexé = données sensibles en clair dans l'index | `.ragignore`/`.mcp-access` appliqués à l'ingest ; racines explicites ; pas de secrets (filet SAFETY existant : `.env`, `*.pem`, `*.db`…) |
| Fraîcheur contenu | BM25/vecteurs ne rafraîchissent pas à la vitesse USN | watch stream → ré-indexation par priorité ; contenu = « quasi-live », pas live |
| Deux espaces vectoriels | 2048D vs 384D — ne pas fusionner les collections | collections distinctes dans le même store |

---

## 9. Questions ouvertes pour la phase POC

1. `tantivy` tient-il ~1-2 M documents avec BM25+vecteurs à la latence visée
   sur cette machine ? (bench réel à faire)
2. ~~`usearch` vs `hnsw_rs`~~ → **tranché : `usearch`**. Reste à prouver en P4 :
   recall@10 ≥ 0,95 vs Qdrant sur les vecteurs exportés réels (fallback
   `hnsw_rs`/`tantivy`/ même `zvec-rust` si écart).
3. RAM totale démon (index fichier ~3 Gio + tantivy + vecteurs 2048D) — le
   budget machine est-il confortable ? Les vecteurs 2048D × N docs en RAM sont
   le poste dominant (N=500k → ~4 Gio fp32 ; quantification `f16`/`i8` possible).
4. Watch stream : charge acceptable sur volumes très actifs (builds, git) ?
