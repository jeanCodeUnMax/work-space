//! agentmemory — store JSON par projet, absorbé en Rust.
//!
//! Format identique au serveur Node historique pour rester compatible :
//! `<root>/<projectId>/agentmemory/data.json`
//! ```json
//! {"cache": [["<projectId>:<key>", {"value": "<json-string>", "expires": null}]],
//!  "lastExpire": <ms>}
//! ```
//! La valeur interne est un objet mémoire sérialisé :
//! {id, projectId, key, type, content, tags, relationships, metadata, createdAt, updatedAt}

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::memory_root;

static LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

const MEMORY_TYPES: &[&str] = &[
    "architecture",
    "pattern",
    "feature",
    "api",
    "bug",
    "decision",
];

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn store_path(project_id: &str) -> PathBuf {
    memory_root()
        .join(project_id)
        .join("agentmemory")
        .join("data.json")
}

fn load_store(project_id: &str) -> Value {
    let path = store_path(project_id);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .unwrap_or_else(|_| json!({"cache": [], "lastExpire": 0})),
        Err(_) => json!({"cache": [], "lastExpire": 0}),
    }
}

fn save_store(project_id: &str, store: &Value) -> Result<Value, String> {
    let path = store_path(project_id);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(store).unwrap_or_default())
        .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename -> {}: {}", path.display(), e))?;
    Ok(json!({"path": path.to_string_lossy()}))
}

fn full_key(project_id: &str, key: &str) -> String {
    format!("{}:{}", project_id, key)
}

fn cache_get<'a>(store: &'a Value, fkey: &str) -> Option<&'a Value> {
    store["cache"].as_array()?.iter().find(|e| {
        e.as_array()
            .and_then(|pair| pair.first())
            .and_then(|k| k.as_str())
            == Some(fkey)
    }).and_then(|e| e.as_array()?.get(1))
}

fn cache_get_mut<'a>(store: &'a mut Value, fkey: &str) -> Option<&'a mut Value> {
    let arr = store["cache"].as_array_mut()?;
    arr.iter_mut().find(|e| {
        e.as_array()
            .and_then(|pair| pair.first())
            .and_then(|k| k.as_str())
            == Some(fkey)
    }).and_then(|e| e.as_array_mut()?.get_mut(1))
}

fn is_expired(entry: &Value) -> bool {
    entry["expires"]
        .as_u64()
        .map(|exp| exp <= now_ms())
        .unwrap_or(false)
}

fn entry_to_memory(entry: &Value) -> Option<Value> {
    if is_expired(entry) {
        return None;
    }
    let raw = entry["value"].as_str()?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    parsed.get("value").cloned()
}

fn valid_type(t: &str) -> bool {
    MEMORY_TYPES.contains(&t)
}

pub fn tool_project_init(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"]
        .as_str()
        .ok_or("projectId requis")?;
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let store = load_store(project_id);
    save_store(project_id, &store)?;
    Ok(json!({"projectId": project_id, "initialized": true, "path": store_path(project_id).to_string_lossy()}))
}

pub fn tool_memory_write(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str().ok_or("projectId requis")?;
    let key = args["key"].as_str().ok_or("key requis")?;
    let mtype = args["type"].as_str().ok_or("type requis")?;
    let content = args["content"].as_str().ok_or("content requis")?;
    // Types canoniques de l'implémentation Node ; on accepte les autres en
    // les marquant pour ne pas casser les writers existants.
    let type_flag = if valid_type(mtype) { "canonical" } else { "custom" };
    let tags = args.get("tags").cloned().unwrap_or_else(|| json!([]));
    let relationships = args.get("relationships").cloned().unwrap_or_else(|| {
        json!({"dependsOn": [], "implements": []})
    });
    let now = now_ms();
    let mem = json!({
        "id": format!("{:x}-{:x}", now, rand_suffix()),
        "projectId": project_id,
        "key": key,
        "type": mtype,
        "content": content,
        "tags": tags,
        "relationships": relationships,
        "metadata": {"accessCount": 0, "createdBy": "agent"},
        "createdAt": now,
        "updatedAt": now,
    });
    let fkey = full_key(project_id, key);
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let mut store = load_store(project_id);
    let entry = json!([fkey.clone(), {"value": serde_json::to_string(&json!({"value": mem, "expires": null})).unwrap_or_default(), "expires": null}]);
    if cache_get(&store, &fkey).is_some() {
        *cache_get_mut(&mut store, &fkey).unwrap() = entry[1].clone();
    } else {
        store["cache"]
            .as_array_mut()
            .ok_or("cache corrompu")?
            .push(entry);
    }
    save_store(project_id, &store)?;
    Ok(json!({"stored": true, "key": key, "projectId": project_id, "type_check": type_flag}))
}

fn rand_suffix() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    now_ms().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    h.finish()
}

pub fn tool_memory_read(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str().ok_or("projectId requis")?;
    let key = args["key"].as_str().ok_or("key requis")?;
    let fkey = full_key(project_id, key);
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let store = load_store(project_id);
    let entry = cache_get(&store, &fkey);
    let mem = entry.and_then(entry_to_memory);
    match mem {
        Some(m) => Ok(json!({"found": true, "memory": m})),
        None => Ok(json!({"found": false, "key": key, "projectId": project_id})),
    }
}

pub fn tool_memory_search(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str().ok_or("projectId requis")?;
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let tags: Vec<String> = args["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mtype = args["type"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(10) as usize;

    let _g = LOCK.lock().map_err(|_| "lock")?;
    let store = load_store(project_id);
    let mut out = Vec::new();
    for e in store["cache"].as_array().cloned().unwrap_or_default() {
        let Some(entry) = e.as_array().and_then(|p| p.get(1)) else { continue };
        let Some(mem) = entry_to_memory(entry) else { continue };
        if mem["projectId"].as_str() != Some(project_id) {
            continue;
        }
        if let Some(t) = mtype {
            if mem["type"].as_str() != Some(t) {
                continue;
            }
        }
        if !tags.is_empty() {
            let mtags: Vec<String> = mem["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if !tags.iter().any(|t| mtags.iter().any(|m| m == t)) {
                continue;
            }
        }
        if !query.is_empty() {
            let hay = format!(
                "{} {} {}",
                mem["key"].as_str().unwrap_or(""),
                mem["content"].as_str().unwrap_or(""),
                mem["tags"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default()
            )
            .to_lowercase();
            if !hay.contains(&query) {
                continue;
            }
        }
        out.push(mem);
        if out.len() >= limit {
            break;
        }
    }
    Ok(json!({"projectId": project_id, "count": out.len(), "memories": out}))
}

pub fn tool_memory_list(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str().ok_or("projectId requis")?;
    let mtype = args["type"].as_str();
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let store = load_store(project_id);
    let mut out = Vec::new();
    for e in store["cache"].as_array().cloned().unwrap_or_default() {
        let Some(entry) = e.as_array().and_then(|p| p.get(1)) else { continue };
        let Some(mem) = entry_to_memory(entry) else { continue };
        if mem["projectId"].as_str() != Some(project_id) {
            continue;
        }
        if let Some(t) = mtype {
            if mem["type"].as_str() != Some(t) {
                continue;
            }
        }
        out.push(json!({
            "key": mem["key"], "type": mem["type"], "tags": mem["tags"],
            "updatedAt": mem["updatedAt"],
            "preview": mem["content"].as_str().map(|c| c.chars().take(120).collect::<String>()),
        }));
    }
    Ok(json!({"projectId": project_id, "count": out.len(), "memories": out}))
}

pub fn tool_memory_update(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str().ok_or("projectId requis")?;
    let key = args["key"].as_str().ok_or("key requis")?;
    let fkey = full_key(project_id, key);
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let mut store = load_store(project_id);
    let Some(entry) = cache_get(&store, &fkey).cloned() else {
        return Ok(json!({"updated": false, "reason": "not_found", "key": key}));
    };
    let Some(mut mem) = entry_to_memory(&entry) else {
        return Ok(json!({"updated": false, "reason": "expired", "key": key}));
    };
    if let Some(c) = args["content"].as_str() {
        mem["content"] = json!(c);
    }
    if args.get("tags").is_some() {
        mem["tags"] = args["tags"].clone();
    }
    if args.get("relationships").is_some() {
        mem["relationships"] = args["relationships"].clone();
    }
    mem["updatedAt"] = json!(now_ms());
    *cache_get_mut(&mut store, &fkey).unwrap() =
        json!({"value": serde_json::to_string(&json!({"value": mem, "expires": null})).unwrap_or_default(), "expires": null});
    save_store(project_id, &store)?;
    Ok(json!({"updated": true, "key": key, "projectId": project_id}))
}

pub fn tool_memory_stats(args: &Value) -> Result<Value, String> {
    let project_id = args["projectId"].as_str();
    let _g = LOCK.lock().map_err(|_| "lock")?;
    let mut total = 0usize;
    let mut by_type: Map<String, Value> = Map::new();
    let mut size_bytes = 0u64;

    let projects: Vec<String> = match project_id {
        Some(p) => vec![p.to_string()],
        None => fs::read_dir(memory_root())
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default(),
    };
    for p in &projects {
        let path = store_path(p);
        size_bytes += fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let store = load_store(p);
        for e in store["cache"].as_array().cloned().unwrap_or_default() {
            let Some(entry) = e.as_array().and_then(|x| x.get(1)) else { continue };
            let Some(mem) = entry_to_memory(entry) else { continue };
            total += 1;
            let t = mem["type"].as_str().unwrap_or("unknown").to_string();
            let cur = by_type.get(&t).and_then(|v| v.as_u64()).unwrap_or(0);
            by_type.insert(t, json!(cur + 1));
        }
    }
    Ok(json!({
        "totalMemories": total,
        "byType": by_type,
        "totalSize": size_bytes,
        "projects": projects.len(),
        "backend": "hphe-kit (rust, agentmemory-json compatible)",
    }))
}
