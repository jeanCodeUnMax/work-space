//! Integration and wiring tests for DaemonHandler and Named Pipe IPC server.

use std::sync::atomic::AtomicI64;
use std::sync::Arc;
use std::time::Duration;

use hphe_daemon::DaemonHandler;
use hphe_index::{generate_synthetic_entries, FileIndex};
use hphe_ipc::client::IpcClient;
use hphe_ipc::protocol::{ResultResponse, SearchParams, WatchParams};
use hphe_ipc::server::{NamedPipeServerBuilder, RequestHandler};

#[tokio::test]
async fn test_daemon_handler_direct_wiring() {
    // 1. Build synthetic FileIndex with known entries
    let entries = generate_synthetic_entries(200);
    let index = Arc::new(FileIndex::build_with_drive("C:", entries));
    let last_usn = Arc::new(AtomicI64::new(42000));

    let handler = DaemonHandler::new(index.clone(), last_usn.clone(), 'C');

    // 2. Test ping
    let ping_res = handler.handle_ping(1).await.expect("ping must succeed");
    match ping_res {
        ResultResponse::Ping(ping) => {
            assert!(!ping.version.is_empty());
            assert!(ping.timestamp > 0);
        }
        _ => panic!("Expected Ping response"),
    }

    // 3. Test stats
    let stats_res = handler.handle_stats(2).await.expect("stats must succeed");
    match stats_res {
        ResultResponse::Stats(st) => {
            assert_eq!(st.total_entries, 200);
            assert!(st.volumes.is_some());
            let vols = st.volumes.unwrap();
            let vol_c = vols.get(&'C').expect("Volume C must be present");
            assert_eq!(vol_c.last_usn, 42000);
            assert_eq!(vol_c.entry_count, 200);
        }
        _ => panic!("Expected Stats response"),
    }

    // 4. Test search: empty query (all items)
    let search_all = handler
        .handle_search(
            3,
            SearchParams {
                query: "".to_string(),
                limit: 50,
                offset: 0,
                include_deleted: false,
            },
        )
        .await
        .expect("empty search must succeed");

    match search_all {
        ResultResponse::Search(resp) => {
            assert_eq!(resp.total, 200);
            assert_eq!(resp.entries.len(), 50);
            assert!(resp.has_more);
        }
        _ => panic!("Expected Search response"),
    }

    // 5. Test search: substring
    let first_entry_name = index.name(1).to_string();
    let query_prefix = &first_entry_name[..first_entry_name.len().min(4)];
    let search_sub = handler
        .handle_search(
            4,
            SearchParams {
                query: query_prefix.to_string(),
                limit: 10,
                offset: 0,
                include_deleted: false,
            },
        )
        .await
        .expect("substring search must succeed");

    match search_sub {
        ResultResponse::Search(resp) => {
            assert!(resp.total > 0);
            assert!(!resp.entries.is_empty());
            assert!(resp.entries[0].name.to_lowercase().contains(&query_prefix.to_lowercase()));
            assert!(resp.entries[0].path.starts_with("C:\\"));
        }
        _ => panic!("Expected Search response"),
    }

    // 6. Test resolve
    let resolve_res = handler.handle_resolve(5, 1).await.expect("resolve must succeed");
    match resolve_res {
        ResultResponse::Resolve(r) => {
            assert_eq!(r.row, 1);
            assert!(r.path.starts_with("C:\\"));
        }
        _ => panic!("Expected Resolve response"),
    }

    // 7. Test watch
    let watch_res = handler
        .handle_watch(6, WatchParams { subscribe: true, volume: Some('C') })
        .await
        .expect("watch must succeed");
    match watch_res {
        ResultResponse::Watch(w) => {
            assert!(w.subscribed);
            assert_eq!(w.volume, Some('C'));
        }
        _ => panic!("Expected Watch response"),
    }
}

#[tokio::test]
async fn test_daemon_live_overlay_mutations() {
    let entries = generate_synthetic_entries(50);
    let index = Arc::new(FileIndex::build_with_drive("C:", entries));
    let last_usn = Arc::new(AtomicI64::new(100));

    let handler = DaemonHandler::new(index.clone(), last_usn, 'C');

    let target_frn = index.frn(5);
    let target_name = index.name(5).to_string();

    // Verify entry is initially active and found
    let initial_search = handler
        .handle_search(
            1,
            SearchParams {
                query: target_name.clone(),
                limit: 10,
                offset: 0,
                include_deleted: false,
            },
        )
        .await
        .unwrap();

    let initial_count = match initial_search {
        ResultResponse::Search(s) => s.total,
        _ => 0,
    };
    assert!(initial_count >= 1);

    // Apply live delete via overlay
    index.apply_delete(target_frn);

    // Search without include_deleted should no longer return it
    let after_delete = handler
        .handle_search(
            2,
            SearchParams {
                query: target_name.clone(),
                limit: 10,
                offset: 0,
                include_deleted: false,
            },
        )
        .await
        .unwrap();

    match after_delete {
        ResultResponse::Search(s) => {
            assert_eq!(s.total, 0);
        }
        _ => panic!("Expected Search response"),
    }

    // Search with include_deleted = true should still find it
    let include_del = handler
        .handle_search(
            3,
            SearchParams {
                query: target_name,
                limit: 10,
                offset: 0,
                include_deleted: true,
            },
        )
        .await
        .unwrap();

    match include_del {
        ResultResponse::Search(s) => {
            assert!(s.total >= 1);
        }
        _ => panic!("Expected Search response"),
    }
}

#[tokio::test]
async fn test_named_pipe_ipc_end_to_end_roundtrip() {
    let pipe_name = r"\\.\pipe\hphe-daemon-test-wiring";
    let entries = generate_synthetic_entries(100);
    let index = Arc::new(FileIndex::build_with_drive("C:", entries));
    let last_usn = Arc::new(AtomicI64::new(99999));

    let handler = DaemonHandler::new(index.clone(), last_usn, 'C');

    // Build server without restrictive DACL for local test execution
    let mut server = NamedPipeServerBuilder::new()
        .pipe_name(pipe_name)
        .apply_restrictive_acl(false)
        .build(handler);

    server.start().await.expect("Server start must succeed");

    let server_state = server.state().clone();
    let server_task = tokio::spawn(async move {
        let _ = server.run().await;
    });

    // Small delay to ensure server is accepting
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Connect client
    let mut client = IpcClient::with_config(hphe_ipc::client::ClientConfig {
        pipe_name: pipe_name.to_string(),
        connect_timeout_ms: 3000,
        request_timeout_ms: 3000,
        max_retries: 5,
    });

    client.connect().await.expect("Client must connect to server");

    // Ping RPC
    let ping = client.ping().await.expect("Client ping must succeed");
    assert!(!ping.version.is_empty());

    // Stats RPC
    let stats = client.stats().await.expect("Client stats must succeed");
    assert_eq!(stats.total_entries, 100);

    // Search RPC
    let search = client.search("", 20, 0).await.expect("Client search must succeed");
    assert_eq!(search.total, 100);
    assert_eq!(search.entries.len(), 20);

    // Resolve RPC
    let resolve = client.resolve(2).await.expect("Client resolve must succeed");
    assert_eq!(resolve.row, 2);
    assert!(resolve.path.starts_with("C:\\"));

    // Disconnect client
    client.disconnect().await.expect("Disconnect must succeed");

    // Stop server
    server_state.signal_shutdown();
    let _ = tokio::time::timeout(Duration::from_millis(500), server_task).await;
}
