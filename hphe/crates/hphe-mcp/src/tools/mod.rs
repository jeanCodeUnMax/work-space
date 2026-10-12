//! Tool registry and dispatcher for all MCP tools

pub mod content;
pub mod everything;
pub mod fs;
pub mod health;
pub mod hybrid;
pub mod stubs;
pub mod vec;

use hphe_ipc::client::Client;
use serde_json::{json, Value};

use crate::policy::AccessPolicy;
use crate::protocol::ToolDefinition;

pub fn get_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "everything_search".to_string(),
            description: "Ultra-fast file search across local NTFS volumes, powered by the Hephaistos hphe-indexd daemon via IPC (Everything query syntax, ms latency, no admin). Supports full Everything syntax: wildcards *, ?, ext:, size:, dm:, path:, regex:, categories audio: video: document: executable: picture: compressed:. Returns full path, name, dir, size, mtime.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Everything query syntax. Empty = everything.", "default": "" },
                    "max_results": { "type": "integer", "description": "Max rows to return (default 100, cap 10000)", "default": 100 },
                    "offset": { "type": "integer", "default": 0 },
                    "sort": { "type": "string", "enum": ["name", "path", "ext", "date", "size"], "default": "name" },
                    "descending": { "type": "boolean", "default": false },
                    "stat": { "type": "boolean", "default": true },
                    "refresh": { "type": "boolean", "default": true }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true, "openWorldHint": true })),
        },
        ToolDefinition {
            name: "search_files".to_string(),
            description: "Alias for everything_search: ultra-fast file search using the Hephaistos index.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query", "default": "" },
                    "max_results": { "type": "integer", "default": 100 },
                    "offset": { "type": "integer", "default": 0 }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_count".to_string(),
            description: "Count files/dirs matching an Everything query without returning rows.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "default": "" }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_categories".to_string(),
            description: "List the Everything-compatible filter categories and their extension sets.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_index_stats".to_string(),
            description: "Report index service status: total indexed entries, file count, dir count, memory usage.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_stats".to_string(),
            description: "Alias for everything_index_stats: report index status and statistics.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_refresh".to_string(),
            description: "Ask index engine to refresh its db or trigger a full rebuild.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "full": { "type": "boolean", "default": false },
                    "volume": { "type": "string" }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": false, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "everything_open_gui".to_string(),
            description: "Launch Everything GUI to visualize results.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "default": "" }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": false })),
        },
        ToolDefinition {
            name: "fs_read_file".to_string(),
            description: "Read a file's content (utf-8 text by default, truncated at max_bytes).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "max_bytes": { "type": "integer", "default": 1048576 },
                    "encoding": { "type": "string", "default": "utf-8" }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_list_directory".to_string(),
            description: "List a directory's entries (name, dir flag, size, mtime).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "max_entries": { "type": "integer", "default": 1000 }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_get_info".to_string(),
            description: "Stat a path: size, times, attributes, readonly.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "get_file_info".to_string(),
            description: "Alias for fs_get_info: stat a path (size, times, readonly).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_write_file".to_string(),
            description: "Write text content to a file (creates parent dirs; optional append).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "encoding": { "type": "string", "default": "utf-8" },
                    "append": { "type": "boolean", "default": false }
                },
                "required": ["path", "content"]
            }),
            annotations: Some(json!({ "destructiveHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_create_directory".to_string(),
            description: "Create a directory (parents included, idempotent).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "destructiveHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_move".to_string(),
            description: "Move/rename a file or directory.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source": { "type": "string" },
                    "destination": { "type": "string" },
                    "overwrite": { "type": "boolean", "default": false }
                },
                "required": ["source", "destination"]
            }),
            annotations: Some(json!({ "destructiveHint": true, "idempotentHint": false })),
        },
        ToolDefinition {
            name: "fs_delete".to_string(),
            description: "Delete a file, or a directory (empty, or recursive=true).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "recursive": { "type": "boolean", "default": false }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "destructiveHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_read_multiple_files".to_string(),
            description: "Read several files in one call; individual failures don't stop the batch.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "paths": { "type": "array", "items": { "type": "string" } },
                    "max_bytes": { "type": "integer", "default": 1048576 },
                    "encoding": { "type": "string", "default": "utf-8" }
                },
                "required": ["paths"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_edit_file".to_string(),
            description: "Exact-match edits: each edit replaces the first occurrence of oldText with newText; returns a git-style diff. dryRun previews without writing.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "oldText": { "type": "string" },
                                "newText": { "type": "string" }
                            },
                            "required": ["oldText", "newText"]
                        }
                    },
                    "dryRun": { "type": "boolean", "default": false },
                    "encoding": { "type": "string", "default": "utf-8" }
                },
                "required": ["path", "edits"]
            }),
            annotations: Some(json!({ "destructiveHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_directory_tree".to_string(),
            description: "Recursive JSON tree of a directory (name/type/children), bounded by max_depth and max_entries.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "max_depth": { "type": "integer", "default": 8 },
                    "max_entries": { "type": "integer", "default": 10000 }
                },
                "required": ["path"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_search_files".to_string(),
            description: "Recursive traversal search by partial name (case-insensitive). Slow on large trees - prefer everything_search.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "pattern": { "type": "string" },
                    "excludePatterns": { "type": "array", "items": { "type": "string" } },
                    "max_results": { "type": "integer", "default": 1000 }
                },
                "required": ["path", "pattern"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "fs_list_allowed_roots".to_string(),
            description: "List the EVERYTHING_MCP_ROOTS allowlist for fs_* tools (empty = unrestricted).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "resolve_path".to_string(),
            description: "Resolve an internal index row to its full path using the daemon IPC pipe.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "row": { "type": "integer", "description": "Row index in FileIndex" }
                },
                "required": ["row"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "content_search".to_string(),
            description: "Full-text content search powered by Tantivy BM25 (returns hits with path, score, snippet).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Text query to search inside file contents" },
                    "limit": { "type": "integer", "description": "Max hits to return (default 50)", "default": 50 }
                },
                "required": ["query"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "vec_search".to_string(),
            description: "Vector k-NN search powered by embedded usearch HNSW over persistent collection index files.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "vector": { "type": "array", "items": { "type": "number" }, "description": "Query vector as float array" },
                    "query_key": { "type": "integer", "description": "Existing FRN key to use its stored vector as query" },
                    "k": { "type": "integer", "description": "Number of nearest neighbours to return (default 10)", "default": 10 },
                    "collection": { "type": "string", "description": "Collection name (*.usearch file, default first available)" }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "semantic_search".to_string(),
            description: "Semantic vector search (alias/convenience forwarding to vec_search).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Query string or FRN key" },
                    "vector": { "type": "array", "items": { "type": "number" } },
                    "k": { "type": "integer", "default": 10 },
                    "collection": { "type": "string" }
                }
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "vec_stats".to_string(),
            description: "Report vector collections statistics (collection names, dimensions, sizes, usearch backend).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "hybrid_search".to_string(),
            description: "Hybrid multi-modal search combining filename search, Tantivy BM25 content search, and usearch vector search with deduplication and normalized ranking.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query for names and contents" },
                    "k": { "type": "integer", "description": "Max results to return (default 10)", "default": 10 },
                    "vector": { "type": "array", "items": { "type": "number" }, "description": "Optional vector for semantic search" },
                    "collection": { "type": "string", "description": "Optional vector collection name" }
                },
                "required": ["query"]
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
        ToolDefinition {
            name: "hphe_health".to_string(),
            description: "Health ping checking hphe-mcp server and daemon pipe connectivity.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
            annotations: Some(json!({ "readOnlyHint": true, "idempotentHint": true })),
        },
    ]
}

pub async fn execute_tool(
    name: &str,
    args: &Value,
    client: &Client,
    policy: &AccessPolicy,
) -> Result<Value, String> {
    match name {
        "everything_search" | "search_files" => {
            everything::tool_everything_search(args, client, policy).await
        }
        "everything_count" => everything::tool_everything_count(args, client).await,
        "everything_categories" => everything::tool_everything_categories(args),
        "everything_index_stats" | "everything_stats" => {
            everything::tool_everything_index_stats(args, client).await
        }
        "everything_refresh" => everything::tool_everything_refresh(args),
        "everything_open_gui" => everything::tool_everything_open_gui(args),
        "resolve_path" => everything::tool_resolve_path(args, client).await,

        "fs_read_file" => fs::tool_fs_read_file(args, policy),
        "fs_list_directory" => fs::tool_fs_list_directory(args, policy),
        "fs_get_info" | "get_file_info" => fs::tool_fs_get_info(args, policy),
        "fs_write_file" => fs::tool_fs_write_file(args, policy),
        "fs_create_directory" => fs::tool_fs_create_directory(args, policy),
        "fs_move" => fs::tool_fs_move(args, policy),
        "fs_copy" => fs::tool_fs_copy(args, policy),
        "fs_delete" => fs::tool_fs_delete(args, policy),
        "fs_read_multiple_files" => fs::tool_fs_read_multiple_files(args, policy),
        "fs_edit_file" => fs::tool_fs_edit_file(args, policy),
        "fs_directory_tree" => fs::tool_fs_directory_tree(args, policy),
        "fs_search_files" => fs::tool_fs_search_files(args, policy),
        "fs_list_allowed_roots" => Ok(fs::tool_fs_list_allowed_roots(policy)),

        "content_search" => content::tool_content_search(args),
        "vec_search" | "semantic_search" => vec::tool_vec_search(args),
        "vec_stats" => vec::tool_vec_stats(args),
        "hybrid_search" => hybrid::tool_hybrid_search(args, client, policy).await,
        "hphe_health" | "health" | "ping" => health::tool_health(client).await,

        other if other.starts_with("memory_") => stubs::tool_memory_stub(other, args),

        _ => Err(format!("unknown tool {}", name)),
    }
}
