//! `ContentIndex`: a tantivy-backed content index (BM25 + snippets).
//!
//! This is the P3 "index contenu" component described in
//! `docs/hephaistos-engine/01-SPEC-MOTEUR.md` §index contenu and
//! `03-FAISABILITE-UNIFICATION.md` §2.2. One document == one indexable file.
//!
//! Key properties:
//! - persistent on disk in a configurable directory (segments + merge policy
//!   handled by tantivy);
//! - documents are keyed by `file_id` (the NTFS FRN): an *update* is a
//!   `delete_term(file_id)` + `add_document`, a *delete* is just the
//!   `delete_term`;
//! - `search_bm25` returns ranked hits with an HTML snippet extracted from the
//!   `content` field (freqs + positions are indexed for this);
//! - commit policy is explicit: callers batch adds/deletes then `commit()`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tantivy::collector::TopDocs;
use tantivy::indexer::IndexWriter;
use tantivy::query::QueryParser;
use tantivy::schema::OwnedValue;
use tantivy::snippet::{Snippet, SnippetGenerator};
use tantivy::{DateTime, Index, IndexReader, TantivyDocument};

use crate::ingest::{ext_of, FileRow, IngestPolicy};
use crate::reader::{read_indexable, ReadOutcome};
use crate::schema::{file_id_term, ContentSchema};

/// A single BM25 hit.
#[derive(Debug, Clone)]
pub struct ContentHit {
    /// FRN / file id of the matched document.
    pub frn: u64,
    /// Full path (stored field).
    pub path: String,
    /// BM25 relevance score.
    pub score: f32,
    /// HTML snippet with matched terms wrapped in `<b>…</b>`.
    pub snippet_html: String,
    /// File extension (stored field, no dot).
    pub ext: String,
    /// File size in bytes (stored field).
    pub size: u64,
    /// Modification time as unix epoch seconds (from the stored date field).
    pub mtime_unix: i64,
}

/// Errors surfaced by the content index.
#[derive(Debug, Clone)]
pub enum ContentError {
    Io(String),
    Tantivy(String),
    Query(String),
}

impl std::fmt::Display for ContentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Tantivy(e) => write!(f, "tantivy error: {e}"),
            Self::Query(e) => write!(f, "query error: {e}"),
        }
    }
}

impl std::error::Error for ContentError {}

impl From<tantivy::TantivyError> for ContentError {
    fn from(e: tantivy::TantivyError) -> Self {
        Self::Tantivy(e.to_string())
    }
}

impl From<tantivy::query::QueryParserError> for ContentError {
    fn from(e: tantivy::query::QueryParserError) -> Self {
        Self::Query(e.to_string())
    }
}

/// Converts Windows FILETIME (100ns units since 1601-01-01) to a tantivy
/// `DateTime` (unix epoch). Mirrors `hphe_index::filetime_to_unix`.
///
/// Uses checked arithmetic so an out-of-range FILETIME (e.g. a corrupted
/// value) clamps to epoch 0 instead of panicking in debug builds.
fn filetime_to_datetime(filetime: u64) -> DateTime {
    const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if filetime < FILETIME_EPOCH_DIFF {
        return DateTime::from_timestamp_secs(0);
    }
    // (filetime - diff) is in 100ns units; ×100 → nanoseconds.
    match (filetime - FILETIME_EPOCH_DIFF).checked_mul(100) {
        Some(nanos) if nanos <= i64::MAX as u64 => DateTime::from_timestamp_nanos(nanos as i64),
        _ => DateTime::from_timestamp_secs(0),
    }
}

/// Extracts a stored `u64` field value from a retrieved document.
fn doc_u64(doc: &TantivyDocument, field: tantivy::schema::Field) -> u64 {
    doc.get_first(field)
        .and_then(|v| match v {
            OwnedValue::U64(n) => Some(*n),
            OwnedValue::I64(n) => Some(*n as u64),
            _ => None,
        })
        .unwrap_or(0)
}

/// Extracts a stored `str` field value from a retrieved document.
fn doc_str(doc: &TantivyDocument, field: tantivy::schema::Field) -> String {
    doc.get_first(field)
        .and_then(|v| match v {
            OwnedValue::Str(s) => Some(s.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Extracts a stored `date` field value (unix epoch seconds).
fn doc_date_unix(doc: &TantivyDocument, field: tantivy::schema::Field) -> i64 {
    doc.get_first(field)
        .and_then(|v| match v {
            OwnedValue::Date(d) => Some(d.into_timestamp_secs()),
            _ => None,
        })
        .unwrap_or(0)
}

/// The tantivy content index. `Clone`-able (shares the underlying `Index`
/// via `Arc`); internally synchronized so it can be shared across threads.
#[derive(Clone)]
pub struct ContentIndex {
    inner: Arc<ContentIndexInner>,
}

struct ContentIndexInner {
    cs: ContentSchema,
    index: Index,
    reader: IndexReader,
    /// tantivy IndexWriter is not Sync-safe to share directly behind a plain
    /// Mutex across async contexts, so we guard it and hand out short-lived
    /// borrows for batch operations. None if opened in read-only mode.
    writer: Option<Mutex<IndexWriter>>,
    /// Ingest directory (where segments live).
    dir: PathBuf,
}

/// Configuration for opening / creating a [`ContentIndex`].
#[derive(Debug, Clone)]
pub struct ContentIndexConfig {
    /// Number of tantivy indexing threads.
    pub num_threads: usize,
    /// Per-thread indexing heap budget in bytes (must be > 15 MiB).
    pub heap_bytes: usize,
}

impl Default for ContentIndexConfig {
    fn default() -> Self {
        Self {
            num_threads: 1,
            heap_bytes: 64 * 1024 * 1024, // 64 MiB
        }
    }
}

impl ContentIndex {
    /// Creates a brand-new content index in `dir` (wipes any existing index).
    pub fn create<P: AsRef<Path>>(dir: P, config: ContentIndexConfig) -> Result<Self, ContentError> {
        let cs = ContentSchema::build();
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| ContentError::Io(e.to_string()))?;
        let index = Index::create_in_dir(&dir, cs.schema.clone())?;
        Self::from_index(index, cs, dir, config)
    }

    /// Opens an existing content index in `dir`. Fails if the directory does
    /// not contain a tantivy index.
    pub fn open<P: AsRef<Path>>(dir: P, config: ContentIndexConfig) -> Result<Self, ContentError> {
        let cs = ContentSchema::build();
        let dir = dir.as_ref().to_path_buf();
        if !dir.join("meta.json").exists() {
            return Err(ContentError::Io(format!(
                "no tantivy index found at {} (meta.json missing)",
                dir.display()
            )));
        }
        let index = Index::open_in_dir(&dir)?;
        Self::from_index(index, cs, dir, config)
    }

    /// Opens an existing content index in read-only mode (no IndexWriter created).
    /// Safe for concurrent read access across multiple processes and threads
    /// without directory write-lock contention.
    pub fn open_read_only<P: AsRef<Path>>(dir: P) -> Result<Self, ContentError> {
        let cs = ContentSchema::build();
        let dir = dir.as_ref().to_path_buf();
        if !dir.join("meta.json").exists() {
            return Err(ContentError::Io(format!(
                "no tantivy index found at {} (meta.json missing)",
                dir.display()
            )));
        }
        let index = Index::open_in_dir(&dir)?;
        let reader = index.reader_builder().try_into()?;

        Ok(Self {
            inner: Arc::new(ContentIndexInner {
                cs,
                index,
                reader,
                writer: None,
                dir,
            }),
        })
    }

    /// Opens an existing index, or creates one if `dir` is empty.
    pub fn open_or_create<P: AsRef<Path>>(
        dir: P,
        config: ContentIndexConfig,
    ) -> Result<Self, ContentError> {
        let cs = ContentSchema::build();
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir).map_err(|e| ContentError::Io(e.to_string()))?;
        let index = if dir.join("meta.json").exists() {
            Index::open_in_dir(&dir)?
        } else {
            Index::create_in_dir(&dir, cs.schema.clone())?
        };
        Self::from_index(index, cs, dir, config)
    }

    fn from_index(
        index: Index,
        cs: ContentSchema,
        dir: PathBuf,
        config: ContentIndexConfig,
    ) -> Result<Self, ContentError> {
        // Default reload policy (OnCommit) keeps the searcher fresh after
        // each commit — no explicit reload_policy call needed on 0.22.
        let reader = index.reader_builder().try_into()?;

        let writer = index.writer_with_num_threads(config.num_threads, config.heap_bytes)?;

        Ok(Self {
            inner: Arc::new(ContentIndexInner {
                cs,
                index,
                reader,
                writer: Some(Mutex::new(writer)),
                dir,
            }),
        })
    }

    /// Directory where this index persists its segments.
    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// The schema handle (field ids) — useful for callers building raw docs.
    pub fn schema(&self) -> &ContentSchema {
        &self.inner.cs
    }

    /// Adds (or updates) a document from a [`FileRow`], reading the file's
    /// content from disk via the reader. Binary / unreadable files are skipped
    /// silently (returns `Ok(false)`); text files are indexed and recorded.
    ///
    /// Because tantivy has no in-place update, an update is implemented as a
    /// delete of the old `file_id` term followed by an add — both visible only
    /// after `commit()`.
    pub fn upsert_file(
        &self,
        row: &FileRow,
        policy: &IngestPolicy,
    ) -> Result<bool, ContentError> {
        if !policy.accepts(&row.path, row.size) {
            return Ok(false);
        }
        let content = match read_indexable(Path::new(&row.path), policy.max_read_bytes) {
            ReadOutcome::Text(t) => t,
            ReadOutcome::Binary => return Ok(false),
            ReadOutcome::Error(_) => return Ok(false),
        };
        self.upsert_row(row, &content)
    }

    /// Adds (or updates) a document from an already-read content string.
    /// Callers that already hold the text (e.g. tests, or a batch reader)
    /// can use this to avoid a redundant disk read.
    pub fn upsert_row(&self, row: &FileRow, content: &str) -> Result<bool, ContentError> {
        let cs = &self.inner.cs;
        let mut doc = TantivyDocument::default();
        doc.add_text(cs.path, &row.path);
        doc.add_u64(cs.file_id, row.frn);
        doc.add_date(cs.mtime, filetime_to_datetime(row.mtime_filetime));
        doc.add_text(cs.ext, ext_of(&row.path));
        doc.add_u64(cs.size, row.size);
        doc.add_text(cs.content, content);
        doc.add_text(cs.project_tag, &row.project_tag);

        // Delete old version (if any) then add the new one.
        let term = file_id_term(cs.file_id, row.frn);
        let writer_mutex = self.inner.writer.as_ref().ok_or_else(|| {
            ContentError::Tantivy("cannot write to content index opened in read-only mode".to_string())
        })?;
        let writer = writer_mutex.lock().unwrap();
        writer.delete_term(term);
        writer.add_document(doc)?;
        Ok(true)
    }

    /// Deletes the document with the given FRN. Visible after `commit()`.
    pub fn delete(&self, frn: u64) -> Result<(), ContentError> {
        let term = file_id_term(self.inner.cs.file_id, frn);
        let writer_mutex = self.inner.writer.as_ref().ok_or_else(|| {
            ContentError::Tantivy("cannot write to content index opened in read-only mode".to_string())
        })?;
        let writer = writer_mutex.lock().unwrap();
        writer.delete_term(term);
        Ok(())
    }

    /// Deletes all documents (rebuild support). Visible after `commit()`.
    pub fn delete_all(&self) -> Result<(), ContentError> {
        let writer_mutex = self.inner.writer.as_ref().ok_or_else(|| {
            ContentError::Tantivy("cannot write to content index opened in read-only mode".to_string())
        })?;
        let writer = writer_mutex.lock().unwrap();
        writer.delete_all_documents()?;
        Ok(())
    }

    /// Commits all pending add/delete operations. Blocks until persisted,
    /// then refreshes the searcher so subsequent reads see the new state.
    pub fn commit(&self) -> Result<(), ContentError> {
        if let Some(writer_mutex) = &self.inner.writer {
            let mut writer = writer_mutex.lock().unwrap();
            writer.commit()?;
        }
        // Default reload policy is Manual — refresh the reader explicitly so
        // search_bm25 / num_docs reflect the just-committed state.
        self.inner.reader.reload()?;
        Ok(())
    }

    /// Incremental ingest: given an iterator of file rows, index only those
    /// that changed per `state`, applying add/update/delete ops to keep the
    /// tantivy index in sync. Returns the number of documents touched.
    ///
    /// This does NOT auto-commit — call `commit()` afterwards (the recommended
    /// batch pattern: ingest many rows, then one commit).
    pub fn ingest_rows<I>(
        &self,
        rows: I,
        policy: &IngestPolicy,
        state: &mut crate::ingest::IngestState,
    ) -> Result<usize, ContentError>
    where
        I: IntoIterator<Item = FileRow>,
    {
        let mut touched = 0usize;
        for row in rows {
            // Skip files that don't pass the extension/size filter but still
            // drop them from state so a later-eligible file is re-added.
            if !policy.accepts(&row.path, row.size) {
                state.forget(row.frn);
                continue;
            }
            match state.classify_and_record(&row) {
                crate::ingest::Change::Unchanged => continue,
                crate::ingest::Change::Add | crate::ingest::Change::Update => {
                    if self.upsert_file(&row, policy)? {
                        touched += 1;
                    }
                }
            }
        }
        Ok(touched)
    }

    /// Runs a BM25 query against the content (and optionally metadata) fields.
    /// Returns up to `limit` ranked hits, each with an HTML snippet.
    pub fn search_bm25(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ContentHit>, ContentError> {
        let searcher = self.inner.reader.searcher();
        let cs = &self.inner.cs;

        // Parse against content + metadata fields so `ext:rs` / `path:...`
        // style terms also work in the same query string.
        let parser = QueryParser::for_index(
            &self.inner.index,
            vec![cs.content, cs.path, cs.ext, cs.project_tag],
        );
        let parsed = parser.parse_query(query)?;

        let top = searcher.search(&parsed, &TopDocs::with_limit(limit))?;

        // Build a snippet generator for the content field (best-effort: if the
        // query has no content-term the generator may still work on path terms
        // — we always target `content`).
        let snippet_gen = SnippetGenerator::create(&searcher, &*parsed, cs.content).ok();

        let mut hits = Vec::with_capacity(top.len());
        for (score, addr) in top {
            let doc: TantivyDocument = searcher.doc(addr)?;
            let frn = doc_u64(&doc, cs.file_id);
            let path = doc_str(&doc, cs.path);
            let ext = doc_str(&doc, cs.ext);
            let size = doc_u64(&doc, cs.size);
            let mtime_unix = doc_date_unix(&doc, cs.mtime);

            let snippet_html = match &snippet_gen {
                Some(gen) => {
                    let snippet: Snippet = gen.snippet_from_doc(&doc);
                    snippet.to_html()
                }
                None => String::new(),
            };

            hits.push(ContentHit {
                frn,
                path,
                score,
                snippet_html,
                ext,
                size,
                mtime_unix,
            });
        }
        Ok(hits)
    }

    /// Total number of indexed (non-deleted) documents.
    pub fn num_docs(&self) -> u64 {
        self.inner.reader.searcher().num_docs()
    }

    /// Forces a reader reload (normally handled by OnCommit policy).
    pub fn reload(&self) -> Result<(), ContentError> {
        self.inner.reader.reload()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::{FileRow, IngestPolicy, IngestState};

    fn row(frn: u64, path: &str, size: u64, mtime: u64) -> FileRow {
        FileRow {
            frn,
            path: path.to_string(),
            size,
            mtime_filetime: mtime,
            project_tag: "proj".to_string(),
        }
    }

    #[test]
    fn create_add_search_snippet() {
        let dir = tempfile::tempdir().unwrap();
        let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();

        idx.upsert_row(
            &row(1, "C:/p/a.rs", 40, 133_000_000_000_000_000),
            "fn retry_policy() { exponential_backoff(); }",
        )
        .unwrap();
        idx.upsert_row(
            &row(2, "C:/p/b.md", 30, 133_000_000_000_000_000),
            "the retry policy governs http clients and backoff",
        )
        .unwrap();
        idx.commit().unwrap();

        let hits = idx.search_bm25("retry", 10).unwrap();
        assert_eq!(hits.len(), 2);
        // Both docs mention "retry".
        assert!(hits.iter().all(|h| h.snippet_html.to_lowercase().contains("retry")));

        // Snippet highlight uses <b>…</b> around the matched term.
        assert!(hits.iter().any(|h| h.snippet_html.contains("<b>")));
    }

    #[test]
    fn bm25_ranking_prefers_term_frequency() {
        let dir = tempfile::tempdir().unwrap();
        let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();

        // doc 1 mentions "banana" once, doc 2 mentions it many times.
        idx.upsert_row(&row(1, "a.txt", 20, 1), "banana is a fruit").unwrap();
        idx.upsert_row(
            &row(2, "b.txt", 60, 1),
            "banana banana banana banana banana smoothie",
        )
        .unwrap();
        idx.commit().unwrap();

        let hits = idx.search_bm25("banana", 10).unwrap();
        assert_eq!(hits.len(), 2);
        // The high-frequency doc must rank first.
        assert_eq!(hits[0].frn, 2);
        assert!(hits[0].score >= hits[1].score);
    }

    #[test]
    fn update_via_delete_then_add() {
        let dir = tempfile::tempdir().unwrap();
        let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();

        idx.upsert_row(&row(1, "a.rs", 20, 1), "old content about apples").unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.num_docs(), 1);

        // Update the same FRN with new content.
        idx.upsert_row(&row(1, "a.rs", 20, 2), "new content about oranges").unwrap();
        idx.commit().unwrap();

        // Still exactly one doc (update replaced, not appended).
        assert_eq!(idx.num_docs(), 1);

        // Old term gone, new term present.
        assert!(idx.search_bm25("apples", 10).unwrap().is_empty());
        let hits = idx.search_bm25("oranges", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].frn, 1);
    }

    #[test]
    fn delete_removes_doc() {
        let dir = tempfile::tempdir().unwrap();
        let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();

        idx.upsert_row(&row(1, "a.rs", 20, 1), "hello world").unwrap();
        idx.upsert_row(&row(2, "b.rs", 20, 1), "hello mars").unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.num_docs(), 2);

        idx.delete(1).unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.num_docs(), 1);

        let hits = idx.search_bm25("hello", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].frn, 2);
    }

    #[test]
    fn incremental_ingest_skips_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();
        let policy = IngestPolicy::default();
        let mut state = IngestState::new();

        // ingest_rows reads content from disk — the row path must be a real file.
        let file_path = dir.path().join("a.rs");
        std::fs::write(&file_path, "fn alpha() {}").unwrap();
        let path_str = file_path.to_string_lossy().replace('\\', "/");
        let size = std::fs::metadata(&file_path).unwrap().len();

        let a = row(1, &path_str, size, 100);
        // First pass: add.
        let touched = idx.ingest_rows(vec![a.clone()], &policy, &mut state).unwrap();
        assert_eq!(touched, 1);
        idx.commit().unwrap();

        // Second pass, identical row: no change → nothing touched.
        let touched = idx.ingest_rows(vec![a.clone()], &policy, &mut state).unwrap();
        assert_eq!(touched, 0);

        // Third pass, changed mtime: update.
        let a2 = row(1, &path_str, size, 200);
        let touched = idx.ingest_rows(vec![a2], &policy, &mut state).unwrap();
        assert_eq!(touched, 1);
        idx.commit().unwrap();
        assert_eq!(idx.num_docs(), 1);
    }

    #[test]
    fn persistence_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let idx = ContentIndex::create(dir.path(), ContentIndexConfig::default()).unwrap();
            idx.upsert_row(&row(7, "C:/x/main.rs", 40, 1), "fn persist() {}").unwrap();
            idx.commit().unwrap();
        }
        // Reopen from disk.
        let idx = ContentIndex::open(dir.path(), ContentIndexConfig::default()).unwrap();
        assert_eq!(idx.num_docs(), 1);
        let hits = idx.search_bm25("persist", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].frn, 7);
        assert_eq!(hits[0].path, "C:/x/main.rs");
        assert_eq!(hits[0].ext, "rs");
    }
}
