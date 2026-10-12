//! Everything tools implementation communicating with hphe-indexd daemon via hphe-ipc

use std::path::Path;
use std::time::Instant;

use hphe_ipc::client::Client;
use serde_json::{json, Value};

use crate::categories::get_categories_json;
use crate::policy::{strip_unc_prefix, AccessPolicy};

pub async fn tool_everything_search(
    args: &Value,
    client: &Client,
    policy: &AccessPolicy,
) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(100)
        .min(10_000) as usize;

    let offset = args
        .get("offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let t0 = Instant::now();

    match client.search(&query, max_results, offset).await {
        Ok(resp) => {
            let mut results = Vec::new();
            let mut filtered = 0usize;

            for entry in resp.entries {
                let clean_p = strip_unc_prefix(&entry.path);
                if !policy.is_path_allowed(clean_p, false) {
                    filtered += 1;
                    continue;
                }

                let dir_str = Path::new(clean_p)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(json!({
                    "path": clean_p,
                    "name": entry.name,
                    "dir": dir_str,
                    "size": entry.size,
                    "mtime": entry.modified,
                    "attrs": entry.attributes
                }));
            }

            let elapsed = t0.elapsed().as_secs_f64() * 1000.0;

            Ok(json!({
                "total": resp.total,
                "offset": offset,
                "results": results,
                "filtered_by_policy": if filtered > 0 { Some(filtered) } else { None },
                "query": query,
                "elapsed_ms": (elapsed * 10.0).round() / 10.0,
                "backend": "hphe-pipe"
            }))
        }
        Err(e) => {
            let elapsed = t0.elapsed().as_secs_f64() * 1000.0;
            Ok(json!({
                "total": 0,
                "offset": offset,
                "results": [],
                "filtered_by_policy": null,
                "query": query,
                "elapsed_ms": (elapsed * 10.0).round() / 10.0,
                "backend": "hphe-pipe",
                "error": format!("Daemon IPC error: {}", e)
            }))
        }
    }
}

pub async fn tool_everything_count(args: &Value, client: &Client) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match client.search(&query, 1, 0).await {
        Ok(resp) => Ok(json!({
            "count": resp.total,
            "query": query,
            "backend": "hphe-pipe"
        })),
        Err(e) => Ok(json!({
            "count": 0,
            "query": query,
            "backend": "hphe-pipe",
            "error": format!("Daemon IPC error: {}", e)
        })),
    }
}

pub fn tool_everything_categories(_args: &Value) -> Result<Value, String> {
    Ok(get_categories_json())
}

pub async fn tool_everything_index_stats(_args: &Value, client: &Client) -> Result<Value, String> {
    match client.stats().await {
        Ok(stats) => Ok(json!({
            "total_entries": stats.total_entries,
            "file_count": stats.file_count,
            "dir_count": stats.dir_count,
            "total_size": stats.total_size,
            "memory_usage_bytes": stats.memory_usage_bytes,
            "build_time_ms": stats.build_time_ms,
            "avg_name_length": stats.avg_name_length,
            "backend": "hphe-pipe",
            "note": "index maintained live by hphe-indexd daemon via Windows named pipe (\\\\.\\pipe\\hphe-index)"
        })),
        Err(e) => Ok(json!({
            "backend": "hphe-pipe",
            "error": format!("Failed to retrieve stats from hphe-index daemon: {}", e)
        })),
    }
}

pub fn tool_everything_refresh(args: &Value) -> Result<Value, String> {
    let full = args
        .get("full")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(json!({
        "mode": if full { "full" } else { "none" },
        "rebuild_requested": full,
        "note": "index is maintained live by hphe-indexd via USN deltas continuously"
    }))
}

pub fn tool_everything_open_gui(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    Ok(json!({
        "launched": false,
        "query": query,
        "note": "hphe-mcp operates in standalone unified mode"
    }))
}

pub async fn tool_resolve_path(args: &Value, client: &Client) -> Result<Value, String> {
    let row = args
        .get("row")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "Missing required parameter 'row'".to_string())? as usize;

    match client.resolve(row).await {
        Ok(resp) => Ok(json!({
            "row": resp.row,
            "path": strip_unc_prefix(&resp.path),
            "frn": resp.frn
        })),
        Err(e) => Err(format!("Failed to resolve row {}: {}", row, e)),
    }
}
