//! Example: hphe-ipc server
//!
//! Demonstrates how to create and run a named pipe server with the hphe-ipc crate.
//!
//! Run with: cargo run --example server

use hphe_ipc::server::NamedPipeServerBuilder;
use hphe_ipc::protocol::{FileEntry, IndexStats, RequestId, ResultResponse, SearchResponse, WatchParams, WatchResponse};
use hphe_ipc::error::IpcResult;

/// Custom handler that implements real functionality
#[derive(Debug, Clone, Default)]
struct ExampleHandler;

#[async_trait::async_trait]
impl hphe_ipc::server::RequestHandler for ExampleHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        use std::time::{SystemTime, UNIX_EPOCH};
        
        let uptime = std::time::Instant::now()
            .duration_since(std::time::Instant::now() - std::time::Duration::from_secs(100))
            .as_millis() as u64;
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(ResultResponse::Ping(hphe_ipc::protocol::PingResponse {
            version: "1.0.0".to_string(),
            uptime_ms: uptime,
            timestamp,
        }))
    }

    async fn handle_stats(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        // In a real implementation, this would query the actual index
        Ok(ResultResponse::Stats(IndexStats {
            total_entries: 1_000_000,
            file_count: 800_000,
            dir_count: 200_000,
            total_size: 500_000_000_000, // 500 GB
            memory_usage_bytes: 2_000_000_000,
            build_time_ms: 5000,
            avg_name_length: 20.5,
            volumes: None,
        }))
    }

    async fn handle_search(
        &self,
        _request_id: RequestId,
        params: hphe_ipc::protocol::SearchParams,
    ) -> IpcResult<ResultResponse> {
        // Simulate search results
        let entries: Vec<FileEntry> = (0..params.limit.min(100))
            .map(|i| FileEntry {
                row: i + params.offset,
                frn: (i + params.offset) as u64,
                parent_frn: 0,
                name: format!("file_{}.txt", i + params.offset),
                path: format!("C:\\path\\to\\file_{}.txt", i + params.offset),
                size: 1024 * (i as u64 + 1),
                is_dir: false,
                created: 1000000000,
                modified: 2000000000,
                accessed: 3000000000,
                attributes: 0x20, // FILE_ATTRIBUTE_ARCHIVE
            })
            .collect();

        Ok(ResultResponse::Search(SearchResponse {
            total: 1_000_000,
            entries,
            has_more: true,
            offset: params.offset,
            limit: params.limit,
        }))
    }

    async fn handle_resolve(
        &self,
        _request_id: RequestId,
        row: usize,
    ) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Resolve(hphe_ipc::protocol::ResolveResponse {
            path: format!("C:\\resolved\\path\\for\\row_{}", row),
            row,
            frn: row as u64,
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

    fn on_connect(&self) {
        println!("[Server] New connection established");
    }

    fn on_disconnect(&self) {
        println!("[Server] Connection closed");
    }

    fn on_error(&self, error: &hphe_ipc::error::IpcError) {
        eprintln!("[Server] Error: {}", error);
    }
}

#[tokio::main]
async fn main() -> IpcResult<()> {
    println!("hphe-ipc Example Server");
    println!("========================");
    println!();

    // Create server with custom handler
    let mut server = NamedPipeServerBuilder::new()
        .pipe_name("hphe-index")
        .max_connections(64)
        .read_timeout_ms(30000)
        .write_timeout_ms(10000)
        .apply_restrictive_acl(true) // Apply restrictive ACL in production
        .build(ExampleHandler);

    println!("Starting server on \\.\\pipe\\hphe-index");
    println!("Press Ctrl+C to stop");
    println!();

    // Start the server
    server.start().await?;

    // Run the server (blocks until shutdown)
    server.run().await?;

    println!("Server stopped");
    Ok(())
}
