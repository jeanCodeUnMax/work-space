//! Real Content Search tool backed by hphe-content (Tantivy BM25)
//!
//! Provides BM25 full-text search with HTML snippets.
//! Lazy initialization: cold start does not load the index until requested.
//! If the index is absent, cleanly returns { "status": "index_absent", "matches": [] } without crashing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use tracing::{info, warn};

use hphe_content::ContentIndex;

static CONTENT_CACHE: OnceCell<Mutex<HashMap<PathBuf, ContentIndex>>> = OnceCell::new();

/// Resolves the content index directory.
/// Checked in order:
/// 1. `HPHE_CONTENT_DIR` environment variable
/// 2. `data/content-index` relative to executable parent
/// 3. `data/content-index` relative to current working directory
pub fn get_content_dir() -> PathBuf {
    if let Ok(val) = std::env::var("HPHE_CONTENT_DIR") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("data").join("content-index");
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from("data").join("content-index")
}

/// Attempts to get or lazily open the ContentIndex for the given directory.
/// Returns None if the index directory does not exist or does not contain meta.json.
pub fn get_or_open_content_index(dir: &Path) -> Option<ContentIndex> {
    if !dir.exists() || !dir.join("meta.json").exists() {
        return None;
    }

    let cache = CONTENT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();

    if let Some(idx) = guard.get(dir) {
        return Some(idx.clone());
    }

    match ContentIndex::open_read_only(dir) {
        Ok(idx) => {
            info!(path = %dir.display(), docs = idx.num_docs(), "Opened Tantivy content index in read-only mode");
            guard.insert(dir.to_path_buf(), idx.clone());
            Some(idx)
        }
        Err(e) => {
            warn!(path = %dir.display(), error = %e, "Failed to open Tantivy content index");
            None
        }
    }
}

/// MCP tool: `content_search { query, limit? }`
/// Returns ranked BM25 hits [{ path, score, snippet }] or clean index_absent response.
pub fn tool_content_search(args: &Value) -> Result<Value, String> {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) => q,
        None => return Err("Missing required parameter 'query'".to_string()),
    };

    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(50) as usize;

    let dir = args
        .get("dir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(get_content_dir);

    let index = match get_or_open_content_index(&dir) {
        Some(idx) => idx,
        None => {
            return Ok(json!({
                "status": "index_absent",
                "query": query,
                "matches": []
            }));
        }
    };

    match index.search_bm25(query, limit) {
        Ok(hits) => {
            let matches: Vec<Value> = hits
                .into_iter()
                .map(|hit| {
                    json!({
                        "path": hit.path,
                        "score": hit.score,
                        "snippet": hit.snippet_html,
                        "frn": hit.frn,
                        "ext": hit.ext,
                        "size": hit.size
                    })
                })
                .collect();

            Ok(json!({
                "status": "ok",
                "query": query,
                "total": matches.len(),
                "matches": matches
            }))
        }
        Err(e) => Ok(json!({
            "status": "query_error",
            "query": query,
            "error": e.to_string(),
            "matches": []
        })),
    }
}
