//! Real Hybrid Search tool
//!
//! Combines:
//! 1. `everything_search` (fast filename search via IPC daemon)
//! 2. `content_search` (Tantivy BM25 full-text search)
//! 3. `vec_search` (usearch k-NN vector search if vector or key provided)
//!
//! Merges results with deduplication by path, combined score normalization,
//! and source attribution.

use std::collections::HashMap;
use serde_json::{json, Value};
use hphe_ipc::client::Client;

use crate::policy::AccessPolicy;
use crate::tools::{content, everything, vec};

#[derive(Debug, Clone)]
struct Candidate {
    path: String,
    name_score: Option<f32>,
    content_score: Option<f32>,
    vec_score: Option<f32>,
    snippet: Option<String>,
    sources: Vec<String>,
}

/// MCP tool: `hybrid_search { query, k?, vector?, collection? }`
/// Combines filename matching, BM25 text relevance, and vector similarity.
pub async fn tool_hybrid_search(
    args: &Value,
    client: &Client,
    policy: &AccessPolicy,
) -> Result<Value, String> {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) => q,
        None => return Err("Missing required parameter 'query'".to_string()),
    };

    let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
    let fetch_limit = (k * 2).max(20);

    let mut candidates_map: HashMap<String, Candidate> = HashMap::new();
    let mut frn_to_path: HashMap<u64, String> = HashMap::new();

    // 1. Everything filename search
    let everything_args = json!({
        "query": query,
        "max_results": fetch_limit
    });
    if let Ok(everything_res) = everything::tool_everything_search(&everything_args, client, policy).await {
        if let Some(items) = everything_res.get("results").and_then(|v| v.as_array()) {
            let n = items.len().max(1) as f32;
            for (idx, item) in items.iter().enumerate() {
                if let Some(path) = item.get("path").and_then(|v| v.as_str()) {
                    let path_key = path.to_lowercase();
                    let name_score = 1.0 - (idx as f32 / n) * 0.5; // Ranges 1.0 down to 0.5

                    if let Some(frn) = item.get("frn").and_then(|v| v.as_u64()) {
                        frn_to_path.insert(frn, path.to_string());
                    }

                    candidates_map
                        .entry(path_key)
                        .and_modify(|c| {
                            c.name_score = Some(name_score);
                            if !c.sources.contains(&"name".to_string()) {
                                c.sources.push("name".to_string());
                            }
                        })
                        .or_insert_with(|| Candidate {
                            path: path.to_string(),
                            name_score: Some(name_score),
                            content_score: None,
                            vec_score: None,
                            snippet: None,
                            sources: vec!["name".to_string()],
                        });
                }
            }
        }
    }

    // 2. Tantivy BM25 content search
    let content_args = json!({
        "query": query,
        "limit": fetch_limit
    });
    if let Ok(content_res) = content::tool_content_search(&content_args) {
        if content_res.get("status").and_then(|v| v.as_str()) == Some("ok") {
            if let Some(matches) = content_res.get("matches").and_then(|v| v.as_array()) {
                let max_score = matches
                    .iter()
                    .filter_map(|m| m.get("score").and_then(|v| v.as_f64()).map(|f| f as f32))
                    .fold(0.001f32, f32::max);

                for item in matches {
                    if let Some(path) = item.get("path").and_then(|v| v.as_str()) {
                        let path_key = path.to_lowercase();
                        let raw_score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                        let norm_content_score = (raw_score / max_score).clamp(0.0, 1.0);
                        let snippet = item.get("snippet").and_then(|v| v.as_str()).map(|s| s.to_string());

                        if let Some(frn) = item.get("frn").and_then(|v| v.as_u64()) {
                            frn_to_path.insert(frn, path.to_string());
                        }

                        candidates_map
                            .entry(path_key)
                            .and_modify(|c| {
                                c.content_score = Some(norm_content_score);
                                if c.snippet.is_none() && snippet.is_some() {
                                    c.snippet = snippet.clone();
                                }
                                if !c.sources.contains(&"content".to_string()) {
                                    c.sources.push("content".to_string());
                                }
                            })
                            .or_insert_with(|| Candidate {
                                path: path.to_string(),
                                name_score: None,
                                content_score: Some(norm_content_score),
                                vec_score: None,
                                snippet,
                                sources: vec!["content".to_string()],
                            });
                    }
                }
            }
        }
    }

    // 3. Vector search (if vector or key provided in args)
    if args.get("vector").is_some() || args.get("query_key").is_some() {
        if let Ok(vec_res) = vec::tool_vec_search(args) {
            if vec_res.get("status").and_then(|v| v.as_str()) == Some("ok") {
                if let Some(results) = vec_res.get("results").and_then(|v| v.as_array()) {
                    for hit in results {
                        let key = hit.get("key").and_then(|v| v.as_u64()).unwrap_or(0);
                        let vec_score = hit.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;

                        if let Some(path) = frn_to_path.get(&key) {
                            let path_key = path.to_lowercase();
                            candidates_map
                                .entry(path_key)
                                .and_modify(|c| {
                                    c.vec_score = Some(vec_score);
                                    if !c.sources.contains(&"vector".to_string()) {
                                        c.sources.push("vector".to_string());
                                    }
                                })
                                .or_insert_with(|| Candidate {
                                    path: path.clone(),
                                    name_score: None,
                                    content_score: None,
                                    vec_score: Some(vec_score),
                                    snippet: None,
                                    sources: vec!["vector".to_string()],
                                });
                        }
                    }
                }
            }
        }
    }

    // Merge, calculate combined normalized score, and rank
    let mut ranked: Vec<Value> = candidates_map
        .into_values()
        .map(|c| {
            let mut final_score = 0.0f32;
            let mut count = 0.0f32;

            if let Some(ns) = c.name_score {
                final_score += ns * 0.45;
                count += 0.45;
            }
            if let Some(cs) = c.content_score {
                final_score += cs * 0.45;
                count += 0.45;
            }
            if let Some(vs) = c.vec_score {
                final_score += vs * 0.35;
                count += 0.35;
            }

            // Multi-source boost: if matched across multiple modalities
            let mut score = if count > 0.0 { final_score / count } else { 0.0 };
            if c.sources.len() > 1 {
                score = (score * 1.15).min(1.0);
            }

            // Format to 4 decimal places
            let normalized_score = (score * 10000.0).round() / 10000.0;

            json!({
                "path": c.path,
                "score": normalized_score,
                "snippet": c.snippet,
                "sources": c.sources
            })
        })
        .collect();

    ranked.sort_by(|a, b| {
        let sa = a.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let sb = b.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });

    if ranked.len() > k {
        ranked.truncate(k);
    }

    Ok(json!({
        "status": "ok",
        "query": query,
        "k": k,
        "total": ranked.len(),
        "results": ranked
    }))
}
