# hphe-content

Tantivy-backed **content index** (BM25 + snippets) for the Hephaistos engine —
the P3 "index contenu" component described in
[`docs/hephaistos-engine/01-SPEC-MOTEUR.md`](../../../docs/hephaistos-engine/01-SPEC-MOTEUR.md)
§"index contenu" and
[`03-FAISABILITE-UNIFICATION.md`](../../../docs/hephaistos-engine/03-FAISABILITE-UNIFICATION.md)
§2.2.

It adds fast document-level search over file *contents* — something
Everything.exe does not do — on top of the same live file set the SoA
`hphe-index` already tracks. Tantivy (`0.22`, pure Rust) provides BM25
scoring, field columns, an on-disk segment store with a merge policy, and
(since 0.22) native HNSW for a later vector phase.

## Schema

| Field | Type | Options | Purpose |
|---|---|---|---|
| `path` | string | INDEXED + STORED + FAST | full path, exact match / display |
| `file_id` | u64 | INDEXED + STORED + FAST | FRN (unique document key) |
| `mtime` | date | INDEXED + STORED + FAST | modification time |
| `ext` | string | INDEXED + STORED + FAST | extension without dot |
| `size` | u64 | INDEXED + STORED + FAST | file size in bytes |
| `content` | text | INDEXED (freqs+positions) + STORED | BM25 body + snippet positions |
| `project_tag` | string | INDEXED + STORED + FAST | optional project tag |

## Usage

```rust
use hphe_content::{ContentIndex, ContentIndexConfig, FileRow, IngestPolicy, IngestState};

let idx = ContentIndex::open_or_create("path/to/index", ContentIndexConfig::default())?;
let policy = IngestPolicy::default();
let mut state = IngestState::new();

// Incremental ingest from FileIndex rows (only changed files are touched).
idx.ingest_rows(rows_iter, &policy, &mut state)?;
idx.commit()?;

// BM25 search with HTML snippets.
for hit in idx.search_bm25("retry policy", 10)? {
    println!("{} {:.4}\n{}", hit.path, hit.score, hit.snippet_html);
}
```

Because tantivy has no in-place update, an *update* is a
`delete_term(file_id)` + `add_document`, and a *delete* is just the
`delete_term`. Both are visible only after `commit()`.

## CLI

```
hphe-content index <dir> --index <tantivy_dir> [--recreate] [--ext rs,md] [--max-size N]
hphe-content search --index <tantivy_dir> <query> [--limit N]
hphe-content bench <dir> --index <tantivy_dir> --docs N --queries M
```

See `docs/hephaistos-engine/bench/p3-tantivy.md` for measured throughput and
query latency.
