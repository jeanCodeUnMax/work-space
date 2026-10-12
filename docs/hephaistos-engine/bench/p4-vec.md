# Bench Report — P4 `hphe-vec` (T-080 / task #334)

## Scope

`hphe-vec` implémente le store vectoriel embarqué du moteur Hephaistos, destiné
à remplacer Qdrant/Zvec (gate P4 : `recall@10 ≥ 0.95` vs référence exacte).

- **Moteur** : `usearch` 2.26.4 — HNSW C++ compilé statiquement, bindings
  Rust officiels (`usearch` crate, `default-features = false`).
- **Décision crate** : tantivy 0.22.1 n'expose **aucun** support vectoriel
  (vérifié par grep exhaustif du source — le commentaire « HNSW depuis 0.22 »
  était faux). `usearch` reste le choix #309, validé en build FFI MSVC.
- **Subtilité build** : `numkong` (feature par défaut usearch) casse le lien
  (`__imp_nk_*` non résolus, LNK2019) → `default-features = false`
  (`USEARCH_USE_NUMKONG=0`). Recall inchangé, SIMD interne conservé.
- **API** (`src/lib.rs`) : `VecIndex` — create/open/open_or_create/save,
  `upsert_vector(frn, &[f32])` (remove-then-add, usearch refuse les
  doublons), `remove`, `contains`, `len`, `knn` (HNSW), `exact_knn`
  (brute-force = ground truth recall), `get`, métrique Cos, F32, clés=FRN,
  persistance disque, `recall_tuned` (M=16, ef_add=128, ef_search=64),
  dimensions configurables (2048D/384D).
- **Bench** : `examples/recall_bench.rs` — corpus synthétique clusterisé.

## Environment

| Item      | Value                                     |
|-----------|-------------------------------------------|
| OS        | Windows 11, x86_64 — MSVC BuildTools 2022 |
| Toolchain | Rust stable 1.94.1, `--release`, cmake    |
| Crate     | usearch 2.26.4 (`default-features=false`) |
| Dataset   | 50 000 vecteurs 384-D, 64 clusters, bruit 0.2 |

## Results — 50 000 × 384-D

| Metric            | Value          | Spec target | Status |
|-------------------|----------------|-------------|--------|
| Index build       | 9.642 s        | —           | —      |
| **Build rate**    | **5 186 vec/s** | —          | —      |
| **recall@10**     | **0.9950**     | ≥ 0.95      | **✓ PASS** |
| Avg knn latency   | 226.9 µs       | < 5 ms      | **✓**  |
| Queries           | 200 @k=10      | —           | —      |

## Correctness

- `cargo test -p hphe-vec` : **8/8 verts**
  (upsert+knn nearest, replace same key, remove/contains, get missing,
  dimension mismatch, recall_tuned config, persistence).
- Fixs appliqués pendant la validation :
  `reserve(capacity.max(1024))` avant tout add (usearch l'exige),
  `get` ne tronque plus le buffer (usearch retourne le nombre de clés,
  pas d'éléments), `upsert` = remove+add (doublons refusés côté FFI).

## Gate P4

**GO** — `usearch` embarqué atteint `recall@10 = 0.995` sur corpus
synthétique clusterisé, latence 227 µs/knn. Reste à valider sur les
vecteurs RÉELS exportés de Qdrant/Zvec (T-081 : export→import→recall
parity), puis décommission (T-082).
