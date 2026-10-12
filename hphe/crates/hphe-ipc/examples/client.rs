//! Example: hphe-ipc client
//!
//! Demonstrates how to connect to the hphe-indexd daemon and make requests.
//!
//! Run with: cargo run --example client
//!
//! Note: The server must be running first (cargo run --example server)

use hphe_ipc::client::ClientBuilder;
use std::time::Instant;

#[tokio::main]
async fn main() {
    println!("hphe-ipc Example Client");
    println!("========================");
    println!();

    // Create client
    let client = ClientBuilder::new()
        .pipe_name("hphe-index")
        .connect_timeout_ms(5000)
        .request_timeout_ms(10000)
        .max_retries(3)
        .build();

    println!("Connecting to \\.\\pipe\\hphe-index...");
    
    match client.connect().await {
        Ok(_) => println!("Connected!\n"),
        Err(e) => {
            eprintln!("Failed to connect: {}", e);
            eprintln!("\nMake sure the server is running: cargo run --example server");
            std::process::exit(1);
        }
    }

    // Test ping
    println!("Testing ping...");
    match client.ping().await {
        Ok(ping) => {
            println!("Ping successful!");
            println!("  Version: {}", ping.version);
            println!("  Timestamp: {}", ping.timestamp);
            println!();
        }
        Err(e) => {
            eprintln!("Ping failed: {}", e);
        }
    }

    // Get stats
    println!("Getting index statistics...");
    match client.stats().await {
        Ok(stats) => {
            println!("Index Statistics:");
            println!("  Total entries: {}", stats.total_entries);
            println!("  Files: {}", stats.file_count);
            println!("  Directories: {}", stats.dir_count);
            println!("  Total size: {} bytes", stats.total_size);
            println!("  Memory usage: {} bytes", stats.memory_usage_bytes);
            println!();
        }
        Err(e) => {
            eprintln!("Stats failed: {}", e);
        }
    }

    // Search
    println!("Searching for 'test'...");
    match client.search("test", 10, 0).await {
        Ok(search) => {
            println!("Search results:");
            println!("  Total: {}", search.total);
            println!("  Returned: {} entries", search.entries.len());
            println!("  Has more: {}", search.has_more);
            
            for (i, entry) in search.entries.iter().enumerate().take(5) {
                println!("  Entry {}: {} ({} bytes)", i + 1, entry.name, entry.size);
            }
            println!();
        }
        Err(e) => {
            eprintln!("Search failed: {}", e);
        }
    }

    // Resolve
    println!("Resolving row 42...");
    match client.resolve(42).await {
        Ok(resolve) => {
            println!("Resolve successful:");
            println!("  Row: {}", resolve.row);
            println!("  FRN: {}", resolve.frn);
            println!("  Path: {}", resolve.path);
            println!();
        }
        Err(e) => {
            eprintln!("Resolve failed: {}", e);
        }
    }

    // Benchmark: measure roundtrip latency
    println!("Running latency benchmark (100 pings)...");
    let start = Instant::now();
    for i in 0..100 {
        match client.ping().await {
            Ok(_) => {}
            Err(e) => {
                eprintln!("Ping {} failed: {}", i, e);
                break;
            }
        }
    }
    let elapsed = start.elapsed();
    let avg_ms = elapsed.as_millis() as f64 / 100.0;
    println!("  Total time: {:?}", elapsed);
    println!("  Average roundtrip: {:.3} ms", avg_ms);
    
    if avg_ms > 5.0 {
        println!("  WARNING: Latency exceeds 5ms target!");
    } else {
        println!("  OK: Latency meets < 5ms target");
    }
    println!();

    // Subscribe to watch events
    println!("Subscribing to watch events...");
    match client.subscribe(None).await {
        Ok(watch) => {
            println!("Watch subscription: {:?}", watch.subscribed);
            println!();
        }
        Err(e) => {
            eprintln!("Watch subscribe failed: {}", e);
        }
    }

    // Disconnect
    println!("Disconnecting...");
    match client.disconnect().await {
        Ok(_) => println!("Disconnected"),
        Err(e) => eprintln!("Disconnect failed: {}", e),
    }
}
