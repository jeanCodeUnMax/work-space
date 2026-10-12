//! Integration tests for real content, vector and hybrid tools in hphe-mcp.
//!
//! All tests use temporary fixtures via tempfile. Zero real external indexes required.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use hphe_content::{ContentIndex, ContentIndexConfig, FileRow};
use hphe_ipc::client::ClientBuilder;
use hphe_ipc::protocol::{
    FileEntry, IndexStats, PingResponse, RequestId, ResolveResponse, ResultResponse,
    SearchParams, SearchResponse, WatchParams, WatchResponse,
};
use hphe_ipc::server::{NamedPipeServerBuilder, RequestHandler};
use hphe_ipc::IpcResult;
use hphe_vec::{VecIndex, VecIndexConfig};
use serde_json::json;

use hphe_mcp::tools::{content, hybrid, vec};
use hphe_mcp::AccessPolicy;

static PIPE_COUNTER: AtomicUsize = AtomicUsize::new(2000);

fn unique_pipe_name() -> String {
    let id = PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!(r"\\.\pipe\hphe-mcp-tools-v2-{}-{}", std::process::id(), id)
}

#[derive(Debug, Clone)]
struct MockDaemonHandler;

#[async_trait::async_trait]
impl RequestHandler for MockDaemonHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Ping(PingResponse {
            version: "0.1.0-mock".to_string(),
            uptime_ms: 100,
            timestamp: 1700000000,
        }))
    }

    async fn handle_stats(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Stats(IndexStats {
            total_entries: 10,
            file_count: 8,
            dir_count: 2,
            total_size: 1024,
            memory_usage_bytes: 4096,
            build_time_ms: 5,
            avg_name_length: 10.0,
            volumes: None,
        }))
    }

    async fn handle_search(
        &self,
        _request_id: RequestId,
        params: SearchParams,
    ) -> IpcResult<ResultResponse> {
        let entry = FileEntry {
            row: 1,
            frn: 100,
            parent_frn: 1,
            name: "test_doc.md".to_string(),
            path: r"C:\data\test_doc.md".to_string(),
            size: 512,
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
            path: format!(r"C:\data\row_{}.txt", row),
            row,
            frn: 100,
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

async fn start_mock_pipe() -> (tokio::task::JoinHandle<()>, String) {
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
async fn test_content_search_absent_index() {
    let absent_dir = tempfile::tempdir().unwrap();
    let missing_path = absent_dir.path().join("does_not_exist");

    let res = content::tool_content_search(&json!({
        "dir": missing_path.to_str().unwrap(),
        "query": "something",
        "limit": 10
    }))
    .expect("tool call ok");

    assert_eq!(res["status"], "index_absent");
    assert_eq!(res["matches"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_content_search_present_index_with_snippets() {
    let temp = tempfile::tempdir().unwrap();
    let idx_dir = temp.path().join("tantivy_idx");

    // Build temp index fixture
    let idx = ContentIndex::create(&idx_dir, ContentIndexConfig::default()).expect("create index");
    let row1 = FileRow {
        frn: 101,
        path: r"C:\data\algo.rs".to_string(),
        size: 120,
        mtime_filetime: 133_000_000_000_000_000,
        project_tag: "core".to_string(),
    };
    idx.upsert_row(
        &row1,
        "pub fn dijkstra_algorithm(graph: &Graph) -> Vec<Path> { solve_shortest_path() }",
    )
    .expect("upsert row 1");

    let row2 = FileRow {
        frn: 102,
        path: r"C:\data\readme.md".to_string(),
        size: 80,
        mtime_filetime: 133_000_000_000_000_000,
        project_tag: "docs".to_string(),
    };
    idx.upsert_row(
        &row2,
        "Project documentation and architectural blueprints.",
    )
    .expect("upsert row 2");
    idx.commit().expect("commit index");

    // Search query matching algo.rs
    let res = content::tool_content_search(&json!({
        "dir": idx_dir.to_str().unwrap(),
        "query": "dijkstra",
        "limit": 5
    }))
    .expect("tool call ok");

    assert_eq!(res["status"], "ok");
    assert_eq!(res["total"], 1);
    let matches = res["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["path"], r"C:\data\algo.rs");
    assert!(matches[0]["score"].as_f64().unwrap() > 0.0);
    assert!(matches[0]["snippet"].as_str().unwrap().contains("dijkstra"));
}

#[tokio::test]
async fn test_vec_absent_index() {
    let absent_dir = tempfile::tempdir().unwrap();
    let missing_path = absent_dir.path().join("no_vecs_here");
    std::env::set_var("HPHE_VEC_DIR", missing_path.to_str().unwrap());

    let res_stats = vec::tool_vec_stats(&json!({})).expect("vec_stats call ok");
    assert_eq!(res_stats["backend"], "usearch");
    assert_eq!(res_stats["collections"].as_array().unwrap().len(), 0);

    let res_search = vec::tool_vec_search(&json!({
        "vector": [0.1, 0.2, 0.3],
        "k": 5
    }))
    .expect("vec_search call ok");
    assert_eq!(res_search["status"], "index_absent");
    assert_eq!(res_search["results"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn test_vec_multi_collections_stats_and_knn() {
    let temp = tempfile::tempdir().unwrap();
    let vec_dir = temp.path().join("vec_collections");
    std::fs::create_dir_all(&vec_dir).unwrap();

    // Collection 1: alpha.usearch (dim 4)
    {
        let cfg = VecIndexConfig {
            dimensions: 4,
            ..Default::default()
        };
        let idx_alpha = VecIndex::create(&cfg, Some(&vec_dir)).expect("create alpha");
        idx_alpha
            .upsert_vector(1001, &[1.0, 0.0, 0.0, 0.0])
            .unwrap();
        idx_alpha
            .upsert_vector(1002, &[0.0, 1.0, 0.0, 0.0])
            .unwrap();
        idx_alpha
            .upsert_vector(1003, &[0.9, 0.1, 0.0, 0.0])
            .unwrap();
        idx_alpha.save("alpha.usearch").unwrap();
    }

    // Collection 2: beta.usearch (dim 8)
    {
        let cfg = VecIndexConfig {
            dimensions: 8,
            ..Default::default()
        };
        let idx_beta = VecIndex::create(&cfg, Some(&vec_dir)).expect("create beta");
        idx_beta
            .upsert_vector(2001, &[0.5; 8])
            .unwrap();
        idx_beta
            .upsert_vector(2002, &[0.0; 8])
            .unwrap();
        idx_beta.save("beta.usearch").unwrap();
    }

    std::env::set_var("HPHE_VEC_DIR", vec_dir.to_str().unwrap());

    // 1. vec_stats reports both collections
    let stats = vec::tool_vec_stats(&json!({})).expect("stats call ok");
    assert_eq!(stats["backend"], "usearch");
    let colls = stats["collections"].as_array().unwrap();
    assert_eq!(colls.len(), 2);
    assert_eq!(colls[0]["name"], "alpha");
    assert_eq!(colls[0]["dim"], 4);
    assert_eq!(colls[0]["size"], 3);
    assert_eq!(colls[1]["name"], "beta");
    assert_eq!(colls[1]["dim"], 8);
    assert_eq!(colls[1]["size"], 2);

    // 2. vec_search with default collection (first = alpha)
    let search_default = vec::tool_vec_search(&json!({
        "vector": [1.0, 0.0, 0.0, 0.0],
        "k": 2
    }))
    .expect("search default ok");
    assert_eq!(search_default["status"], "ok");
    assert_eq!(search_default["collection"], "alpha");
    let hits = search_default["results"].as_array().unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits[0]["key"] == 1001 || hits[0]["key"] == 1003);
    assert!(hits[0]["score"].as_f64().unwrap() > 0.8);

    // 3. vec_search with explicit collection beta
    let search_beta = vec::tool_vec_search(&json!({
        "collection": "beta",
        "vector": vec![0.5; 8],
        "k": 2
    }))
    .expect("search beta ok");
    assert_eq!(search_beta["status"], "ok");
    assert_eq!(search_beta["collection"], "beta");
    let beta_hits = search_beta["results"].as_array().unwrap();
    assert_eq!(beta_hits[0]["key"], 2001);

    // 4. vec_search by query_key lookup
    let search_by_key = vec::tool_vec_search(&json!({
        "collection": "alpha",
        "query_key": 1002,
        "k": 1
    }))
    .expect("search by key ok");
    assert_eq!(search_by_key["status"], "ok");
    let key_hits = search_by_key["results"].as_array().unwrap();
    assert_eq!(key_hits[0]["key"], 1002);
}

#[tokio::test]
async fn test_hybrid_search_combines_sources() {
    let (_handle, pipe_name) = start_mock_pipe().await;
    let client = ClientBuilder::new()
        .pipe_name(&pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(3000)
        .build();
    let policy = AccessPolicy::default();

    // Query test_doc matches the mock pipe daemon
    let res = hybrid::tool_hybrid_search(
        &json!({
            "query": "test_doc",
            "k": 5
        }),
        &client,
        &policy,
    )
    .await
    .expect("hybrid search call ok");

    assert_eq!(res["status"], "ok");
    assert_eq!(res["query"], "test_doc");
    let results = res["results"].as_array().unwrap();
    assert!(!results.is_empty());
    assert_eq!(results[0]["path"], r"C:\data\test_doc.md");
    assert!(results[0]["score"].as_f64().unwrap() > 0.0);
    assert!(results[0]["sources"].as_array().unwrap().contains(&json!("name")));
}
