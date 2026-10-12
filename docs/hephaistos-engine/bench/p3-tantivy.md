# Bench Report — P3 `hphe-content` (T-070 / task #331)

## Scope

`hphe-content` implémente l'index de contenu embarqué tantivy pour le moteur
Hephaistos :

- **Schema** (`src/schema.rs`) — `path` (string), `file_id`/FRN (u64 fast),
  `mtime` (date fast), `ext` (string), `size` (u64 fast), `content` (text BM25
  + positions pour snippets), `project_tag` (string).
- **Reader** (`src/reader.rs`) — lecture safe, détection encoding
  (UTF-8/UTF-16 BOM, fallback Latin-1), skip binaires (NUL byte + ratio
  caractères de contrôle), cap de taille configurable.
- **Ingest** (`src/ingest.rs`) — `IngestPolicy` (extensions + taille max),
  `IngestState` (skip unchanged par FRN+mtime).
- **Index** (`src/index.rs`) — `ContentIndex` : open/create/open_or_create,
  `upsert_file`/`upsert_row` (delete_term + add_document), `delete`,
  `delete_all`, `commit` (reload explicite), `ingest_rows` incrémental,
  `search_bm25` (TopDocs + `SnippetGenerator`).
- **CLI** (`src/main.rs`) — `index` / `search` / `bench` subcommandes.

## Environment

| Item        | Value                                  |
|-------------|----------------------------------------|
| OS          | Windows 11, x86_64                     |
| Toolchain   | Rust stable 1.94.1, `--release`        |
| Crate       | tantivy 0.22.1 (BM25 + HNSW natif)     |
| Dataset     | Corpus synthétique généré (`bench`)    |

## Results — 20 000 documents

| Metric              | Value          | Spec target | Status |
|---------------------|----------------|-------------|--------|
| Index build         | 0.279 s        | —           | —      |
| **Throughput**      | **71 647 docs/s** | ≥ 10 000 docs/s | **✓** |
| Total (corpus incl) | 0.296 s        | —           | —      |
| Avg BM25 query      | 233.9 µs       | < 5 ms      | **✓**  |
| Queries             | 200 → 2 000 hits | —         | —      |

## Correctness

- `cargo test -p hphe-content` : **20/20 verts**
  (roundtrip create/add/search/snippet, delete, persistence reopen,
  ingest incrémental skip-unchanged, schema fields, encoding detection,
  binary skip, missing file error).
- `cargo check -p hphe-content --all-targets` : 0 erreur, 0 warning.

## Gate P3

**GO** — tantivy 0.22.1 tient les cibles d'ingest (71k docs/s ≫ 10k) et de
latence requête (234 µs ≪ 5 ms) sur corpus synthétique. L'index est prêt pour
l'ingestion Beacon (T-071) et l'intégration `hphe-mcp` (T-090). La partie
vectorielle (HNSW natif tantivy) reste à valider en T-080 (gate P4
`recall@10 ≥ 0,95` vs Qdrant).
