# SPEC — Moteur de recherche Hephaistos (nom de travail : `hphe-indexd`)

> Spec design d'un moteur d'indexation NTFS autonome visant la parité de
> vélocité avec Everything.exe : démon élevé + index RAM + named pipe.
>
> Livrable cible : `hphe-indexd.exe` (service/démon, Rust) + client pipe
> consommé par `server.py` (phase 1) puis par un MCP Rust natif (phase 2,
> voir `02-PORTABILITE-RUST.md`).

---

## 1. Objectifs et non-objectifs

### Objectifs

- Recherche nom/chemin/ext/taille/dates sur tous les volumes NTFS locaux en
  **< 150 ms p50** sur ~16 M entrées (parité Everything, potentiellement mieux
  via scan parallèle).
- Index **toujours frais** : deltas du journal USN appliqués en continu.
- Aucune dépendance à `Everything.exe`, ni à son protocole, ni à son index.
- API locale sécurisée (named pipe ACLée, **aucun port réseau**).
- Le contrat des outils MCP existants est préservé côté client — swap de
  backend transparent pour l'extension.

### Non-objectifs (v1)

- Interface graphique propre (l'extension VS Code joue déjà ce rôle).
- Serveur ETP/HTTP/FTP, multi-utilisateur distant, historique de lancements.
- Volumes non-NTFS (ReFS, FAT32, réseau) : indexer par traversal en v2
  (mode dégradé explicite).
- Recherche de contenu (BM25) : phase 3 (voir `03-FAISABILITE-UNIFICATION.md`).

### Contraintes structurelles

- **Élévation obligatoire** : `CreateFileW("\\\\.\\X:")`, les `FSCTL_*` du
  journal USN et la lecture du `$MFT` exigent Administrateur/SYSTEM. Le moteur
  est donc un **service Windows** (ou tâche planifiée HIGHEST), exactement
  comme le "Everything Service". Les clients (MCP, extension) restent
  non-élevés.
- Windows only, x64. (Portage cross-OS hors scope ; la couche moteur est
  isolée pour permettre un backend Linux `fanotify`+`/` plus tard.)

---

## 2. Architecture globale

```
┌──────────────────────────────────────────────────────────────┐
│ hphe-indexd.exe   (Windows service, SYSTEM/admin, Rust)      │
│                                                              │
│  ┌────────────┐   ┌─────────────────┐   ┌─────────────────┐  │
│  │ mft_reader │──►│   Index RAM     │◄──│  usn_watcher    │  │
│  │ volume/    │   │  (SoA colonnes) │   │ FSCTL_READ_USN  │  │
│  │ snapshot/  │   └───────┬─────────┘   └─────────────────┘  │
│  └────────────┘           │                                  │
│                     ┌─────▼──────┐   ┌───────────────────┐   │
│                     │ query_eng  │◄──│  pipe_server      │   │
│                     │ parser+eval│   │ \\.\pipe\hphe-idx │   │
│                     └────────────┘   └─────────┬─────────┘   │
└────────────────────────────────────────────────┼─────────────┘
                                                 │ named pipe
                   ┌─────────────────────────────▼───────────┐
                   │ Clients non-élevés                      │
                   │  • server.py (MCP stdio) — phase 1      │
                   │  • hphe-mcp.exe (MCP Rust) — phase 2    │
                   │  • CLI hphe.exe (debug/ops)             │
                   └─────────────────────────────────────────┘
```

| Binaire | Rôle | Privilège |
|---|---|---|
| `hphe-indexd.exe` | Démon propriétaire de l'index : build MFT, deltas USN, snapshot, pipe serveur | SYSTEM/admin |
| `hphe-mcp.exe` (v2) | Serveur MCP stdio = thin client pipe + policy `.mcp-access` + fs_tools | utilisateur |
| `hphe.exe` | CLI ops : `status`, `rebuild`, `bench`, `query` | utilisateur |

---

## 3. Composant `mft_reader` — lecture initiale du `$MFT`

### 3.1 Pourquoi le MFT direct (et pas `FSCTL_ENUM_USN_DATA`)

`_obsolete/ntfs_index.py` utilisait `FSCTL_ENUM_USN_DATA` : rapide, mais les
`USN_RECORD_V2` **ne contiennent ni taille ni timestamps réels** (seul le
timestamp du journal). La parité Everything exige taille + 4 dates + attributs
réels → on parse les FILE records du `$MFT`, comme le fait Everything.

### 3.2 Procédure

1. `CreateFileW("\\\\.\\X:", GENERIC_READ|GENERIC_WRITE(share), ...)`.
2. Lire le boot sector (offset 0) → BPB NTFS : `bytes_per_sector` (0x0B),
   `sectors_per_cluster` (0x0D), `mft_lcn` (0x30), `clusters_per_file_record`
   (0x40, signé : négatif ⇒ taille = `2^-n` octets).
3. Lire le FILE record #0 (`$MFT` lui-même), parser son attribut `$DATA`
   non-résident → **runlist** des extents du `$MFT` (gestion du cas fragmenté).
4. Streamer les records séquentiellement selon la runlist (buffers ~8-16 Mio).
5. Pour chaque FILE record :
   - Vérifier magic `FILE`, appliquer le **fixup USA** (Update Sequence
     Array : remplacer les 2 derniers octets de chaque secteur par les valeurs
     USA, vérifier le numéro de séquence — sinon record invalide).
   - Sauter records non utilisés (`flags & 0x01 == 0`) et records d'extension
     (`base_frn != 0` → rattacher via `$ATTRIBUTE_LIST` au record de base).
   - Attributs utiles :
     - `$STANDARD_INFORMATION` (0x10) : created, modified, mft_changed,
       accessed (FILETIME ×4), file attributes.
     - `$FILE_NAME` (0x30) : parent FRN, real/allocated size, times, flags,
       namespace (garder WIN32/WIN32&DOS, **ignorer DOS 8.3** — sinon
       doublons de noms courts), name UTF-16. Plusieurs `$FILE_NAME` =
       hardlinks → plusieurs chemins pour un FRN.
     - `$DATA` (0x80) sans nom : real size du fichier (priorité sur
       `$FILE_NAME` size ; résident vs non-résident).
     - `$ATTRIBUTE_LIST` (0x20) : chaîner les records d'extension.
6. Émettre `(frn, parent_frn, name, size, times, attrs, flags)` vers l'index.

**Crate recommandée** : [`ntfs`](https://crates.io/crates/ntfs) (Colin Finck)
implémente déjà fixup, attribute list, `$FILE_NAME`, runlists — à valider en
POC sur volume réel. Alternative : parseur maison (~800-1 200 lignes), avec les
structures ci-dessus. `windows-sys` pour les ioctls.

### 3.3 Performance attendue

| Étape | Ordre de grandeur (16 M records, NVMe) |
|---|---|
| Lecture `$MFT` (~16 Gio de records 1 Kio) | 5-30 s (débit disque) |
| Parse + insert index | parallélisable par chunks de records (rayon), masqué par l'I/O |
| **Build total** | ≈ même ordre que le premier démarrage d'Everything |

Optimisation : le snapshot persisté (§7) rend le build MFT rare (premier
démarrage, journal recréé, corruption). Warm start = snapshot + deltas.

---

## 4. Composant `index` — structure en RAM

Everything scanne linéairement sa base à chaque requête : c'est la bonne
approche quand les données sont contiguës — on reproduit, en SoA
(structure of arrays) :

```rust
struct Index {
    // --- données par entrée (id u32 stable interne) ---
    names:   NamesBlob,      // UTF-16 lowercase concaténé + Vec<u32> offsets
    names_orig: NamesBlob,   // casse originale (affichage, case: queries)
    parents: Vec<u64>,       // parent FRN
    frns:    Vec<u64>,       // FRN propre (u48 réel)
    sizes:   Vec<i64>,
    mtimes:  Vec<i64>, ctimes: Vec<i64>, atimes: Vec<i64>,
    attrs:   Vec<u32>,       // FILE_ATTRIBUTE_*
    vol:     Vec<u8>,        // volume index
    flags:   Vec<u8>,        // dir / deleted / hardlink
    frn_to_id: HashMap<(u8, u64), u32>,   // résolution deltas USN
    paths_cache: PathsCache, // full path résolu à la demande (memo par dossier)

    // --- vues triées maintenues incrémentalement ---
    sorted: EnumMap<SortKey, Vec<u32>>,  // name, path, size, ext, dm, dc, da, attrs
}
```

Estimation mémoire (16 M entrées) : noms ~40 o ×2 (lower+orig) ≈ 1,3 Gio +
colonnes ~60 o/entrée ≈ 1 Gio + listes triées 8×4 o ≈ 0,5 Gio → **~2,5-3 Gio**
(comparable à Everything ; compressible : lowercase stocké UTF-8 quand ASCII).

Résolution de chemin : `parent_frn → parent path` en chaîne, mémoïsée par
dossier. Chemin complet matérialisé uniquement pour `matchpath:`/`path:` et
l'affichage des résultats — jamais stocké par entrée (économise ~2 Gio).

Les `sorted[*]` sont des `Vec<u32>` triés par clé ; insertion par binary search
+ `Vec::insert` (amorti OK : les deltas arrivent en flux faible vs la taille).

---

## 5. Composant `usn_watcher` — fraîcheur

1. `FSCTL_QUERY_USN_JOURNAL` par volume → `journal_id`, `next_usn`.
2. Si `journal_id` ≠ stocké, ou `last_usn < first_usn` (wrap), ou backlog >
   seuil (~256 Mio, logique déjà éprouvée dans `_obsolete`) → **rebuild volume**.
3. Sinon `FSCTL_READ_USN_JOURNAL` en continu depuis `last_usn`
   (`ReasonMask = FILE_CREATE|FILE_DELETE|RENAME_*|BASIC_INFO|DATA_*|HARD_LINK`,
   boucle non-bloquante `Timeout=0`, poll 250-500 ms + fallback
   `BytesToWaitFor` pour push).
4. Application des deltas :
   - `FILE_DELETE` → supprimer entrée (FRN connu via `frn_to_id`).
   - `FILE_CREATE` / `RENAME_NEW_NAME` / `BASIC_INFO_CHANGE` → lire le FILE
     record ponctuel via `FSCTL_GET_NTFS_FILE_RECORD` (cheap à l'unité) pour
     récupérer taille/dates réelles — le record USN ne les porte pas.
   - `RENAME_OLD_NAME` → invalider le nom/chemin courant (rename = paire
     OLD+NEW pour le même FRN).
   - Rename de dossier → cascade : réécrire le chemin des descendants
     (même stratégie que `_obsolete/refresh_deltas` : UPDATE path LIKE old%,
     ici : invalidation du cache + réécriture des entrées `paths_cache`).
   - Hardlinks : un FRN peut gagner/perdre un `$FILE_NAME` — gérer
     multi-parents.
5. Checkpoint périodique `last_usn` dans le snapshot/meta.

Le cas `USN_REASON_DATA_*` (écriture) ne change ni nom ni parent : mettre à
jour taille+dates du record — fetch ponctuel idem, coalescé.

---

## 6. Composant `query_engine` — parser + évaluateur

### 6.1 Syntaxe (compatibilité avec le sous-ensemble exposé par le MCP)

Réutiliser la grammaire de `_obsolete/query_parser.py` comme cahier des
charges : termes AND, `a|b` (OR), `!term` (NOT), `*` `?` wildcards, `ext:a;b`,
`size:` (ops + buckets), `dm:`/`dc:`/`da:` (today/yesterday/dates/ranges),
`path:`, `parent:`, `matchpath:` (flag), `regex:`, `case:`, `ww:`,
`startwith:`, `endwith:`, `folder:`/`file:`, catégories (`audio:` … — réutiliser
`categories.py`), `"phrase exacte"`.

Parser → AST → compilation en prédicats par colonne + plan :

```
query:  rapport ext:pdf;docx size:>1mb dm:today
  AST:  AND[ Substr(name,"rapport"), Ext in {pdf,docx},
              Size > 1MiB, Mtime >= today0 ]
  Plan: ext (sélectif, colonne) → size (colonne) → dm (colonne)
        → name substring (scan blob, vérif finale)
```

### 6.2 Évaluation

- **Colonne d'abord** : les filtres ext/size/dates/dir/attrs balayent leurs
  `Vec` — vectorisable, ~50-100 M entrées/s/cœur en release.
- **Substring nom** : `memchr::memmem` (SIMD) sur `names` en lowercase ;
  pré-filtrage par colonnes réduit la portée quand possible
  (ex: `ext:` limite d'abord).
- **Wildcard `*`/`?`** : matcher par entrée (pas de scan blob possible en
  général — sauf `startwith:` → binary search sur `sorted[name]`).
- **`regex:`/`ww:`** : `regex` crate sur candidats post-filtrés.
- **Parallélisation** : scan blob/columns partitionné par rayon, réduction des
  résultats à `offset+limit` — c'est le point où le moteur peut **dépasser**
  Everything sur requêtes larges.
- **Tri** : utiliser `sorted[key]` — les résultats sortent dans l'ordre en
  filtrant la liste triée (pas de re-tri).
- **Early exit** : arrêt à `offset + max_results` atteint pour les requêtes
  triées ; `total` exact exige un count complet (thread séparé ou calcul
  incrémental — décision POC : Everything paie le même coût).

### 6.3 Réponse

Structure alignée sur QUERY2/LIST2 côté client : `total`, `offset`,
`results[{full_path, dir, size, mtime, attrs}]` — le MCP actuel n'a qu'à
changer de transport, pas de modèle.

---

## 7. Persistance — snapshot + meta

- `index.snap` : image sérialisée **zero-copy** ([`rkyv`](https://crates.io/crates/rkyv)
  ou format maison : header + blobs + tables u32/u64, mmap direct). Écriture
  atomique (tmp + rename), checksum.
- `meta.json` : per-volume `{journal_id, last_usn, built_at, rows}`.
- Warm start : mmap snapshot (~1-3 s) → `usn_watcher` reprend à `last_usn`.
- Snapshot périodique (5-15 min) + à l'arrêt du service.
- Pas de SQLite dans le chemin chaud. (SQLite reste possible pour meta/logs.)

---

## 8. Transport — named pipe

- `\\.\pipe\hphe-indexd` en mode message, ACL : créateur-propriétaire +
   utilisateurs locaux (refuser network/anonymous). Aucun port réseau — même
   posture de sécurité qu'aujourd'hui.
- Protocole v1 : **NDJSON** (1 requête/réponse par ligne) — simple, debuggable,
  suffisant pour ≤10k lignes de résultats (~ms de sérialisation).
- Protocole v2 (si le payload devient le goulot, cf. benchmarks actuels
  payload-bound) : frames binaires `len|bincode`, ou **MMF** partagé pour les
  gros result sets (le pipe ne porte que `{handle, size}`).
- Verbes : `query` (params complets), `count`, `status` (version, per-vol
  rows/usn/building/errors), `rebuild{vol?}`, `save`, `watch` (stream de
  changements — v2, utile pour l'extension et l'ingest RAG).

Le client côté `server.py` : ~150 lignes (pywin32 `win32pipe`/`win32file` ou
ctypes CreateFile/WriteFile/ReadFile) — remplace `everything_ipc.py` par un
module `hphe_ipc.py` à interface identique (`search()`, `count()`, `status()`).

---

## 9. Déploiement

| Élément | Décision |
|---|---|
| Service | `hphe-indexd.exe --install` → `OpenSCManager` (crate `windows-service`), démarrage auto, recovery = restart |
| Alternative légère | tâche planifiée HIGHEST (modèle déjà utilisé par `_obsolete/register_task.ps1`) — POC acceptable, service = cible |
| Données | `%PROGRAMDATA%\HephaistosKit\hphe-indexd\` (snap, meta, log) |
| Install | une fois, élevé — identique à l'install d'Everything |
| Sécurité | pipe ACLé ; pas de port ; policy `.mcp-access` appliquée côté client MCP (inchangée), renforçable dans le moteur en v2 |

---

## 10. Phases et critères d'acceptation

| Phase | Contenu | Critère de sortie |
|---|---|---|
| **P0 — POC** | `mft_reader` minimal (crate `ntfs` ou maison) + count/insertion dans un index SoA naïf, un volume | lit les records `C:` sans erreur ; mémo mesurée ; bench scan substring sur dataset réel |
| **P1 — Moteur fichier** | index complet, `usn_watcher`, snapshot, pipe v1 NDJSON, `hphe_ipc.py`, swap backend `server.py` | parité outils `everything_*` (mêmes champs) ; latence ≤ Everything sur batterie de requêtes ; fraîcheur < 1 s après un `touch` |
| **P2 — Durcissement** | service Windows, MMF payloads, watch stream, non-NTFS dégradé, multi-machine test | uptime continu, rebuild auto sur journal wrap, package d'install |
| **P3 — Unification** | index contenu BM25 + vecteurs embarqués + migration stores mémoire (optionnel) | voir `03-FAISABILITE-UNIFICATION.md` |

### Métriques de référence (à reproduire sur la machine de dev)

| Requête | Cible |
|---|---|
| `dots folder:` (35 hits) | ≤ 400 ms warm (parité mesurée) |
| `dots` 1 328 hits | ≤ 5 s payload-bound (parité) ; objectif < 2 s avec frames binaires |
| `count("")` | ≤ 10 ms |
| Build à froid 16 M entrées | ≤ 60 s NVMe |
| Warm start | ≤ 3 s |

---

## 11. Risques identifiés

| Risque | Mitigation |
|---|---|
| `$MFT` fragmenté / corrigé par USA | fixup + runlist du record #0 ; fallback `FSCTL_ENUM_USN_DATA` (métadonnées réduites) avec warning |
| `ATTRIBUTE_LIST` / records multi-segments | crate `ntfs` gère ; tests sur volumes avec fichiers à >30 attributs |
| Journal USN wrap pendant indisponibilité | détection `journal_id`/`first_usn` → rebuild auto (logique `_obsolete` portée) |
| RAM 2,5-3 Gio | compression noms UTF-8, `u32` internes, option "volumes sélectifs" |
| ACL pipe trop permissive | ACL explicite + review sécurité (`.agent/skills` security) |
| Renames massifs (git checkout) | file de deltas coalescée par FRN, rebuild de dossier borné |
| Élévation requise à l'install | script d'install signé/documenté, consentement utilisateur explicite — jamais d'UAC silencieux |

---

## 12. Stack technique proposée

| Besoin | Crate |
|---|---|
| Win32/ioctls/service/pipes | `windows`/`windows-sys`, `windows-service` |
| MFT | `ntfs` (à valider POC) ou parseur maison |
| Async/boucle | `tokio` (ou threads std + `crossbeam` — le démon est simple) |
| Scan substring/wildcard | `memchr`, `aho-corasick`, `regex` |
| Parallélisme | `rayon` |
| Sérialisation snapshot/pipe | `rkyv`, `bincode`, `serde_json` |
| Maps | `hashbrown`/`rustc-hash` |
| CLI | `clap` ; logs `tracing` + `tracing-appender` |
| Phase 3 (contenu/vecteurs) | `tantivy` (BM25+vecteurs), `usearch`/`hnsw_rs` (HNSW) — voir doc 03 |
