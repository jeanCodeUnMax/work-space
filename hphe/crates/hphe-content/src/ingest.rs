//! Incremental ingest policy: which files are indexable, and how a
//! [`ContentIndex`](crate::ContentIndex) pulls new/changed content from a
//! [`FileIndex`](hphe_index::FileIndex) (or any row iterator).
//!
//! The design goal is "relier l'ingest incrémental à FileIndex": the caller
//! supplies an iterator of `(frn, path, size, mtime_filetime)` rows and the
//! ingest layer decides which ones to (re)index based on extension + size,
//! tracks a per-file `mtime` snapshot so unchanged files are skipped on the
//! next pass, and emits the operations needed to keep the tantivy index in
//! sync (add / update / delete).

use std::collections::HashMap;
use std::path::Path;

/// Default set of indexable extensions (source code + plain text + docs).
///
/// Deliberately conservative: binary-ish text formats (pdf, docx, xlsx …) are
/// NOT here because [`read_indexable`](crate::reader::read_indexable) would
/// skip them anyway; keeping the list tight avoids wasted file opens.
pub const DEFAULT_INDEXABLE_EXTS: &[&str] = &[
    // Rust / systems
    "rs", "toml", "lock",
    // Web / markup
    "html", "htm", "xhtml", "css", "scss", "sass", "less", "js", "jsx", "ts",
    "tsx", "vue", "svelte", "json", "yaml", "yml", "xml", "svg",
    // Docs / prose
    "md", "markdown", "txt", "rst", "adoc", "tex", "org", "csv", "tsv",
    // Scripts / config
    "py", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
    "c", "h", "cpp", "cxx", "cc", "hpp", "hh", "cs", "java", "kt", "kts",
    "go", "rb", "php", "pl", "pm", "lua", "r", "jl", "scala", "swift",
    "sql", "graphql", "gql", "proto", "ini", "cfg", "conf", "env", "gitignore",
    "dockerfile", "makefile", "mk", "cmake", "gradle", "properties",
];

/// Extension (lowercased, no dot) of a path.
pub fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Policy controlling which files get indexed and how big a file may be.
#[derive(Debug, Clone)]
pub struct IngestPolicy {
    /// Set of indexable extensions (lowercase, no leading dot).
    pub exts: Vec<String>,
    /// Maximum file size in bytes to index. Larger files are skipped.
    pub max_file_size: u64,
    /// Maximum number of bytes actually read from a file (content cap).
    pub max_read_bytes: usize,
}

impl Default for IngestPolicy {
    fn default() -> Self {
        Self {
            exts: DEFAULT_INDEXABLE_EXTS.iter().map(|s| s.to_string()).collect(),
            max_file_size: 2 * 1024 * 1024,      // 2 MiB
            max_read_bytes: 1024 * 1024,          // 1 MiB of content
        }
    }
}

impl IngestPolicy {
    /// Returns true if a path/size pair passes the extension + size filter.
    pub fn accepts(&self, path: &str, size: u64) -> bool {
        if size == 0 || size > self.max_file_size {
            return false;
        }
        let ext = ext_of(path);
        if ext.is_empty() {
            return false;
        }
        self.exts.iter().any(|e| e == &ext)
    }
}

/// A minimal view of one file row, decoupled from the concrete `FileIndex`
/// so ingest can be unit-tested and reused against other sources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRow {
    /// FRN / unique file id.
    pub frn: u64,
    /// Full path.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Modification time as Windows FILETIME (100ns units since 1601).
    pub mtime_filetime: u64,
    /// Optional project tag.
    pub project_tag: String,
}

/// Incremental-change decision for one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// New file, never indexed → must be added.
    Add,
    /// File changed (mtime/size differ from last indexed) → must be updated
    /// (tantivy: delete_term + add_document).
    Update,
    /// File unchanged since last ingest → skip.
    Unchanged,
}

/// Tracks the last-ingested mtime/size per FRN so an incremental pass only
/// touches files that actually changed. This is the state that survives
/// between ingest runs (serialize it alongside the tantivy index if needed).
#[derive(Debug, Clone, Default)]
pub struct IngestState {
    /// FRN → (mtime_filetime, size) at last successful index.
    seen: HashMap<u64, (u64, u64)>,
}

impl IngestState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Classifies a row against the recorded state and records it as seen.
    ///
    /// NOTE: this mutates state — only call it for rows you actually index.
    pub fn classify_and_record(&mut self, row: &FileRow) -> Change {
        let change = match self.seen.get(&row.frn) {
            None => Change::Add,
            Some(&(mtime, size)) => {
                if mtime == row.mtime_filetime && size == row.size {
                    Change::Unchanged
                } else {
                    Change::Update
                }
            }
        };
        self.seen.insert(row.frn, (row.mtime_filetime, row.size));
        change
    }

    /// Read-only classification (does not record). Useful for dry runs.
    pub fn classify(&self, row: &FileRow) -> Change {
        match self.seen.get(&row.frn) {
            None => Change::Add,
            Some(&(mtime, size)) => {
                if mtime == row.mtime_filetime && size == row.size {
                    Change::Unchanged
                } else {
                    Change::Update
                }
            }
        }
    }

    /// Marks a FRN as no longer present (file deleted) so the caller can drop
    /// it from the content index and forget its snapshot.
    pub fn forget(&mut self, frn: u64) -> bool {
        self.seen.remove(&frn).is_some()
    }

    /// Number of tracked files.
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    /// FRNs currently tracked (for reconciling deletions against a live index).
    pub fn frns(&self) -> impl Iterator<Item = u64> + '_ {
        self.seen.keys().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(frn: u64, path: &str, size: u64, mtime: u64) -> FileRow {
        FileRow {
            frn,
            path: path.to_string(),
            size,
            mtime_filetime: mtime,
            project_tag: "test".to_string(),
        }
    }

    #[test]
    fn ext_of_works() {
        assert_eq!(ext_of("C:\\x\\main.rs"), "rs");
        assert_eq!(ext_of("a/b/c.TXT"), "txt");
        assert_eq!(ext_of("Makefile"), "");
        assert_eq!(ext_of("x.y.z.tar"), "tar"); // last extension only
    }

    #[test]
    fn policy_accepts_and_rejects() {
        let p = IngestPolicy::default();
        assert!(p.accepts("main.rs", 1024));
        assert!(p.accepts("README.md", 500));
        assert!(!p.accepts("photo.png", 1024)); // not indexable ext
        assert!(!p.accepts("main.rs", 0)); // empty
        assert!(!p.accepts("main.rs", p.max_file_size + 1)); // too big
        assert!(!p.accepts("Makefile", 100)); // no ext
    }

    #[test]
    fn incremental_state_classifies() {
        let mut st = IngestState::new();
        let a = row(1, "a.rs", 100, 1000);
        assert_eq!(st.classify_and_record(&a), Change::Add);
        // Same row again → unchanged
        assert_eq!(st.classify_and_record(&a.clone()), Change::Unchanged);
        // Changed mtime → update
        let a2 = row(1, "a.rs", 100, 2000);
        assert_eq!(st.classify_and_record(&a2), Change::Update);
        // New frn → add
        assert_eq!(st.classify_and_record(&row(2, "b.rs", 50, 1)), Change::Add);
        // forget
        assert!(st.forget(1));
        assert!(!st.forget(999));
        assert_eq!(st.len(), 1);
    }
}
