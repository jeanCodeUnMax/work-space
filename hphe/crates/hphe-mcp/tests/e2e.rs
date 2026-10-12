//! End-to-End integration tests driving the compiled hphe-mcp binary over stdio JSON-RPC 2.0.
//!
//! Mission T-091:
//! 1. initialize -> verify capabilities + serverInfo + protocolVersion
//! 2. tools/list -> verify the 18 reference tools exposed with valid JSON schemas (reference: server.py)
//! 3. tools/call on each category: everything_search (pipe absent fallback/error, no crash),
//!    fs_* (read, write, list, mkdir, delete, copy, move on temp files), health, categories, policy
//! 4. Errors: unknown tool, invalid params, unknown JSON-RPC method, notifications -> clean JSON-RPC responses
//! 5. Zero dependency on Everything.exe or running hphe-indexd daemon
//! 6. Latency benchmark over stdio subprocess JSON-RPC

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use hphe_ipc::protocol::{
    FileEntry, IndexStats, PingResponse, RequestId, ResolveResponse, ResultResponse,
    SearchParams, SearchResponse, WatchParams, WatchResponse,
};
use hphe_ipc::server::{NamedPipeServerBuilder, RequestHandler};
use hphe_ipc::IpcResult;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

static PIPE_COUNTER: AtomicUsize = AtomicUsize::new(500);

fn unique_mock_pipe_name() -> String {
    let id = PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!(r"\\.\pipe\hphe-mcp-e2e-{}-{}", std::process::id(), id)
}

#[derive(Debug, Clone)]
struct MockDaemonHandler;

#[async_trait::async_trait]
impl RequestHandler for MockDaemonHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Ping(PingResponse {
            version: "0.1.0-e2e-mock".to_string(),
            uptime_ms: 5432,
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
    let pipe_name = unique_mock_pipe_name();

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

/// Helper struct managing a running hphe-mcp child process communicating over stdio
struct McpSubprocessClient {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}

impl McpSubprocessClient {
    async fn spawn(
        pipe_name: Option<&str>,
        profile: Option<&str>,
        roots: Option<&str>,
    ) -> Self {
        let bin_path = env!("CARGO_BIN_EXE_hphe-mcp");

        let mut cmd = Command::new(bin_path);
        cmd.arg("--connect-timeout-ms").arg("500")
            .arg("--request-timeout-ms").arg("3000")
            .arg("--log-level").arg("error");

        if let Some(pipe) = pipe_name {
            cmd.arg("--pipe-name").arg(pipe);
        } else {
            cmd.arg("--pipe-name").arg(r"\\.\pipe\hphe-absent-test-pipe");
        }

        if let Some(prof) = profile {
            cmd.arg("--profile").arg(prof);
        }

        if let Some(r) = roots {
            cmd.env("EVERYTHING_MCP_ROOTS", r);
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().expect("Failed to spawn hphe-mcp binary");
        let stdin = child.stdin.take().expect("Failed to capture child stdin");
        let stdout = child.stdout.take().expect("Failed to capture child stdout");
        let lines = BufReader::new(stdout).lines();

        Self { child, stdin, lines }
    }

    async fn send_request(&mut self, req: &Value) -> Value {
        let mut text = serde_json::to_string(req).expect("Failed to serialize request");
        text.push('\n');

        self.stdin
            .write_all(text.as_bytes())
            .await
            .expect("Failed to write to stdin");
        self.stdin.flush().await.expect("Failed to flush stdin");

        let line = tokio::time::timeout(Duration::from_secs(5), self.lines.next_line())
            .await
            .expect("Timed out waiting for JSON-RPC response")
            .expect("I/O error reading child stdout")
            .expect("Unexpected EOF from child stdout");

        serde_json::from_str(&line).unwrap_or_else(|e| {
            panic!("Child stdout did not return valid JSON: {} | Raw: {}", e, line)
        })
    }

    async fn send_raw(&mut self, raw: &str) -> Option<Value> {
        let mut text = raw.to_string();
        if !text.ends_with('\n') {
            text.push('\n');
        }

        self.stdin
            .write_all(text.as_bytes())
            .await
            .expect("Failed to write to stdin");
        self.stdin.flush().await.expect("Failed to flush stdin");

        match tokio::time::timeout(Duration::from_millis(500), self.lines.next_line()).await {
            Ok(Ok(Some(line))) => Some(serde_json::from_str(&line).expect("Invalid JSON received")),
            _ => None,
        }
    }

    async fn close(mut self) {
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

// ---------------------------------------------------------------------------
// 1. initialize -> verifier capabilities + serverInfo + protocolVersion
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_1_initialize() {
    let mut client = McpSubprocessClient::spawn(None, None, None).await;

    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "e2e-test-suite",
                "version": "1.0.0"
            }
        }
    });

    let resp = client.send_request(&init_req).await;
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 1);
    assert!(resp["error"].is_null());

    let result = &resp["result"];
    assert_eq!(result["protocolVersion"], "2024-11-05");
    assert_eq!(result["serverInfo"]["name"], "hphe-mcp");
    assert_eq!(result["serverInfo"]["version"], "0.1.0");
    assert_eq!(result["capabilities"]["tools"]["listChanged"], false);
    assert!(result["instructions"].as_str().unwrap().contains("Hephaistos"));

    // Ping check
    let ping_req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "ping"
    });
    let ping_resp = client.send_request(&ping_req).await;
    assert_eq!(ping_resp["id"], 2);
    assert_eq!(ping_resp["result"], json!({}));

    // Notification: initialized notification (no id) -> server must not respond
    let notif = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let notif_resp = client.send_raw(&notif.to_string()).await;
    assert!(notif_resp.is_none(), "Notification must not trigger a response");

    client.close().await;
}

// ---------------------------------------------------------------------------
// 2. tools/list -> verifier les 18 outils de reference exposes avec schemas JSON valides
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_2_tools_list_reference_18_tools() {
    let mut client = McpSubprocessClient::spawn(None, None, None).await;

    // Send initialize first
    let _ = client.send_request(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize"
    })).await;

    let list_req = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list"
    });
    let resp = client.send_request(&list_req).await;
    assert_eq!(resp["id"], 2);

    let tools = resp["result"]["tools"].as_array().expect("tools array");

    // The 18 reference tools from server.py at root of repo:
    let reference_18 = [
        "everything_search",
        "everything_count",
        "everything_categories",
        "everything_index_stats",
        "everything_refresh",
        "everything_open_gui",
        "fs_read_file",
        "fs_list_directory",
        "fs_get_info",
        "fs_write_file",
        "fs_create_directory",
        "fs_move",
        "fs_delete",
        "fs_read_multiple_files",
        "fs_edit_file",
        "fs_directory_tree",
        "fs_search_files",
        "fs_list_allowed_roots",
    ];

    let mut found_names = std::collections::HashSet::new();

    for tool in tools {
        let name = tool["name"].as_str().expect("tool name string");
        let desc = tool["description"].as_str().expect("tool description string");
        let schema = &tool["inputSchema"];

        assert!(!name.is_empty(), "Tool name must not be empty");
        assert!(!desc.is_empty(), "Tool description must not be empty");

        // Validate JSON Schema structure
        assert_eq!(
            schema["type"], "object",
            "Tool '{}' inputSchema must have type 'object'",
            name
        );
        assert!(
            schema["properties"].is_object(),
            "Tool '{}' inputSchema must have 'properties' object",
            name
        );

        found_names.insert(name.to_string());
    }

    // Verify all 18 reference tools are exposed
    for ref_name in &reference_18 {
        assert!(
            found_names.contains(*ref_name),
            "Reference tool '{}' from server.py is missing in hphe-mcp tools/list",
            ref_name
        );
    }

    println!("E2E VERIFIED: All {} reference tools from server.py found with valid schemas (Total tools exposed: {})", reference_18.len(), tools.len());

    client.close().await;
}

// ---------------------------------------------------------------------------
// 3. tools/call sur chaque categorie:
//    - everything_search (pipe hphe-indexd absent -> doit fallback ou erreur propre, PAS de crash)
//    - fs_* (read/write/list/mkdir/delete/copy/move sur fichiers temporaires)
//    - health
//    - categories
//    - policy
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_3_everything_search_fallback_when_pipe_absent() {
    // Pipe is deliberately set to non-existent pipe, daemon absent
    let mut client = McpSubprocessClient::spawn(Some(r"\\.\pipe\hphe-daemon-absent-pipe"), None, None).await;

    // 1. everything_search without daemon: MUST return clean JSON with error indication, NEVER crash
    let search_req = json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "tools/call",
        "params": {
            "name": "everything_search",
            "arguments": {
                "query": "*.rs",
                "max_results": 10
            }
        }
    });

    let resp = client.send_request(&search_req).await;
    assert_eq!(resp["id"], 10);
    assert!(resp["error"].is_null(), "RPC envelope must not error on tool execution");

    let result = &resp["result"];
    let structured = &result["structuredContent"];
    assert_eq!(structured["backend"], "hphe-pipe");
    assert_eq!(structured["total"], 0);
    assert!(structured["results"].as_array().unwrap().is_empty());
    assert!(structured["error"].as_str().expect("error message").contains("Daemon IPC error"));

    // 2. everything_count without daemon
    let count_req = json!({
        "jsonrpc": "2.0",
        "id": 11,
        "method": "tools/call",
        "params": {
            "name": "everything_count",
            "arguments": { "query": "test" }
        }
    });
    let count_resp = client.send_request(&count_req).await;
    let count_struct = &count_resp["result"]["structuredContent"];
    assert_eq!(count_struct["count"], 0);
    assert!(count_struct["error"].as_str().unwrap().contains("Daemon IPC error"));

    // 3. everything_index_stats without daemon
    let stats_req = json!({
        "jsonrpc": "2.0",
        "id": 12,
        "method": "tools/call",
        "params": {
            "name": "everything_index_stats",
            "arguments": {}
        }
    });
    let stats_resp = client.send_request(&stats_req).await;
    let stats_struct = &stats_resp["result"]["structuredContent"];
    assert!(stats_struct["error"].as_str().unwrap().contains("Failed to retrieve stats"));

    // 4. everything_refresh
    let refresh_req = json!({
        "jsonrpc": "2.0",
        "id": 13,
        "method": "tools/call",
        "params": {
            "name": "everything_refresh",
            "arguments": { "full": false }
        }
    });
    let refresh_resp = client.send_request(&refresh_req).await;
    let refresh_struct = &refresh_resp["result"]["structuredContent"];
    assert_eq!(refresh_struct["mode"], "none");

    // 5. everything_open_gui
    let gui_req = json!({
        "jsonrpc": "2.0",
        "id": 14,
        "method": "tools/call",
        "params": {
            "name": "everything_open_gui",
            "arguments": { "query": "main.rs" }
        }
    });
    let gui_resp = client.send_request(&gui_req).await;
    let gui_struct = &gui_resp["result"]["structuredContent"];
    assert_eq!(gui_struct["launched"], false);

    client.close().await;
}

#[tokio::test]
async fn test_e2e_3_fs_tools_complete_lifecycle() {
    let tmp = tempfile::tempdir().expect("Failed to create tempdir");
    let tmp_path = tmp.path().to_path_buf();
    let tmp_str = tmp_path.to_string_lossy().to_string();

    let mut client = McpSubprocessClient::spawn(None, None, None).await;

    // A. fs_create_directory (mkdir)
    let nested_dir = tmp_path.join("sub").join("nested");
    let nested_dir_str = nested_dir.to_string_lossy().to_string();
    let mkdir_req = json!({
        "jsonrpc": "2.0",
        "id": 20,
        "method": "tools/call",
        "params": {
            "name": "fs_create_directory",
            "arguments": { "path": nested_dir_str }
        }
    });
    let mkdir_resp = client.send_request(&mkdir_req).await;
    assert_eq!(mkdir_resp["result"]["structuredContent"]["created"], true);
    assert!(nested_dir.exists() && nested_dir.is_dir());

    // B. fs_write_file
    let test_file = nested_dir.join("test_file.txt");
    let test_file_str = test_file.to_string_lossy().to_string();
    let write_req = json!({
        "jsonrpc": "2.0",
        "id": 21,
        "method": "tools/call",
        "params": {
            "name": "fs_write_file",
            "arguments": {
                "path": test_file_str,
                "content": "Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma\n"
            }
        }
    });
    let write_resp = client.send_request(&write_req).await;
    assert!(write_resp["result"]["structuredContent"]["bytes_written"].as_u64().unwrap() > 0);

    // C. fs_read_file
    let read_req = json!({
        "jsonrpc": "2.0",
        "id": 22,
        "method": "tools/call",
        "params": {
            "name": "fs_read_file",
            "arguments": { "path": test_file_str }
        }
    });
    let read_resp = client.send_request(&read_req).await;
    let read_struct = &read_resp["result"]["structuredContent"];
    assert_eq!(read_struct["content"], "Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma\n");
    assert_eq!(read_struct["binary"], false);
    assert_eq!(read_struct["truncated"], false);

    // D. fs_get_info (stat)
    let info_req = json!({
        "jsonrpc": "2.0",
        "id": 23,
        "method": "tools/call",
        "params": {
            "name": "fs_get_info",
            "arguments": { "path": test_file_str }
        }
    });
    let info_resp = client.send_request(&info_req).await;
    let info_struct = &info_resp["result"]["structuredContent"];
    assert_eq!(info_struct["exists"], true);
    assert_eq!(info_struct["dir"], false);
    assert!(info_struct["size"].as_u64().unwrap() > 20);

    // E. fs_edit_file (unified diff)
    let edit_req = json!({
        "jsonrpc": "2.0",
        "id": 24,
        "method": "tools/call",
        "params": {
            "name": "fs_edit_file",
            "arguments": {
                "path": test_file_str,
                "edits": [
                    { "oldText": "Line 2: Beta\n", "newText": "Line 2: Beta Replaced\n" }
                ]
            }
        }
    });
    let edit_resp = client.send_request(&edit_req).await;
    let edit_struct = &edit_resp["result"]["structuredContent"];
    assert_eq!(edit_struct["edits_applied"], 1);
    assert!(edit_struct["diff"].as_str().unwrap().contains("-Line 2: Beta"));
    assert!(edit_struct["diff"].as_str().unwrap().contains("+Line 2: Beta Replaced"));

    // F. fs_copy
    let copy_file = nested_dir.join("test_file_copy.txt");
    let copy_file_str = copy_file.to_string_lossy().to_string();
    let copy_req = json!({
        "jsonrpc": "2.0",
        "id": 25,
        "method": "tools/call",
        "params": {
            "name": "fs_copy",
            "arguments": {
                "source": test_file_str,
                "destination": copy_file_str
            }
        }
    });
    let copy_resp = client.send_request(&copy_req).await;
    assert_eq!(copy_resp["result"]["structuredContent"]["copied"], true);
    assert!(copy_file.exists());

    // G. fs_read_multiple_files
    let multi_req = json!({
        "jsonrpc": "2.0",
        "id": 26,
        "method": "tools/call",
        "params": {
            "name": "fs_read_multiple_files",
            "arguments": {
                "paths": [test_file_str, copy_file_str]
            }
        }
    });
    let multi_resp = client.send_request(&multi_req).await;
    let multi_results = multi_resp["result"]["structuredContent"]["files"].as_array().unwrap();
    assert_eq!(multi_results.len(), 2);
    assert!(multi_results[0]["content"].as_str().unwrap().contains("Beta Replaced"));
    assert!(multi_results[1]["content"].as_str().unwrap().contains("Beta Replaced"));

    // H. fs_list_directory
    let list_req = json!({
        "jsonrpc": "2.0",
        "id": 27,
        "method": "tools/call",
        "params": {
            "name": "fs_list_directory",
            "arguments": { "path": nested_dir_str }
        }
    });
    let list_resp = client.send_request(&list_req).await;
    let entries = list_resp["result"]["structuredContent"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);

    // I. fs_directory_tree
    let tree_req = json!({
        "jsonrpc": "2.0",
        "id": 28,
        "method": "tools/call",
        "params": {
            "name": "fs_directory_tree",
            "arguments": {
                "path": tmp_str,
                "max_depth": 5
            }
        }
    });
    let tree_resp = client.send_request(&tree_req).await;
    let tree_struct = &tree_resp["result"]["structuredContent"];
    assert_eq!(tree_struct["tree"]["type"], "directory");
    assert!(tree_struct["tree"]["children"].as_array().unwrap().len() >= 1);

    // J. fs_search_files
    let search_files_req = json!({
        "jsonrpc": "2.0",
        "id": 29,
        "method": "tools/call",
        "params": {
            "name": "fs_search_files",
            "arguments": {
                "path": tmp_str,
                "pattern": "copy"
            }
        }
    });
    let sf_resp = client.send_request(&search_files_req).await;
    let matches = sf_resp["result"]["structuredContent"]["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert!(matches[0].as_str().unwrap().contains("copy"));

    // K. fs_move
    let moved_file = nested_dir.join("test_file_moved.txt");
    let moved_file_str = moved_file.to_string_lossy().to_string();
    let move_req = json!({
        "jsonrpc": "2.0",
        "id": 30,
        "method": "tools/call",
        "params": {
            "name": "fs_move",
            "arguments": {
                "source": copy_file_str,
                "destination": moved_file_str
            }
        }
    });
    let move_resp = client.send_request(&move_req).await;
    assert_eq!(move_resp["result"]["structuredContent"]["moved"], true);
    assert!(!copy_file.exists());
    assert!(moved_file.exists());

    // L. fs_delete file
    let del_file_req = json!({
        "jsonrpc": "2.0",
        "id": 31,
        "method": "tools/call",
        "params": {
            "name": "fs_delete",
            "arguments": { "path": moved_file_str }
        }
    });
    let del_resp = client.send_request(&del_file_req).await;
    assert_eq!(del_resp["result"]["structuredContent"]["deleted"], true);
    assert!(!moved_file.exists());

    // M. fs_delete recursive directory
    let del_dir_req = json!({
        "jsonrpc": "2.0",
        "id": 32,
        "method": "tools/call",
        "params": {
            "name": "fs_delete",
            "arguments": {
                "path": tmp_path.join("sub").to_string_lossy().to_string(),
                "recursive": true
            }
        }
    });
    let del_dir_resp = client.send_request(&del_dir_req).await;
    assert_eq!(del_dir_resp["result"]["structuredContent"]["deleted"], true);
    assert!(!tmp_path.join("sub").exists());

    client.close().await;
}

#[tokio::test]
async fn test_e2e_3_health_categories_policy() {
    let tmp = tempfile::tempdir().unwrap();
    let allowed_root = tmp.path().to_path_buf();
    let allowed_root_str = allowed_root.to_string_lossy().to_string();

    // Spawn server with strict EVERYTHING_MCP_ROOTS set to allowed_root
    let mut client = McpSubprocessClient::spawn(None, None, Some(&allowed_root_str)).await;

    // 1. health tool
    let health_req = json!({
        "jsonrpc": "2.0",
        "id": 40,
        "method": "tools/call",
        "params": {
            "name": "hphe_health",
            "arguments": {}
        }
    });
    let health_resp = client.send_request(&health_req).await;
    let health_struct = &health_resp["result"]["structuredContent"];
    assert_eq!(health_struct["server"], "hphe-mcp");
    assert_eq!(health_struct["version"], "0.1.0");
    assert_eq!(health_struct["status"], "degraded"); // Pipe absent -> degraded
    assert_eq!(health_struct["pipe_connected"], false);

    // 2. categories tool
    let cat_req = json!({
        "jsonrpc": "2.0",
        "id": 41,
        "method": "tools/call",
        "params": {
            "name": "everything_categories",
            "arguments": {}
        }
    });
    let cat_resp = client.send_request(&cat_req).await;
    let cat_map = &cat_resp["result"]["structuredContent"]["categories"];
    assert!(cat_map["document"].as_array().unwrap().contains(&json!("pdf")));
    assert!(cat_map["audio"].as_array().unwrap().contains(&json!("mp3")));
    assert!(cat_map["picture"].as_array().unwrap().contains(&json!("png")));
    assert!(cat_map["video"].as_array().unwrap().contains(&json!("mp4")));
    assert!(cat_map["executable"].as_array().unwrap().contains(&json!("exe")));
    assert!(cat_map["compressed"].as_array().unwrap().contains(&json!("zip")));

    // 3. policy list allowed roots
    let roots_req = json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": "tools/call",
        "params": {
            "name": "fs_list_allowed_roots",
            "arguments": {}
        }
    });
    let roots_resp = client.send_request(&roots_req).await;
    let roots_arr = roots_resp["result"]["structuredContent"]["allowed_roots"].as_array().unwrap();
    assert_eq!(roots_arr.len(), 1);

    // 4. policy denial on unauthorized path
    let unauthorized_req = json!({
        "jsonrpc": "2.0",
        "id": 43,
        "method": "tools/call",
        "params": {
            "name": "fs_read_file",
            "arguments": {
                "path": r"C:\Windows\System32\drivers\etc\hosts"
            }
        }
    });
    let unauth_resp = client.send_request(&unauthorized_req).await;
    let unauth_result = &unauth_resp["result"];
    assert_eq!(unauth_result["isError"], true);
    let err_msg = unauth_result["structuredContent"]["error"].as_str().unwrap();
    assert!(
        err_msg.contains("outside allowed roots") || err_msg.contains("denied"),
        "Expected access denial, got: {}",
        err_msg
    );

    // 5. Real tools without indexes: clean index_absent status without crash
    let cs_req = json!({
        "jsonrpc": "2.0",
        "id": 44,
        "method": "tools/call",
        "params": {
            "name": "content_search",
            "arguments": { "query": "database query" }
        }
    });
    let cs_resp = client.send_request(&cs_req).await;
    assert_eq!(cs_resp["result"]["structuredContent"]["status"], "index_absent");

    let ss_req = json!({
        "jsonrpc": "2.0",
        "id": 45,
        "method": "tools/call",
        "params": {
            "name": "semantic_search",
            "arguments": { "query": "vector embedding query" }
        }
    });
    let ss_resp = client.send_request(&ss_req).await;
    assert_eq!(ss_resp["result"]["structuredContent"]["status"], "index_absent");

    client.close().await;
}

// ---------------------------------------------------------------------------
// 4. Erreurs: tool inconnu, params invalides, methode JSON-RPC inconnue, notifications
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_4_error_handling() {
    let mut client = McpSubprocessClient::spawn(None, None, None).await;

    // A. Unknown tool error -> JSON-RPC error -32602 (CODE_INVALID_PARAMS)
    let unknown_tool_req = json!({
        "jsonrpc": "2.0",
        "id": 50,
        "method": "tools/call",
        "params": {
            "name": "completely_nonexistent_tool_xyz",
            "arguments": {}
        }
    });
    let resp = client.send_request(&unknown_tool_req).await;
    assert_eq!(resp["id"], 50);
    assert_eq!(resp["error"]["code"], -32602);
    assert!(resp["error"]["message"].as_str().unwrap().contains("unknown tool completely_nonexistent_tool_xyz"));

    // B. Invalid params: tools/call without 'name'
    let invalid_call_req = json!({
        "jsonrpc": "2.0",
        "id": 51,
        "method": "tools/call",
        "params": {
            "arguments": {}
        }
    });
    let inv_resp = client.send_request(&invalid_call_req).await;
    assert_eq!(inv_resp["id"], 51);
    assert_eq!(inv_resp["error"]["code"], -32602);

    // C. Invalid params: tools/call where params is not an object
    let non_obj_req = json!({
        "jsonrpc": "2.0",
        "id": 52,
        "method": "tools/call",
        "params": "invalid_string_instead_of_object"
    });
    let non_obj_resp = client.send_request(&non_obj_req).await;
    assert_eq!(non_obj_resp["id"], 52);
    assert_eq!(non_obj_resp["error"]["code"], -32602);

    // D. Tool argument validation error: fs_read_file missing 'path' -> ToolResult isError=true
    let missing_arg_req = json!({
        "jsonrpc": "2.0",
        "id": 53,
        "method": "tools/call",
        "params": {
            "name": "fs_read_file",
            "arguments": {}
        }
    });
    let missing_arg_resp = client.send_request(&missing_arg_req).await;
    assert_eq!(missing_arg_resp["id"], 53);
    assert_eq!(missing_arg_resp["result"]["isError"], true);
    assert!(missing_arg_resp["result"]["structuredContent"]["error"].as_str().unwrap().contains("Missing required parameter 'path'"));

    // E. Unknown JSON-RPC method -> CODE_METHOD_NOT_FOUND (-32601)
    let unknown_method_req = json!({
        "jsonrpc": "2.0",
        "id": 54,
        "method": "custom/nonexistent/method",
        "params": {}
    });
    let unk_resp = client.send_request(&unknown_method_req).await;
    assert_eq!(unk_resp["id"], 54);
    assert_eq!(unk_resp["error"]["code"], -32601);
    assert!(unk_resp["error"]["message"].as_str().unwrap().contains("method not found: custom/nonexistent/method"));

    // F. Notification with unknown method (no id) -> server ignores and sends NO response
    let notif_req = json!({
        "jsonrpc": "2.0",
        "method": "custom/notification/silence",
        "params": {}
    });
    let notif_resp = client.send_raw(&notif_req.to_string()).await;
    assert!(notif_resp.is_none(), "Notifications with no id must not generate a response");

    // G. Parse error on malformed JSON -> CODE_PARSE_ERROR (-32700)
    let parse_err_resp = client.send_raw("not a valid json line at all").await;
    let pe = parse_err_resp.expect("Expected parse error response from server");
    assert_eq!(pe["jsonrpc"], "2.0");
    assert_eq!(pe["error"]["code"], -32700);
    assert!(pe["error"]["message"].as_str().unwrap().contains("Parse error"));

    client.close().await;
}

// ---------------------------------------------------------------------------
// 5. In-process mock pipe server E2E roundtrip:
//    Validates that when a daemon pipe is present, hphe-mcp seamlessly routes queries.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_5_mock_pipe_server_roundtrip() {
    let (_handle, pipe_name) = start_mock_pipe_server().await;

    let mut client = McpSubprocessClient::spawn(Some(&pipe_name), None, None).await;

    // 1. Health check with pipe connected
    let health_req = json!({
        "jsonrpc": "2.0",
        "id": 60,
        "method": "tools/call",
        "params": {
            "name": "hphe_health",
            "arguments": {}
        }
    });
    let health_resp = client.send_request(&health_req).await;
    let health_struct = &health_resp["result"]["structuredContent"];
    assert_eq!(health_struct["status"], "healthy");
    assert_eq!(health_struct["pipe_connected"], true);
    assert_eq!(health_struct["daemon_ping"]["version"], "0.1.0-e2e-mock");

    // 2. everything_search routed to daemon pipe
    let search_req = json!({
        "jsonrpc": "2.0",
        "id": 61,
        "method": "tools/call",
        "params": {
            "name": "everything_search",
            "arguments": { "query": "test_doc" }
        }
    });
    let search_resp = client.send_request(&search_req).await;
    let search_struct = &search_resp["result"]["structuredContent"];
    assert_eq!(search_struct["backend"], "hphe-pipe");
    assert_eq!(search_struct["total"], 1);
    let results = search_struct["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["name"], "test_doc.md");

    // 3. everything_index_stats routed to daemon pipe
    let stats_req = json!({
        "jsonrpc": "2.0",
        "id": 62,
        "method": "tools/call",
        "params": {
            "name": "everything_index_stats",
            "arguments": {}
        }
    });
    let stats_resp = client.send_request(&stats_req).await;
    let stats_struct = &stats_resp["result"]["structuredContent"];
    assert_eq!(stats_struct["total_entries"], 42);
    assert_eq!(stats_struct["file_count"], 30);
    assert_eq!(stats_struct["backend"], "hphe-pipe");

    // 4. resolve_path routed to daemon pipe
    let resolve_req = json!({
        "jsonrpc": "2.0",
        "id": 63,
        "method": "tools/call",
        "params": {
            "name": "resolve_path",
            "arguments": { "row": 7 }
        }
    });
    let resolve_resp = client.send_request(&resolve_req).await;
    let resolve_struct = &resolve_resp["result"]["structuredContent"];
    assert_eq!(resolve_struct["row"], 7);
    assert_eq!(resolve_struct["frn"], 9999);
    assert!(resolve_struct["path"].as_str().unwrap().contains("row_7.txt"));

    client.close().await;
}

// ---------------------------------------------------------------------------
// 6. Latency Benchmark over real subprocess stdio JSON-RPC
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_e2e_6_stdio_latency_benchmark() {
    let (_handle, pipe_name) = start_mock_pipe_server().await;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_file = tmp.path().join("bench_e2e.txt");
    std::fs::write(&tmp_file, "Benchmark payload for real stdio roundtrip tests\n").unwrap();
    let tmp_file_str = tmp_file.to_string_lossy().to_string();

    let mut client = McpSubprocessClient::spawn(Some(&pipe_name), None, None).await;

    // Warmup roundtrip
    let warmup = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
    let _ = client.send_request(&warmup).await;

    let iterations = 50;

    let benchmark_tools = vec![
        ("everything_search", json!({ "query": "test_doc" })),
        ("everything_index_stats", json!({})),
        ("everything_categories", json!({})),
        ("hphe_health", json!({})),
        ("resolve_path", json!({ "row": 7 })),
        ("fs_get_info", json!({ "path": tmp_file_str })),
        ("fs_read_file", json!({ "path": tmp_file_str })),
        ("fs_list_allowed_roots", json!({})),
        ("content_search", json!({ "query": "hello" })),
        ("semantic_search", json!({ "query": "hello" })),
        ("vec_search", json!({ "vector": [0.1, 0.2, 0.3, 0.4] })),
        ("vec_stats", json!({})),
        ("hybrid_search", json!({ "query": "test_doc" })),
    ];

    println!("\n=== E2E SUBPROCESS STDIO JSON-RPC BENCHMARK (N={} iters) ===", iterations);

    for (name, args) in benchmark_tools {
        let mut latencies_us = Vec::with_capacity(iterations);

        for i in 0..iterations {
            let req = json!({
                "jsonrpc": "2.0",
                "id": 1000 + i,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args
                }
            });

            let start = Instant::now();
            let resp = client.send_request(&req).await;
            let elapsed_us = start.elapsed().as_micros() as u64;

            assert!(resp["result"].is_object(), "Tool {} call failed: {:?}", name, resp);
            latencies_us.push(elapsed_us);
        }

        latencies_us.sort_unstable();
        let min = latencies_us[0];
        let p50 = latencies_us[iterations * 50 / 100];
        let p95 = latencies_us[iterations * 95 / 100];
        let p99 = latencies_us[iterations * 99 / 100];
        let avg = latencies_us.iter().sum::<u64>() / iterations as u64;

        println!(
            "E2E BENCH: {:<24} | min={:.3}ms | p50={:.3}ms | avg={:.3}ms | p95={:.3}ms | p99={:.3}ms",
            name,
            min as f64 / 1000.0,
            p50 as f64 / 1000.0,
            avg as f64 / 1000.0,
            p95 as f64 / 1000.0,
            p99 as f64 / 1000.0,
        );
    }

    client.close().await;
}
