//! Ingestion workspace — remplace `.agent/rag/` (Python) + `ingest-workspace.ps1`.
//!
//! Walk d'une racine (avec matcher `.ragignore` + filet SAFETY non-négociable),
//! upsert dans l'index Tantivy (`content_search`), état incrémental persisté,
//! et embedding optionnel vers hphe-vec (`vec_search`/`semantic_search`) via NIM.
//!
//! `hephaistos_update {root, force, embed}` = "Hephaistos update force".

use hphe_content::{ContentIndex, ContentIndexConfig, FileRow, IngestPolicy};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

use once_cell::sync::Lazy;

/// Filet de sécurité NON négociable : jamais indexable, même si .ragignore
/// contiendrait une négation (port fidèle du RagIgnore Python).
const SAFETY_PATTERNS: &[&str] = &[
    ".git/", ".env", ".env.*", "*.key", "*.pem", "*.pfx", "*.db", "*.db-shm",
    "*.db-wal", ".venv/", "venv/", "node_modules/", "__pycache__/",
    "memory-database/", "*.usearch", "*.exe", "*.dll", "*.vsix",
];

// ---------------------------------------------------------------------------
// .ragignore — sous-ensemble gitignore (même sémantique que le Python)
// ---------------------------------------------------------------------------

struct RagRule {
    neg: bool,
    re: regex::Regex,
}

pub struct RagIgnore {
    rules: Vec<RagRule>,
    root: PathBuf,
}

impl RagIgnore {
    pub fn load(root: &Path) -> Self {
        let mut rules = Vec::new();
        let file = root.join(".ragignore");
        if let Ok(content) = std::fs::read_to_string(&file) {
            for raw in content.lines() {
                if let Some(rule) = Self::compile(raw) {
                    rules.push(rule);
                }
            }
        }
        Self {
            rules,
            root: root.to_path_buf(),
        }
    }

    fn compile(line: &str) -> Option<RagRule> {
        let mut line = line.trim().to_string();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let mut neg = false;
        if let Some(rest) = line.strip_prefix('!') {
            neg = true;
            line = rest.trim().to_string();
        }
        if line.is_empty() {
            return None;
        }
        if line.ends_with('/') {
            line.pop();
        }
        let anchored = line.contains('/');
        let line = line.trim_start_matches('/').to_string();
        if line.is_empty() {
            return None;
        }
        let mut body = String::new();
        let bytes: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                '*' => {
                    if i + 1 < bytes.len() && bytes[i + 1] == '*' {
                        body.push_str(".*");
                        i += 2;
                    } else {
                        body.push_str("[^/]*");
                        i += 1;
                    }
                }
                '?' => {
                    body.push_str("[^/]");
                    i += 1;
                }
                c => {
                    body.push_str(&regex::escape(&c.to_string()));
                    i += 1;
                }
            }
        }
        let pattern = if anchored {
            format!("^{}(/|$)", body)
        } else {
            format!("(^|/){}(/|$)", body)
        };
        regex::Regex::new(&pattern)
            .ok()
            .map(|re| RagRule { neg, re })
    }

    /// Décide si `path` (absolu) est ignoré. Dernière règle qui matche gagne ;
    /// SAFETY_PATTERNS court-circuitent toujours.
    pub fn is_ignored(&self, path: &Path) -> bool {
        let rel = match path.strip_prefix(&self.root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => return false, // hors root : pas notre affaire
        };
        // filet de sécurité d'abord
        for pat in SAFETY_PATTERNS {
            if let Some(rule) = Self::compile(pat) {
                if rule.re.is_match(&format!("/{}/", rel)) {
                    return true;
                }
            }
        }
        let mut excluded = false;
        for r in &self.rules {
            if r.re.is_match(&format!("/{}", rel)) || r.re.is_match(&rel) {
                excluded = !r.neg;
            }
        }
        excluded
    }
}

// ---------------------------------------------------------------------------
// ID fichier stable (pas de FRN côté workspace : hash FNV-1a du chemin)
// ---------------------------------------------------------------------------

fn file_id(path: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_lowercase().replace('\\', "/").as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h & 0x7fff_ffff_ffff_ffff // clé usearch positive
}

// ---------------------------------------------------------------------------
// État incrémental persisté (remplace ingestion.state.json / index-state.json)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct IngestStateFile {
    files: HashMap<String, (u64, u64)>, // path -> (size, mtime_secs)
}

fn state_path(index_dir: &Path) -> PathBuf {
    index_dir.join("ingest-state.json")
}

fn load_state(index_dir: &Path) -> IngestStateFile {
    let mut st = IngestStateFile::default();
    if let Ok(raw) = std::fs::read_to_string(state_path(index_dir)) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(files) = v["files"].as_object() {
                for (p, meta) in files {
                    st.files.insert(
                        p.clone(),
                        (
                            meta["size"].as_u64().unwrap_or(0),
                            meta["mtime"].as_u64().unwrap_or(0),
                        ),
                    );
                }
            }
        }
    }
    st
}

fn save_state(index_dir: &Path, st: &IngestStateFile) {
    let mut files = Map::new();
    for (p, (size, mtime)) in &st.files {
        files.insert(p.clone(), json!({"size": size, "mtime": mtime}));
    }
    let _ = std::fs::write(
        state_path(index_dir),
        serde_json::to_string(&json!({"files": files})).unwrap_or_default(),
    );
}

// ---------------------------------------------------------------------------
// Répertoires d'index (même résolution que le tool content_search)
// ---------------------------------------------------------------------------

pub fn content_dir() -> PathBuf {
    if let Ok(v) = std::env::var("HPHE_CONTENT_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let c = parent.join("data").join("content-index");
            if c.exists() {
                return c;
            }
        }
    }
    PathBuf::from("data").join("content-index")
}

pub fn vec_dir() -> PathBuf {
    if let Ok(v) = std::env::var("HPHE_VEC_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for cand in [
                parent.join("migrated-vec"),
                parent.join("data").join("vec"),
            ] {
                if cand.exists() {
                    return cand;
                }
            }
        }
    }
    PathBuf::from("migrated-vec")
}

// ---------------------------------------------------------------------------
// Walk + ingest Tantivy
// ---------------------------------------------------------------------------

fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Ingestion Tantivy d'une racine. Incrémentale sauf `force`.
/// Retourne des stats JSON ; ne panique jamais sur un fichier illisible.
pub fn ingest_workspace(
    root: &Path,
    index_dir: &Path,
    force: bool,
    max_files: usize,
    project_tag: &str,
) -> Result<Value, String> {
    std::fs::create_dir_all(index_dir).map_err(|e| e.to_string())?;
    let index = ContentIndex::open_or_create(index_dir, ContentIndexConfig::default())
        .map_err(|e| format!("content index {}: {}", index_dir.display(), e))?;
    let policy = IngestPolicy::default();
    let ignore = RagIgnore::load(root);
    let mut state = load_state(index_dir);

    let (mut added, mut updated, mut unchanged, mut skipped) = (0u64, 0u64, 0u64, 0u64);
    let mut errors: Vec<String> = Vec::new();
    let mut seen_paths: Vec<String> = Vec::new();
    let mut changed_files: Vec<(String, PathBuf, u64, u64)> = Vec::new();
    let mut scanned = 0usize;

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !ignore.is_ignored(e.path()))
    {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if !policy.accepts(&path.to_string_lossy(), size) {
            skipped += 1;
            continue;
        }
        scanned += 1;
        if scanned > max_files {
            break;
        }
        let rel = path
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        seen_paths.push(rel.clone());
        let mtime = mtime_secs(path);
        if !force {
            if let Some(&(osize, omtime)) = state.files.get(&rel) {
                if osize == size && omtime == mtime {
                    unchanged += 1;
                    continue;
                }
            }
        }
        let was_present = state.files.contains_key(&rel);
        let row = FileRow {
            frn: file_id(&path.to_string_lossy()),
            path: path.to_string_lossy().to_string(),
            size,
            mtime_filetime: unix_to_filetime(mtime),
            project_tag: project_tag.to_string(),
        };
        match index.upsert_file(&row, &policy) {
            Ok(true) => {
                changed_files.push((rel.clone(), path.to_path_buf(), size, mtime));
                state.files.insert(rel, (size, mtime));
                if was_present {
                    updated += 1;
                } else {
                    added += 1;
                }
            }
            Ok(false) => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", rel, e)),
        }
    }

    // fichiers disparus du disque -> delete_term
    let mut deleted = 0u64;
    let existing: Vec<String> = seen_paths.clone();
    let gone: Vec<String> = state
        .files
        .keys()
        .filter(|k| !existing.contains(k))
        .cloned()
        .collect();
    for rel in &gone {
        // on a besoin du frn = hash du chemin absolu ; on le re-derive du rel
        let abs = root.join(rel.replace('/', "\\"));
        let _ = index.delete(file_id(&abs.to_string_lossy()));
        state.files.remove(rel);
        deleted += 1;
    }

    index.commit().map_err(|e| format!("commit: {}", e))?;
    save_state(index_dir, &state);

    // Miroir KG local (memory_mcp.db + graph-memory.db) — port du dual-SQLite
    // d'ingest-workspace.ps1. Seuls les fichiers CHANGÉS sont (re)écrits :
    // les entités des fichiers inchangés existent déjà.
    let kg = mirror_kg(root, project_tag, &changed_files, &gone, seen_paths.len());
    if let Err(e) = &kg {
        errors.push(format!("kg mirror: {}", e));
    }

    Ok(json!({
        "root": root.to_string_lossy(),
        "index_dir": index_dir.to_string_lossy(),
        "force": force,
        "scanned": scanned,
        "added": added,
        "updated": updated,
        "unchanged": unchanged,
        "skipped": skipped,
        "deleted": deleted,
        "kg": kg.unwrap_or_else(|e| json!({"error": e})),
        "errors": errors,
        "total_docs": index.num_docs(),
    }))
}

// ---------------------------------------------------------------------------
// Miroir KG local — entities/observations/relations (memory_mcp.db) +
// edges (graph-memory.db), schéma identique à ingest-workspace.ps1.
// Ecrit sous <root>/memory-database/agentmemory/graph/.
// ---------------------------------------------------------------------------

fn sha256_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(hex_lower(&Sha256::digest(&bytes)))
}

fn sha256_str(s: &str) -> String {
    hex_lower(&Sha256::digest(s.as_bytes()))
}

fn hex_lower(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn mirror_kg(
    root: &Path,
    project_id: &str,
    changed: &[(String, PathBuf, u64, u64)],
    gone: &[String],
    total_files: usize,
) -> Result<Value, String> {
    if changed.is_empty() && gone.is_empty() {
        return Ok(json!({"entities_written": 0, "entities_deleted": 0, "note": "aucun changement"}));
    }
    let dir = root
        .join("memory-database")
        .join("agentmemory")
        .join("graph");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let mem_db = dir.join("memory_mcp.db");
    let graph_db = dir.join("graph-memory.db");
    let workspace_entity = format!("workspace:{}", project_id);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut written = 0u64;
    {
        let mut conn = rusqlite::Connection::open(&mem_db)
            .map_err(|e| format!("open {}: {}", mem_db.display(), e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;
             CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, entityType TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
             CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER NOT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE);
             CREATE TABLE IF NOT EXISTS relations (id INTEGER PRIMARY KEY AUTOINCREMENT, from_entity TEXT NOT NULL, to_entity TEXT NOT NULL, relationType TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(from_entity, to_entity, relationType));",
        )
        .map_err(|e| format!("schema memory_mcp: {}", e))?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO entities (name, entityType) VALUES (?1, 'workspace')",
            [&workspace_entity],
        )
        .map_err(|e| e.to_string())?;
        for (rel, abs, size, mtime) in changed {
            let file_entity = format!("file:{}", sha256_str(rel));
            let sha = sha256_file(abs).unwrap_or_default();
            let meta = format!("path={}|sha256={}|size={}|mtime={}", rel, sha, size, mtime);
            tx.execute(
                "INSERT OR IGNORE INTO entities (name, entityType) VALUES (?1, 'file')",
                [&file_entity],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM observations WHERE entity_id=(SELECT id FROM entities WHERE name=?1)",
                [&file_entity],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO observations (entity_id, content) VALUES ((SELECT id FROM entities WHERE name=?1), ?2)",
                rusqlite::params![file_entity, meta],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO relations (from_entity, to_entity, relationType) VALUES (?1, ?2, 'contains')",
                rusqlite::params![workspace_entity, file_entity],
            )
            .map_err(|e| e.to_string())?;
            written += 1;
        }
        for rel in gone {
            let file_entity = format!("file:{}", sha256_str(rel));
            tx.execute(
                "DELETE FROM relations WHERE from_entity=?1 AND to_entity=?2 AND relationType='contains'",
                rusqlite::params![workspace_entity, file_entity],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM observations WHERE entity_id=(SELECT id FROM entities WHERE name=?1)",
                [&file_entity],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM entities WHERE name=?1", [&file_entity])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    {
        let mut conn = rusqlite::Connection::open(&graph_db)
            .map_err(|e| format!("open {}: {}", graph_db.display(), e))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;
             CREATE TABLE IF NOT EXISTS edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(from_id, to_id, type));",
        )
        .map_err(|e| format!("schema graph-memory: {}", e))?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (rel, ..) in changed {
            let file_entity = format!("file:{}", sha256_str(rel));
            tx.execute(
                "INSERT INTO edges (from_id, to_id, type, created_at) VALUES (?1, ?2, 'contains', ?3) ON CONFLICT(from_id, to_id, type) DO UPDATE SET created_at=excluded.created_at",
                rusqlite::params![workspace_entity, file_entity, now.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        for rel in gone {
            let file_entity = format!("file:{}", sha256_str(rel));
            tx.execute(
                "DELETE FROM edges WHERE from_id=?1 AND to_id=?2 AND type='contains'",
                rusqlite::params![workspace_entity, file_entity],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // cache kv (file_count / last_ingest) — même convention que le PS1
    {
        let cache_db = dir.join("../cache/runtime-cache.db");
        if let Some(parent) = std::path::Path::new(&cache_db).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(conn) = rusqlite::Connection::open(&cache_db) {
            let _ = conn.execute_batch(
                "PRAGMA busy_timeout=15000;
                 CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);",
            );
            let _ = conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('file_count', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                rusqlite::params![total_files.to_string(), now.to_string()],
            );
            let _ = conn.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('last_ingest_utc', ?1, ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                [now.to_string()],
            );
        }
    }

    Ok(json!({
        "entities_written": written,
        "entities_deleted": gone.len(),
        "memory_db": mem_db.to_string_lossy(),
        "graph_db": graph_db.to_string_lossy(),
    }))
}

fn unix_to_filetime(secs: u64) -> u64 {
    secs.saturating_mul(10_000_000) + 116_444_736_000_000_000
}

// ---------------------------------------------------------------------------
// Chunking + embedding NIM -> hphe-vec (remplace embedder.py + qdrant/zvec)
// ---------------------------------------------------------------------------

/// Découpe un texte en chunks de ~`max_chars` sur frontières de lignes.
fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if cur.len() + line.len() + 1 > max_chars && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        chunks.push(cur);
    }
    chunks
}

static VEC_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Ingestion vectorielle : chunk -> nim_embed (2048D) -> usearch upsert.
/// `collection` = nom du fichier `<collection>.usearch` dans `vec_dir`.
pub async fn ingest_vectors(
    root: &Path,
    collection: &str,
    max_files: usize,
    project_tag: &str,
) -> Result<Value, String> {
    let dir = vec_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ignore = RagIgnore::load(root);
    let policy = IngestPolicy::default();

    let _g = VEC_LOCK.lock().map_err(|_| "vec lock")?;
    let index = hphe_vec::VecIndex::open_or_create(
        &dir,
        &format!("{}.usearch", collection),
        &hphe_vec::VecIndexConfig::recall_tuned(2048, 100_000),
    )
    .map_err(|e| format!("vec index {}: {}", collection, e))?;

    let mut texts: Vec<String> = Vec::new();
    let mut keys: Vec<u64> = Vec::new();
    let mut files_done = 0usize;
    let mut skipped = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let mut embedded = 0u64;

    let flush = |index: &hphe_vec::VecIndex,
                 texts: &mut Vec<String>,
                 keys: &mut Vec<u64>,
                 embedded: &mut u64,
                 errors: &mut Vec<String>| {
        if texts.is_empty() {
            return;
        }
        // batch embedding — NIM plafonne l'input : on borne à 32 textes/envoi
        for chunk in texts.chunks(32).zip(keys.chunks(32)) {
            let (batch_txt, batch_keys) = chunk;
            match futures_embed(batch_txt.to_vec()) {
                Ok(vectors) => {
                    for (k, v) in batch_keys.iter().zip(vectors.iter()) {
                        if let Err(e) = index.upsert_vector(*k, v) {
                            errors.push(format!("key {}: {}", k, e));
                        } else {
                            *embedded += 1;
                        }
                    }
                }
                Err(e) => errors.push(format!("embed batch: {}", e)),
            }
        }
        texts.clear();
        keys.clear();
    };

    fn futures_embed(texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        // bridge sync->async : la closure d'ingest est sync, l'embed est async
        let rt = tokio::runtime::Handle::try_current()
            .map_err(|_| "pas de runtime tokio".to_string())?;
        tokio::task::block_in_place(|| {
            rt.block_on(crate::nim::embed_texts(&texts, "passage"))
        })
    }

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !ignore.is_ignored(e.path()))
    {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if !policy.accepts(&path.to_string_lossy(), size) {
            skipped += 1;
            continue;
        }
        files_done += 1;
        if files_done > max_files {
            break;
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            skipped += 1;
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        for (i, chunk) in chunk_text(&content, 1800).into_iter().enumerate() {
            let key = file_id(&format!("{}#{}", path.to_string_lossy(), i));
            // Le texte indexé porte le contexte pour un meilleur retrieval
            texts.push(format!("[{}|{}] {}", project_tag, rel, chunk));
            keys.push(key);
        }
        if texts.len() >= 64 {
            flush(&index, &mut texts, &mut keys, &mut embedded, &mut errors);
        }
    }
    flush(&index, &mut texts, &mut keys, &mut embedded, &mut errors);
    index
        .save(&format!("{}.usearch", collection))
        .map_err(|e| format!("save {}: {}", collection, e))?;
    Ok(json!({
        "collection": collection,
        "dir": dir.to_string_lossy(),
        "files_scanned": files_done,
        "chunks_embedded": embedded,
        "skipped": skipped,
        "errors": errors,
        "index_size": index.len(),
        "dim": index.dimensions(),
    }))
}

// ---------------------------------------------------------------------------
// Outils MCP
// ---------------------------------------------------------------------------

/// `content_ingest {root, force?, max_files?, project_tag?}` — ingestion Tantivy.
pub fn tool_content_ingest(args: &Value) -> Result<Value, String> {
    let root = args["root"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let root = root.canonicalize().map_err(|e| format!("root: {}", e))?;
    let force = args["force"].as_bool().unwrap_or(false);
    let max_files = args["max_files"].as_u64().unwrap_or(100_000) as usize;
    let tag = args["project_tag"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace")
                .to_string()
        });
    let dir = args["index_dir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(content_dir);
    ingest_workspace(&root, &dir, force, max_files, &tag)
}

/// `hephaistos_update {root, force?, embed?, collection?, max_files?}` —
/// "Hephaistos update force" : (ré)ingère Tantivy + optionnel vecteurs.
pub async fn tool_hephaistos_update(args: &Value) -> Result<Value, String> {
    let root = args["root"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let root = root.canonicalize().map_err(|e| format!("root: {}", e))?;
    let force = args["force"].as_bool().unwrap_or(false);
    let embed = args["embed"].as_bool().unwrap_or(false);
    let max_files = args["max_files"].as_u64().unwrap_or(100_000) as usize;
    let tag = args["project_tag"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace")
                .to_string()
        });
    let collection = args["collection"]
        .as_str()
        .unwrap_or("workspace_index")
        .to_string();

    let content = ingest_workspace(&root, &content_dir(), force, max_files, &tag)?;
    let vectors = if embed {
        Some(ingest_vectors(&root, &collection, max_files, &tag).await?)
    } else {
        None
    };
    Ok(json!({
        "status": "ok",
        "content": content,
        "vectors": vectors,
        "backend": "hphe-kit (rust) — remplace .agent/rag/cli.py + ingest-workspace.ps1",
    }))
}
