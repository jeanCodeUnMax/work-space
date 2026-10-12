//! Roundtrip tests: Mock pipe server + MCP JSON-RPC 2.0 stdio tools/call

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use hphe_ipc::client::ClientBuilder;
use hphe_ipc::protocol::{
    FileEntry, IndexStats, PingResponse, RequestId, ResolveResponse, ResultResponse,
    SearchParams, SearchResponse, WatchParams, WatchResponse,
};
use hphe_ipc::server::{NamedPipeServerBuilder, RequestHandler};
use hphe_ipc::IpcResult;
use serde_json::json;

use hphe_mcp::{AccessPolicy, JsonRpcRequest, McpServer};

static PIPE_COUNTER: AtomicUsize = AtomicUsize::new(100);

fn unique_pipe_name() -> String {
    let id = PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!(r"\\.\pipe\hphe-mcp-mock-{}-{}", std::process::id(), id)
}

#[derive(Debug, Clone)]
struct MockDaemonHandler;

#[async_trait::async_trait]
impl RequestHandler for MockDaemonHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Ping(PingResponse {
            version: "0.1.0-mock".to_string(),
            uptime_ms: 1234,
            timestamp: 1700000000,
        }))
    }

    async fn handle_stats(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Stats(IndexStats {
            total_entries: 42,
            file_count: 30,
            dir_count: 12,
            total_size: 1048576,
            memory_usage_bytes: 8192,
            build_time_ms: 15,
            avg_name_length: 12.5,
            volumes: None,
        }))
    }

    async fn handle_search(
        &self,
        _request_id: RequestId,
        params: SearchParams,
    ) -> IpcResult<ResultResponse> {
        let entry = FileEntry {
            row: 7,
            frn: 1001,
            parent_frn: 1,
            name: "test_doc.md".to_string(),
            path: r"C:\data\test_doc.md".to_string(),
            size: 2048,
            is_dir: false,
            created: 100,
            modified: 200,
            accessed: 300,
            attributes: 32,
        };

        Ok(ResultResponse::Search(SearchResponse {
            total: 1,
            entries: vec![entry],
            has_more: false,
            offset: params.offset,
            limit: params.limit,
        }))
    }

    async fn handle_resolve(&self, _request_id: RequestId, row: usize) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Resolve(ResolveResponse {
            path: format!(r"C:\resolved\row_{}.txt", row),
            row,
            frn: 9999,
        }))
    }

    async fn handle_watch(
        &self,
        _request_id: RequestId,
        params: WatchParams,
    ) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Watch(WatchResponse {
            subscribed: params.subscribe,
            volume: params.volume,
        }))
    }
}

async fn start_mock_pipe_server() -> (tokio::task::JoinHandle<()>, String) {
    let pipe_name = unique_pipe_name();

    let mut server = NamedPipeServerBuilder::new()
        .pipe_name(pipe_name.clone())
        .max_connections(16)
        .read_timeout_ms(5000)
        .write_timeout_ms(5000)
        .apply_restrictive_acl(false)
        .build(MockDaemonHandler);

    server.start().await.expect("Failed to start mock pipe server");

    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    tokio::time::sleep(Duration::from_millis(150)).await;

    (handle, pipe_name)
}

#[tokio::test]
async fn test_mcp_initialize_and_tools_list() {
    let (_handle, pipe_name) = start_mock_pipe_server().await;

    let client = ClientBuilder::new()
        .pipe_name(&pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();

    let server = McpServer::new(client, AccessPolicy::default());

    // 1. Initialize
    let init_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(1)),
        method: "initialize".to_string(),
        params: Some(json!({ "protocolVersion": "2024-11-05" })),
    };
    let init_resp = server.handle_message(init_req).await.expect("init response");
    assert_eq!(init_resp.id, Some(json!(1)));
    let init_res = init_resp.result.expect("init result");
    assert_eq!(init_res["serverInfo"]["name"], "hphe-mcp");

    // 2. Ping
    let ping_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(2)),
        method: "ping".to_string(),
        params: None,
    };
    let ping_resp = server.handle_message(ping_req).await.expect("ping response");
    assert!(ping_resp.result.is_some());

    // 3. Tools list
    let list_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(3)),
        method: "tools/list".to_string(),
        params: None,
    };
    let list_resp = server.handle_message(list_req).await.expect("tools list response");
    let tools = list_resp.result.expect("tools array")["tools"]
        .as_array()
        .expect("array")
        .clone();
    assert!(tools.len() >= 18, "Expected at least 18 tools, got {}", tools.len());

    let tool_names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();

    assert!(tool_names.contains(&"everything_search"));
    assert!(tool_names.contains(&"everything_count"));
    assert!(tool_names.contains(&"everything_categories"));
    assert!(tool_names.contains(&"everything_index_stats"));
    assert!(tool_names.contains(&"everything_refresh"));
    assert!(tool_names.contains(&"everything_open_gui"));
    assert!(tool_names.contains(&"fs_read_file"));
    assert!(tool_names.contains(&"fs_list_directory"));
    assert!(tool_names.contains(&"fs_get_info"));
    assert!(tool_names.contains(&"fs_write_file"));
    assert!(tool_names.contains(&"fs_create_directory"));
    assert!(tool_names.contains(&"fs_move"));
    assert!(tool_names.contains(&"fs_delete"));
    assert!(tool_names.contains(&"fs_read_multiple_files"));
    assert!(tool_names.contains(&"fs_edit_file"));
    assert!(tool_names.contains(&"fs_directory_tree"));
    assert!(tool_names.contains(&"fs_search_files"));
    assert!(tool_names.contains(&"fs_list_allowed_roots"));
    assert!(tool_names.contains(&"resolve_path"));
    assert!(tool_names.contains(&"content_search"));
    assert!(tool_names.contains(&"semantic_search"));
    assert!(tool_names.contains(&"hphe_health"));
}

#[tokio::test]
async fn test_mock_pipe_tools_call_roundtrip() {
    let (_handle, pipe_name) = start_mock_pipe_server().await;

    let client = ClientBuilder::new()
        .pipe_name(&pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();

    let server = McpServer::new(client, AccessPolicy::default());

    // 1. Call everything_search (routed to pipe client)
    let search_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(10)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "everything_search",
            "arguments": { "query": "test_doc" }
        })),
    };
    let search_resp = server.handle_message(search_req).await.expect("search response");
    assert!(search_resp.error.is_none());
    let res = search_resp.result.unwrap();
    let struct_content = &res["structuredContent"];
    assert_eq!(struct_content["backend"], "hphe-pipe");
    assert_eq!(struct_content["total"], 1);
    let results = struct_content["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["name"], "test_doc.md");

    // 2. Call everything_index_stats (routed to pipe client)
    let stats_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(11)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "everything_index_stats",
            "arguments": {}
        })),
    };
    let stats_resp = server.handle_message(stats_req).await.expect("stats response");
    let stats_struct = &stats_resp.result.unwrap()["structuredContent"];
    assert_eq!(stats_struct["total_entries"], 42);
    assert_eq!(stats_struct["file_count"], 30);
    assert_eq!(stats_struct["backend"], "hphe-pipe");

    // 3. Call resolve_path (routed to pipe client)
    let resolve_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(12)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "resolve_path",
            "arguments": { "row": 7 }
        })),
    };
    let resolve_resp = server.handle_message(resolve_req).await.expect("resolve response");
    let resolve_struct = &resolve_resp.result.unwrap()["structuredContent"];
    assert_eq!(resolve_struct["row"], 7);
    assert_eq!(resolve_struct["frn"], 9999);
    assert!(resolve_struct["path"].as_str().unwrap().contains("row_7.txt"));

    // 4. Call hphe_health (health ping)
    let health_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(13)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "hphe_health",
            "arguments": {}
        })),
    };
    let health_resp = server.handle_message(health_req).await.expect("health response");
    let health_struct = &health_resp.result.unwrap()["structuredContent"];
    assert_eq!(health_struct["status"], "healthy");
    assert_eq!(health_struct["pipe_connected"], true);

    // 5. Call everything_categories
    let cat_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(14)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "everything_categories",
            "arguments": {}
        })),
    };
    let cat_resp = server.handle_message(cat_req).await.expect("categories response");
    let cat_struct = &cat_resp.result.unwrap()["structuredContent"];
    assert!(cat_struct["categories"]["document"].as_array().unwrap().contains(&json!("pdf")));

    // 6. Call content_search (real tool, index absent fallback)
    let content_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(15)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "content_search",
            "arguments": { "query": "hephaistos" }
        })),
    };
    let content_resp = server.handle_message(content_req).await.expect("content response");
    let content_struct = &content_resp.result.unwrap()["structuredContent"];
    assert_eq!(content_struct["status"], "index_absent");

    // 7. Call semantic_search (real tool, index absent fallback)
    let semantic_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(16)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "semantic_search",
            "arguments": { "query": "vector lookup" }
        })),
    };
    let semantic_resp = server.handle_message(semantic_req).await.expect("semantic response");
    let semantic_struct = &semantic_resp.result.unwrap()["structuredContent"];
    assert_eq!(semantic_struct["status"], "index_absent");
}

#[tokio::test]
async fn test_fs_tools_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path();

    let client = ClientBuilder::new()
        .pipe_name(r"\\.\pipe\non-existent-pipe")
        .build();

    let server = McpServer::new(client, AccessPolicy::default());

    let test_file = tmp_path.join("test.txt");
    let test_file_str = test_file.to_string_lossy().to_string();

    // 1. fs_write_file
    let write_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(20)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_write_file",
            "arguments": {
                "path": test_file_str,
                "content": "Line 1\nLine 2\nLine 3\n"
            }
        })),
    };
    let write_resp = server.handle_message(write_req).await.expect("write response");
    let write_struct = &write_resp.result.unwrap()["structuredContent"];
    assert!(write_struct["bytes_written"].as_u64().unwrap() > 0);

    // 2. fs_read_file
    let read_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(21)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_read_file",
            "arguments": { "path": test_file_str }
        })),
    };
    let read_resp = server.handle_message(read_req).await.expect("read response");
    let read_struct = &read_resp.result.unwrap()["structuredContent"];
    assert_eq!(read_struct["content"], "Line 1\nLine 2\nLine 3\n");
    assert_eq!(read_struct["binary"], false);

    // 3. fs_get_info
    let info_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(22)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_get_info",
            "arguments": { "path": test_file_str }
        })),
    };
    let info_resp = server.handle_message(info_req).await.expect("info response");
    let info_struct = &info_resp.result.unwrap()["structuredContent"];
    assert_eq!(info_struct["exists"], true);
    assert_eq!(info_struct["dir"], false);

    // 4. fs_edit_file
    let edit_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(23)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_edit_file",
            "arguments": {
                "path": test_file_str,
                "edits": [
                    { "oldText": "Line 2\n", "newText": "Line 2 Modified\n" }
                ]
            }
        })),
    };
    let edit_resp = server.handle_message(edit_req).await.expect("edit response");
    let edit_struct = &edit_resp.result.unwrap()["structuredContent"];
    assert_eq!(edit_struct["edits_applied"], 1);
    assert!(edit_struct["diff"].as_str().unwrap().contains("-Line 2"));
    assert!(edit_struct["diff"].as_str().unwrap().contains("+Line 2 Modified"));

    // 5. fs_list_directory
    let list_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(24)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_list_directory",
            "arguments": { "path": tmp_path.to_string_lossy().to_string() }
        })),
    };
    let list_resp = server.handle_message(list_req).await.expect("list response");
    let list_struct = &list_resp.result.unwrap()["structuredContent"];
    let entries = list_struct["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "test.txt");

    // 6. fs_delete
    let delete_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(25)),
        method: "tools/call".to_string(),
        params: Some(json!({
            "name": "fs_delete",
            "arguments": { "path": test_file_str }
        })),
    };
    let del_resp = server.handle_message(delete_req).await.expect("delete response");
    let del_struct = &del_resp.result.unwrap()["structuredContent"];
    assert_eq!(del_struct["deleted"], true);
}

#[tokio::test]
async fn test_latency_benchmark() {
    let (_handle, pipe_name) = start_mock_pipe_server().await;

    let client = ClientBuilder::new()
        .pipe_name(&pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();

    let server = McpServer::new(client, AccessPolicy::default());

    // Warmup
    let ping_req = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: Some(json!(1)),
        method: "ping".to_string(),
        params: None,
    };
    let _ = server.handle_message(ping_req).await;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_file = tmp.path().join("bench.txt");
    std::fs::write(&tmp_file, "Benchmark file content for latency tests\n").unwrap();
    let tmp_file_str = tmp_file.to_string_lossy().to_string();

    let iterations = 100;

    let tools_to_test = vec![
        ("everything_search", json!({ "query": "bench" })),
        ("everything_index_stats", json!({})),
        ("resolve_path", json!({ "row": 1 })),
        ("hphe_health", json!({})),
        ("everything_categories", json!({})),
        ("content_search", json!({ "query": "hello" })),
        ("semantic_search", json!({ "query": "hello" })),
        ("fs_get_info", json!({ "path": tmp_file_str })),
        ("fs_read_file", json!({ "path": tmp_file_str })),
    ];

    for (name, args) in tools_to_test {
        let mut latencies_us = Vec::with_capacity(iterations);

        for i in 0..iterations {
            let req = JsonRpcRequest {
                jsonrpc: "2.0".to_string(),
                id: Some(json!(100 + i)),
                method: "tools/call".to_string(),
                params: Some(json!({
                    "name": name,
                    "arguments": args
                })),
            };

            let start = std::time::Instant::now();
            let resp = server.handle_message(req).await;
            let elapsed = start.elapsed().as_micros() as u64;
            assert!(resp.is_some());
            latencies_us.push(elapsed);
        }

        latencies_us.sort_unstable();
        let p50 = latencies_us[iterations * 50 / 100];
        let p95 = latencies_us[iterations * 95 / 100];
        let p99 = latencies_us[iterations * 99 / 100];
        let avg: u64 = latencies_us.iter().sum::<u64>() / iterations as u64;

        println!(
            "BENCH: tool={} | avg={:.2}us ({:.3}ms) | p50={}us ({:.3}ms) | p95={}us ({:.3}ms) | p99={}us ({:.3}ms)",
            name,
            avg as f64,
            avg as f64 / 1000.0,
            p50,
            p50 as f64 / 1000.0,
            p95,
            p95 as f64 / 1000.0,
            p99,
            p99 as f64 / 1000.0
        );
    }
}
