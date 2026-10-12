//! Filesystem tools implementation (parity with fs_tools.py)

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::diff::unified_diff;
use crate::policy::{strip_unc_prefix, AccessPolicy};

fn system_time_to_secs(t: std::io::Result<SystemTime>) -> Option<f64> {
    t.ok().and_then(|st| {
        st.duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs_f64())
    })
}

pub fn tool_fs_read_file(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(1024 * 1024) as usize;

    let checked_path = policy
        .check_allowed(Path::new(path_str), false)
        .map_err(|e| e.to_string())?;

    let mut file = File::open(&checked_path).map_err(|e| format!("Failed to open file: {}", e))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to stat file: {}", e))?;
    let total_size = metadata.len();

    let mut buf = Vec::with_capacity(max_bytes + 1);
    let mut take_handle = (&mut file).take((max_bytes + 1) as u64);
    take_handle
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let truncated = buf.len() > max_bytes;
    if truncated {
        buf.truncate(max_bytes);
    }

    let (content, binary) = match String::from_utf8(buf.clone()) {
        Ok(s) => (s, false),
        Err(_) => (String::from_utf8_lossy(&buf).to_string(), true),
    };

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "size": total_size,
        "truncated": truncated,
        "binary": binary,
        "content": content
    }))
}

pub fn tool_fs_list_directory(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let max_entries = args
        .get("max_entries")
        .and_then(|v| v.as_u64())
        .unwrap_or(1000) as usize;

    let checked_path = policy
        .check_allowed(Path::new(path_str), false)
        .map_err(|e| e.to_string())?;

    let read_dir =
        fs::read_dir(&checked_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut entries = Vec::new();
    let mut truncated = false;

    for (count, entry_res) in read_dir.enumerate() {
        if count >= max_entries {
            truncated = true;
            break;
        }

        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };

        let entry_path = entry.path();
        let entry_lossy = entry_path.to_string_lossy();
        let path_clean = strip_unc_prefix(&entry_lossy);
        if !policy.is_path_allowed(path_clean, false) {
            continue;
        }

        let file_type = entry.file_type().ok();
        let is_dir = file_type.map(|ft| ft.is_dir()).unwrap_or(false);
        let metadata = entry.metadata().ok();

        let size = if !is_dir {
            metadata.as_ref().map(|m| m.len())
        } else {
            None
        };
        let mtime = metadata.and_then(|m| system_time_to_secs(m.modified()));

        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "dir": is_dir,
            "size": size,
            "mtime": mtime
        }));
    }

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "truncated": truncated,
        "entries": entries
    }))
}

pub fn tool_fs_get_info(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let checked_path = policy
        .check_allowed(Path::new(path_str), false)
        .map_err(|e| e.to_string())?;

    let metadata =
        fs::metadata(&checked_path).map_err(|e| format!("Failed to stat path: {}", e))?;

    let is_dir = metadata.is_dir();
    let size = metadata.len();
    let mtime = system_time_to_secs(metadata.modified());
    let ctime = system_time_to_secs(metadata.created());
    let atime = system_time_to_secs(metadata.accessed());
    let readonly = metadata.permissions().readonly();

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "exists": true,
        "dir": is_dir,
        "size": size,
        "mtime": mtime,
        "ctime": ctime,
        "atime": atime,
        "readonly": readonly,
        "attributes": null
    }))
}

pub fn tool_fs_write_file(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'content'".to_string())?;

    let append = args
        .get("append")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let checked_path = policy
        .check_allowed(Path::new(path_str), true)
        .map_err(|e| e.to_string())?;

    if let Some(parent) = checked_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directories: {}", e))?;
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&checked_path)
        .map_err(|e| format!("Failed to open file for writing: {}", e))?;

    let bytes = content.as_bytes();
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write content: {}", e))?;

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "bytes_written": bytes.len(),
        "appended": append
    }))
}

pub fn tool_fs_create_directory(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let checked_path = policy
        .check_allowed(Path::new(path_str), true)
        .map_err(|e| e.to_string())?;

    fs::create_dir_all(&checked_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "created": true
    }))
}

pub fn tool_fs_move(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let source_str = args
        .get("source")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'source'".to_string())?;

    let destination_str = args
        .get("destination")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'destination'".to_string())?;

    let overwrite = args
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let src = policy
        .check_allowed(Path::new(source_str), true)
        .map_err(|e| e.to_string())?;

    let dst = policy
        .check_allowed(Path::new(destination_str), true)
        .map_err(|e| e.to_string())?;

    if dst.exists() && !overwrite {
        return Err(format!("destination exists: {}", dst.display()));
    }

    if let Some(parent) = dst.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create destination directories: {}", e))?;
        }
    }

    fs::rename(&src, &dst).map_err(|e| format!("Failed to move file: {}", e))?;

    Ok(json!({
        "source": strip_unc_prefix(&src.to_string_lossy()),
        "destination": strip_unc_prefix(&dst.to_string_lossy()),
        "moved": true
    }))
}

pub fn tool_fs_delete(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let checked_path = policy
        .check_allowed(Path::new(path_str), true)
        .map_err(|e| e.to_string())?;

    if checked_path.is_dir() {
        if recursive {
            fs::remove_dir_all(&checked_path)
                .map_err(|e| format!("Failed to remove directory recursively: {}", e))?;
        } else {
            fs::remove_dir(&checked_path)
                .map_err(|e| format!("Failed to remove directory: {}", e))?;
        }
    } else {
        fs::remove_file(&checked_path).map_err(|e| format!("Failed to remove file: {}", e))?;
    }

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "deleted": true
    }))
}

pub fn tool_fs_read_multiple_files(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let paths_val = args
        .get("paths")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter 'paths'".to_string())?;

    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(1024 * 1024) as usize;

    let mut files = Vec::new();
    let mut errors: HashMap<String, String> = HashMap::new();

    for p_val in paths_val {
        if let Some(p_str) = p_val.as_str() {
            let req_arg = json!({
                "path": p_str,
                "max_bytes": max_bytes
            });
            match tool_fs_read_file(&req_arg, policy) {
                Ok(res) => files.push(json!({
                    "path": res.get("path"),
                    "content": res.get("content"),
                    "truncated": res.get("truncated"),
                    "binary": res.get("binary")
                })),
                Err(err) => {
                    errors.insert(p_str.to_string(), err);
                }
            }
        }
    }

    Ok(json!({
        "files": files,
        "errors": errors
    }))
}

pub fn tool_fs_edit_file(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let edits = args
        .get("edits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing required parameter 'edits'".to_string())?;

    let dry_run = args
        .get("dryRun")
        .or_else(|| args.get("dry_run"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let checked_path = policy
        .check_allowed(Path::new(path_str), true)
        .map_err(|e| e.to_string())?;

    let original = fs::read_to_string(&checked_path)
        .map_err(|e| format!("Failed to read file for editing: {}", e))?;

    let mut modified = original.clone();
    let mut applied_count = 0;

    for (i, edit_val) in edits.iter().enumerate() {
        let old_text = edit_val
            .get("oldText")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let new_text = edit_val
            .get("newText")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if let Some(pos) = modified.find(old_text) {
            let mut next = String::with_capacity(modified.len() + new_text.len());
            next.push_str(&modified[..pos]);
            next.push_str(new_text);
            next.push_str(&modified[pos + old_text.len()..]);
            modified = next;
            applied_count += 1;
        } else {
            return Err(format!(
                "edit #{}: oldText not found ({} chars)",
                i,
                old_text.len()
            ));
        }
    }

    let checked_lossy = checked_path.to_string_lossy();
    let clean_str = strip_unc_prefix(&checked_lossy);
    let diff = unified_diff(&original, &modified, clean_str);

    if !dry_run && modified != original {
        fs::write(&checked_path, modified.as_bytes())
            .map_err(|e| format!("Failed to write edited file: {}", e))?;
    }

    Ok(json!({
        "path": clean_str,
        "edits_applied": applied_count,
        "dry_run": dry_run,
        "diff": diff
    }))
}

pub fn tool_fs_directory_tree(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let max_depth = args
        .get("max_depth")
        .and_then(|v| v.as_u64())
        .unwrap_or(8) as usize;

    let max_entries = args
        .get("max_entries")
        .and_then(|v| v.as_u64())
        .unwrap_or(10_000) as usize;

    let checked_path = policy
        .check_allowed(Path::new(path_str), false)
        .map_err(|e| e.to_string())?;

    let mut counter = 0usize;

    fn build_node(
        dpath: &Path,
        name: &str,
        depth: usize,
        max_depth: usize,
        max_entries: usize,
        counter: &mut usize,
        policy: &AccessPolicy,
    ) -> Value {
        *counter += 1;
        let is_dir = dpath.is_dir();
        if !is_dir {
            return json!({ "name": name, "type": "file" });
        }

        let mut children = Vec::new();
        let mut truncated = false;

        if depth >= max_depth || *counter >= max_entries {
            return json!({
                "name": name,
                "type": "directory",
                "children": children,
                "truncated": true
            });
        }

        if let Ok(entries) = fs::read_dir(dpath) {
            let mut sorted_entries = Vec::new();
            for entry_res in entries.flatten() {
                sorted_entries.push(entry_res);
            }
            sorted_entries.sort_by(|a, b| {
                let a_dir = a.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                let b_dir = b.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                match (a_dir, b_dir) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.file_name().cmp(&b.file_name()),
                }
            });

            for child in sorted_entries {
                if *counter >= max_entries {
                    truncated = true;
                    break;
                }
                let cp = child.path();
                let cp_lossy = cp.to_string_lossy();
                let clean_cp = strip_unc_prefix(&cp_lossy);
                if !policy.is_path_allowed(clean_cp, false) {
                    continue;
                }
                let child_node = build_node(
                    &cp,
                    &child.file_name().to_string_lossy(),
                    depth + 1,
                    max_depth,
                    max_entries,
                    counter,
                    policy,
                );
                children.push(child_node);
            }
        } else {
            truncated = true;
        }

        let mut node = json!({
            "name": name,
            "type": "directory",
            "children": children
        });
        if truncated {
            node["truncated"] = json!(true);
        }
        node
    }

    let root_name = checked_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| checked_path.to_string_lossy().to_string());

    let tree = build_node(
        &checked_path,
        &root_name,
        0,
        max_depth,
        max_entries,
        &mut counter,
        policy,
    );

    Ok(json!({
        "tree": tree,
        "entries": counter,
        "max_depth": max_depth,
        "max_entries": max_entries
    }))
}

pub fn tool_fs_search_files(args: &Value, policy: &AccessPolicy) -> Result<Value, String> {
    let path_str = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'path'".to_string())?;

    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'pattern'".to_string())?
        .to_lowercase();

    let exclude_patterns: Vec<String> = args
        .get("excludePatterns")
        .or_else(|| args.get("exclude_patterns"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
                .collect()
        })
        .unwrap_or_default();

    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(1000) as usize;

    let checked_path = policy
        .check_allowed(Path::new(path_str), false)
        .map_err(|e| e.to_string())?;

    let t0 = Instant::now();
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![checked_path.clone()];

    while let Some(dir) = stack.pop() {
        if hits.len() >= max_results {
            break;
        }

        let read_dir = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for entry_res in read_dir.flatten() {
            scanned += 1;
            let ep = entry_res.path();
            let name_str = entry_res.file_name().to_string_lossy().to_string();
            let name_lower = name_str.to_lowercase();

            let excluded = exclude_patterns.iter().any(|ex| name_lower.contains(ex));
            if excluded {
                continue;
            }

            let is_dir = entry_res
                .file_type()
                .map(|ft| ft.is_dir())
                .unwrap_or(false);
            if is_dir {
                stack.push(ep.clone());
            }

            if name_lower.contains(&pattern) {
                let ep_lossy = ep.to_string_lossy();
                let clean_p = strip_unc_prefix(&ep_lossy);
                if policy.is_path_allowed(clean_p, false) {
                    hits.push(clean_p.to_string());
                    if hits.len() >= max_results {
                        break;
                    }
                }
            }
        }
    }

    let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
    let truncated = hits.len() >= max_results;
    let count = hits.len();

    Ok(json!({
        "path": strip_unc_prefix(&checked_path.to_string_lossy()),
        "pattern": pattern,
        "matches": hits,
        "count": count,
        "truncated": truncated,
        "scanned": scanned,
        "elapsed_ms": (elapsed * 10.0).round() / 10.0
    }))
}

pub fn tool_fs_list_allowed_roots(policy: &AccessPolicy) -> Value {
    let roots: Vec<String> = policy
        .allowed_roots
        .iter()
        .map(|p| strip_unc_prefix(&p.to_string_lossy()).to_string())
        .collect();

    let rules_count = policy
        .profiles_rules
        .get(&policy.profile)
        .or_else(|| policy.profiles_rules.get("default"))
        .map(|r| r.len())
        .unwrap_or(0);

    let is_unrestricted = roots.is_empty();

    json!({
        "allowed_roots": roots,
        "unrestricted": is_unrestricted,
        "env_var": "EVERYTHING_MCP_ROOTS",
        "agent": policy.profile,
        "effective_profile": if policy.profiles_rules.contains_key(&policy.profile) { &policy.profile } else { "default" },
        "policy_file": strip_unc_prefix(&policy.access_file.to_string_lossy()),
        "policy_rules": rules_count,
        "restricted": !is_unrestricted
    })
}
