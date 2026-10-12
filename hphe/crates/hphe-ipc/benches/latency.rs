//! Latency benchmark for hphe-ipc
//!
//! Measures roundtrip latency for named pipe communication
//! Target: < 5ms for ping and simple requests

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use hphe_ipc::client::ClientBuilder;
use hphe_ipc::server::{DefaultHandler, NamedPipeServerBuilder};

static BENCH_PIPE_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Unique pipe name for benchmarks
fn bench_pipe_name() -> String {
    let id = BENCH_PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!(r"\\.\pipe\hphe-ipc-bench-{}-{}", std::process::id(), id)
}

/// Start benchmark server
async fn start_bench_server() -> (tokio::task::JoinHandle<()>, String) {
    let pipe_name = bench_pipe_name();

    let mut server = NamedPipeServerBuilder::new()
        .pipe_name(pipe_name.clone())
        .max_connections(32)
        .read_timeout_ms(5000)
        .write_timeout_ms(5000)
        .apply_restrictive_acl(false)
        .build(DefaultHandler);

    server.start().await.unwrap();

    let handle = tokio::spawn(async move {
        let _ = server.run().await;
    });

    // Short pause for listener registration
    tokio::time::sleep(Duration::from_millis(15)).await;

    (handle, pipe_name)
}

fn bench_ping(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("ping_roundtrip", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let client = ClientBuilder::new()
                .pipe_name(pipe_name)
                .connect_timeout_ms(2000)
                .request_timeout_ms(5000)
                .build();

            client.connect().await.unwrap();

            // Warm up
            let _ = client.ping().await.unwrap();

            let start = Instant::now();
            for _ in 0..iter {
                let _ = black_box(client.ping().await.unwrap());
            }
            let elapsed = start.elapsed();

            let _ = client.disconnect().await;
            server_handle.abort();

            elapsed
        })
    });
}

fn bench_stats(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("stats_roundtrip", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let client = ClientBuilder::new()
                .pipe_name(pipe_name)
                .connect_timeout_ms(2000)
                .request_timeout_ms(5000)
                .build();

            client.connect().await.unwrap();

            // Warm up
            let _ = client.stats().await.unwrap();

            let start = Instant::now();
            for _ in 0..iter {
                let _ = black_box(client.stats().await.unwrap());
            }
            let elapsed = start.elapsed();

            let _ = client.disconnect().await;
            server_handle.abort();

            elapsed
        })
    });
}

fn bench_search(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("search_roundtrip", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let client = ClientBuilder::new()
                .pipe_name(pipe_name)
                .connect_timeout_ms(2000)
                .request_timeout_ms(5000)
                .build();

            client.connect().await.unwrap();

            // Warm up
            let _ = client.search("test", 10, 0).await.unwrap();

            let start = Instant::now();
            for _ in 0..iter {
                let _ = black_box(client.search("test query", 10, 0).await.unwrap());
            }
            let elapsed = start.elapsed();

            let _ = client.disconnect().await;
            server_handle.abort();

            elapsed
        })
    });
}

fn bench_resolve(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("resolve_roundtrip", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let client = ClientBuilder::new()
                .pipe_name(pipe_name)
                .connect_timeout_ms(2000)
                .request_timeout_ms(5000)
                .build();

            client.connect().await.unwrap();

            // Warm up
            let _ = client.resolve(0).await.unwrap();

            let start = Instant::now();
            for _ in 0..iter {
                let _ = black_box(client.resolve(12345).await.unwrap());
            }
            let elapsed = start.elapsed();

            let _ = client.disconnect().await;
            server_handle.abort();

            elapsed
        })
    });
}

fn bench_concurrent_connections(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("concurrent_ping_10", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let mut clients = Vec::new();
            for _ in 0..10 {
                let client = ClientBuilder::new()
                    .pipe_name(pipe_name.clone())
                    .connect_timeout_ms(2000)
                    .request_timeout_ms(5000)
                    .build();
                client.connect().await.unwrap();
                clients.push(client);
            }

            // Warm up
            for client in &clients {
                let _ = client.ping().await.unwrap();
            }

            let start = Instant::now();
            for _ in 0..iter {
                let mut handles = Vec::new();
                for client in &clients {
                    let client = client.clone();
                    handles.push(tokio::spawn(async move {
                        let _ = black_box(client.ping().await.unwrap());
                    }));
                }
                for handle in handles {
                    let _ = handle.await.unwrap();
                }
            }
            let elapsed = start.elapsed();

            for client in clients {
                let _ = client.disconnect().await;
            }

            server_handle.abort();

            elapsed
        })
    });
}

fn bench_sequential_requests(c: &mut Criterion) {
    let rt = tokio::runtime::Runtime::new().unwrap();

    c.bench_function("sequential_ping_100", |b| {
        b.to_async(&rt).iter_custom(|iter| async move {
            let (server_handle, pipe_name) = start_bench_server().await;

            let client = ClientBuilder::new()
                .pipe_name(pipe_name)
                .connect_timeout_ms(2000)
                .request_timeout_ms(5000)
                .build();

            client.connect().await.unwrap();

            // Warm up
            let _ = client.ping().await.unwrap();

            let start = Instant::now();
            for _ in 0..iter {
                for _ in 0..100 {
                    let _ = black_box(client.ping().await.unwrap());
                }
            }
            let elapsed = start.elapsed();

            let _ = client.disconnect().await;
            server_handle.abort();

            elapsed
        })
    });
}

fn custom_criterion() -> Criterion {
    Criterion::default()
        .sample_size(10)
        .warm_up_time(Duration::from_millis(200))
        .measurement_time(Duration::from_millis(500))
}

criterion_group! {
    name = benches;
    config = custom_criterion();
    targets = bench_ping, bench_stats, bench_search, bench_resolve, bench_concurrent_connections, bench_sequential_requests
}

criterion_main!(benches);
