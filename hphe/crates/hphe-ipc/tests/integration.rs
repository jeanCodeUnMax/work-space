//! Integration tests for hphe-ipc
//!
//! Tests the full roundtrip: server spawn -> client connect -> request/response -> disconnect

use std::time::Duration;

use hphe_ipc::client::ClientBuilder;
use hphe_ipc::server::{DefaultHandler, NamedPipeServerBuilder};
use hphe_ipc::{Method, MethodParams, Request};
use tokio::task::JoinHandle;

use std::sync::atomic::{AtomicUsize, Ordering};

static PIPE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Unique pipe name for tests
fn test_pipe_name() -> String {
    let id = PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!(r"\\.\pipe\hphe-ipc-test-{}-{}", std::process::id(), id)
}

/// Start a test server in the background
async fn start_test_server() -> (JoinHandle<()>, String) {
    let pipe_name = test_pipe_name();
    
    let mut server = NamedPipeServerBuilder::new()
        .pipe_name(pipe_name.clone())
        .max_connections(16)
        .read_timeout_ms(5000)
        .write_timeout_ms(5000)
        .apply_restrictive_acl(false) // Disable ACL for tests
        .build(DefaultHandler);

    // Start the server
    server.start().await.unwrap();
    
    // Spawn the server run loop
    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });
    
    // Give the server a moment to start
    tokio::time::sleep(Duration::from_millis(100)).await;
    
    (handle, pipe_name)
}

#[tokio::test]
async fn test_server_start_stop() {
    let (handle, _) = start_test_server().await;
    
    // Signal shutdown (we can't easily do this with the current API)
    // The server will timeout on read, so we just drop it
    drop(handle);
    
    // Give it a moment to clean up
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn test_client_connect_disconnect() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create a client
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .max_retries(3)
        .build();
    
    // Connect
    let connect_result = client.connect().await;
    assert!(connect_result.is_ok(), "Failed to connect: {:?}", connect_result);
    
    // Check if connected
    assert!(client.is_connected().await, "Client should be connected");
    
    // Disconnect
    let disconnect_result = client.disconnect().await;
    assert!(disconnect_result.is_ok(), "Failed to disconnect");
    
    // Check if disconnected
    assert!(!client.is_connected().await, "Client should be disconnected");
    
    drop(server_handle);
}

#[tokio::test]
async fn test_ping_roundtrip() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create a client
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    // Connect
    client.connect().await.unwrap();
    
    // Ping
    let ping_result = client.ping().await;
    assert!(ping_result.is_ok(), "Ping failed: {:?}", ping_result);
    
    let ping_response = ping_result.unwrap();
    assert_eq!(ping_response.version, "1.0.0");
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_stats_roundtrip() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create a client
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    // Connect
    client.connect().await.unwrap();
    
    // Get stats
    let stats_result = client.stats().await;
    assert!(stats_result.is_ok(), "Stats failed: {:?}", stats_result);
    
    let stats = stats_result.unwrap();
    // Default handler returns empty stats
    assert_eq!(stats.total_entries, 0);
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_search_roundtrip() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create a client
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    // Connect
    client.connect().await.unwrap();
    
    // Search
    let search_result = client.search("test query", 10, 0).await;
    assert!(search_result.is_ok(), "Search failed: {:?}", search_result);
    
    let search_response = search_result.unwrap();
    assert_eq!(search_response.total, 0); // Default handler returns no results
    assert!(search_response.entries.is_empty());
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_resolve_roundtrip() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create a client
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    // Connect
    client.connect().await.unwrap();
    
    // Resolve row 0
    let resolve_result = client.resolve(0).await;
    assert!(resolve_result.is_ok(), "Resolve failed: {:?}", resolve_result);
    
    let resolve_response = resolve_result.unwrap();
    assert_eq!(resolve_response.row, 0);
    assert!(resolve_response.path.contains("0"));
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_multiple_clients() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    // Create multiple clients
    let client1 = ClientBuilder::new()
        .pipe_name(pipe_name.clone())
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    let client2 = ClientBuilder::new()
        .pipe_name(pipe_name.clone())
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    let client3 = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    // Connect all clients
    client1.connect().await.unwrap();
    client2.connect().await.unwrap();
    client3.connect().await.unwrap();
    
    // All should be connected
    assert!(client1.is_connected().await);
    assert!(client2.is_connected().await);
    assert!(client3.is_connected().await);
    
    // Ping from all clients
    let ping1 = client1.ping().await.unwrap();
    let ping2 = client2.ping().await.unwrap();
    let ping3 = client3.ping().await.unwrap();
    
    assert_eq!(ping1.version, "1.0.0");
    assert_eq!(ping2.version, "1.0.0");
    assert_eq!(ping3.version, "1.0.0");
    
    // Disconnect all
    client1.disconnect().await.unwrap();
    client2.disconnect().await.unwrap();
    client3.disconnect().await.unwrap();
    
    drop(server_handle);
}

#[tokio::test]
async fn test_raw_request_response() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    client.connect().await.unwrap();
    
    // Create a raw request
    let request = Request {
        id: 42,
        method: Method::Ping,
        params: MethodParams::Ping(hphe_ipc::protocol::PingParams),
    };
    
    // Send raw request via inner client call
    let response = client.call(request.method, request.params).await.unwrap();
    
    // Server assigns sequential ID or matches request ID depending on API
    assert!(response.is_success());
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_watch_roundtrip() {
    let (server_handle, pipe_name) = start_test_server().await;

    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();

    client.connect().await.unwrap();

    let watch_sub = client.subscribe(Some('C')).await.unwrap();
    assert!(watch_sub.subscribed);
    assert_eq!(watch_sub.volume, Some('C'));

    let watch_unsub = client.unsubscribe().await.unwrap();
    assert!(!watch_unsub.subscribed);

    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_restrictive_dacl_roundtrip() {
    // Test server with apply_restrictive_acl(true)
    // The DACL limits access to owner + SYSTEM + local administrators.
    // The current process runs under the owner account, so the connection succeeds.
    // Unauthorized accounts (non-admin / different user / remote network clients)
    // are rejected with Windows ERROR_ACCESS_DENIED (5) -> IpcError::AccessDenied.
    let pipe_name = format!(r"\\.\pipe\hphe-ipc-dacl-test-{}-{}", std::process::id(), PIPE_COUNTER.fetch_add(1, Ordering::SeqCst));

    let mut server = NamedPipeServerBuilder::new()
        .pipe_name(pipe_name.clone())
        .max_connections(8)
        .read_timeout_ms(5000)
        .write_timeout_ms(5000)
        .apply_restrictive_acl(true)
        .build(DefaultHandler);

    server.start().await.expect("Server with restrictive DACL should start successfully");

    let server_handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    tokio::time::sleep(Duration::from_millis(100)).await;

    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();

    client.connect().await.expect("Owner should connect successfully to pipe with restrictive DACL");
    let ping = client.ping().await.expect("Ping should succeed on restrictive DACL pipe");
    assert_eq!(ping.version, "1.0.0");

    client.disconnect().await.unwrap();
    drop(server_handle);
}

#[tokio::test]
async fn test_invalid_method_params() {
    let (server_handle, pipe_name) = start_test_server().await;
    
    let client = ClientBuilder::new()
        .pipe_name(pipe_name)
        .connect_timeout_ms(2000)
        .request_timeout_ms(5000)
        .build();
    
    client.connect().await.unwrap();
    
    // Try to call search with wrong params (this should fail gracefully)
    // The server should handle this with an error response
    let response = client.call(
        Method::Search,
        MethodParams::Ping(hphe_ipc::protocol::PingParams)
    ).await.unwrap();
    
    // Should get an error response
    assert!(response.is_error());
    
    client.disconnect().await.unwrap();
    drop(server_handle);
}
