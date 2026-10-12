//! Real Vector Search and Vector Stats tools backed by hphe-vec (usearch)
//!
//! Supports multi-collections by listing `*.usearch` files in HPHE_VEC_DIR.
//! Lazy initialization: collections are opened on demand and cached.
//! If the vector index is absent, cleanly returns { "status": "index_absent", "results": [] } without crashing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use tracing::{info, warn};

use hphe_vec::{VecError, VecHit, VecIndex};

static VEC_CACHE: OnceCell<Mutex<HashMap<PathBuf, VecIndex>>> = OnceCell::new();

/// Resolves the vector index directory.
/// Checked in order:
/// 1. `HPHE_VEC_DIR` environment variable
/// 2. `migrated-vec/` relative to current working directory
/// 3. `data/vec` relative to current working directory
/// 4. `migrated-vec/` or `data/vec` relative to executable parent
pub fn get_vec_dir() -> PathBuf {
    if let Ok(val) = std::env::var("HPHE_VEC_DIR") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    let migrated = PathBuf::from("migrated-vec");
    if migrated.is_dir() {
        return migrated;
    }

    let data_vec = PathBuf::from("data").join("vec");
    if data_vec.is_dir() {
        return data_vec;
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p_migrated = parent.join("migrated-vec");
            if p_migrated.is_dir() {
                return p_migrated;
            }
            let p_data_vec = parent.join("data").join("vec");
            if p_data_vec.is_dir() {
                return p_data_vec;
            }
        }
    }

    migrated
}

/// Lists all `*.usearch` collection files in `dir`, sorted alphabetically.
pub fn list_collections(dir: &Path) -> Vec<PathBuf> {
    if !dir.is_dir() {
        return Vec::new();
    }

    let mut colls = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.to_string_lossy().eq_ignore_ascii_case("usearch") {
                        colls.push(path);
                    }
                }
            }
        }
    }
    colls.sort();
    colls
}

/// Resolves a requested collection name within `dir`.
/// If `requested` is None, returns the first collection found.
pub fn resolve_collection_path(dir: &Path, requested: Option<&str>) -> Result<Option<PathBuf>, String> {
    let colls = list_collections(dir);
    if colls.is_empty() {
        return Ok(None);
    }

    match requested {
        Some(req) if !req.trim().is_empty() => {
            let req_clean = req.trim();
            // Try matching filename or stem
            for p in &colls {
                if let Some(stem) = p.file_stem() {
                    if stem.to_string_lossy().eq_ignore_ascii_case(req_clean) {
                        return Ok(Some(p.clone()));
                    }
                }
                if let Some(name) = p.file_name() {
                    if name.to_string_lossy().eq_ignore_ascii_case(req_clean) {
                        return Ok(Some(p.clone()));
                    }
                }
            }
            // Check direct file existence inside dir
            let direct = dir.join(req_clean);
            if direct.is_file() {
                return Ok(Some(direct));
            }
            let direct_ext = dir.join(format!("{}.usearch", req_clean));
            if direct_ext.is_file() {
                return Ok(Some(direct_ext));
            }
            Err(format!(
                "Collection '{}' not found in {}",
                req_clean,
                dir.display()
            ))
        }
        _ => Ok(Some(colls[0].clone())),
    }
}

/// Gets a cached VecIndex or opens it lazily from disk.
pub fn get_or_open_collection(path: &Path) -> Result<VecIndex, VecError> {
    let cache = VEC_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap();

    if let Some(idx) = guard.get(path) {
        return Ok(idx.clone());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| VecError::Usearch("invalid collection filename".to_string()))?;

    let idx = VecIndex::open(parent, filename)?;
    info!(
        path = %path.display(),
        dim = idx.dimensions(),
        size = idx.len(),
        "Opened usearch vector collection"
    );
    guard.insert(path.to_path_buf(), idx.clone());
    Ok(idx)
}

/// MCP tool: `vec_search { vector?, query_key?, k?, collection? }`
/// Performs k-NN search against the requested (or default first) usearch collection.
pub fn tool_vec_search(args: &Value) -> Result<Value, String> {
    let dir = args
        .get("dir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(get_vec_dir);
    let coll_arg = args.get("collection").and_then(|v| v.as_str());

    let coll_path = match resolve_collection_path(&dir, coll_arg) {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Ok(json!({
                "status": "index_absent",
                "note": format!("No .usearch collections found in {}", dir.display()),
                "results": []
            }));
        }
        Err(err_msg) => {
            return Ok(json!({
                "status": "collection_not_found",
                "error": err_msg,
                "results": []
            }));
        }
    };

    let coll_name = coll_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let idx = match get_or_open_collection(&coll_path) {
        Ok(i) => i,
        Err(e) => {
            warn!(collection = %coll_name, error = %e, "Failed to load vector collection");
            return Ok(json!({
                "status": "load_error",
                "collection": coll_name,
                "error": e.to_string(),
                "results": []
            }));
        }
    };

    let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

    // Resolve the query vector:
    // 1. Explicit `vector: [f32, ...]` array
    // 2. `query_key: u64` (lookup stored vector for that key)
    // 3. `query` string if it parses as u64 FRN key
    let query_vector: Option<Vec<f32>> = if let Some(arr) = args.get("vector").and_then(|v| v.as_array()) {
        let vec: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
        if !vec.is_empty() {
            Some(vec)
        } else {
            None
        }
    } else {
        let key_opt = args
            .get("query_key")
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok())))
            .or_else(|| {
                args.get("query")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
            });

        if let Some(key) = key_opt {
            match idx.get(key) {
                Ok(Some(v)) => Some(v),
                Ok(None) => {
                    return Ok(json!({
                        "status": "key_not_found",
                        "collection": coll_name,
                        "key": key,
                        "results": []
                    }));
                }
                Err(e) => {
                    return Ok(json!({
                        "status": "error",
                        "collection": coll_name,
                        "error": e.to_string(),
                        "results": []
                    }));
                }
            }
        } else {
            None
        }
    };

    let vector = match query_vector {
        Some(v) => v,
        None => {
            return Ok(json!({
                "status": "vector_or_key_required",
                "collection": coll_name,
                "dim": idx.dimensions(),
                "size": idx.len(),
                "note": "vec_search requires 'vector' ([f32]) or 'query_key' (u64 FRN)",
                "results": []
            }));
        }
    };

    match idx.knn(&vector, k) {
        Ok(hits) => {
            let results: Vec<Value> = hits
                .into_iter()
                .map(|hit: VecHit| {
                    json!({
                        "key": hit.key,
                        "distance": hit.distance,
                        "score": (1.0 - hit.distance).max(0.0)
                    })
                })
                .collect();

            Ok(json!({
                "status": "ok",
                "collection": coll_name,
                "k": k,
                "total": results.len(),
                "results": results
            }))
        }
        Err(e) => Ok(json!({
            "status": "search_error",
            "collection": coll_name,
            "error": e.to_string(),
            "results": []
        })),
    }
}

/// MCP tool: `vec_stats {}`
/// Returns statistics across all discovered vector collections.
pub fn tool_vec_stats(args: &Value) -> Result<Value, String> {
    let dir = args
        .get("dir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(get_vec_dir);
    let coll_files = list_collections(&dir);
    let mut collections_info = Vec::new();

    for path in coll_files {
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        match get_or_open_collection(&path) {
            Ok(idx) => {
                collections_info.push(json!({
                    "name": name,
                    "dim": idx.dimensions(),
                    "size": idx.len()
                }));
            }
            Err(e) => {
                collections_info.push(json!({
                    "name": name,
                    "error": e.to_string()
                }));
            }
        }
    }

    Ok(json!({
        "collections": collections_info,
        "backend": "usearch"
    }))
}
