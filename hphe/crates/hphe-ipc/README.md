# hphe-ipc

Named Pipe IPC with NDJSON Protocol for Hephaistos Search Engine

[![crates.io](https://img.shields.io/crates/v/hphe-ipc.svg)](https://crates.io/crates/hphe-ipc)
[![Documentation](https://docs.rs/hphe-ipc/badge.svg)](https://docs.rs/hphe-ipc)

## Overview

`hphe-ipc` provides secure inter-process communication for the Hephaistos search engine daemon (`hphe-indexd`) using Windows named pipes with NDJSON protocol framing.

### Features

- **Named Pipes**: Windows named pipe communication
- **NDJSON Protocol**: Newline-delimited JSON message framing
- **Restrictive ACL**: DACL limited to owner + SYSTEM + local admins
- **Concurrent Connections**: Multiple simultaneous client connections
- **Async**: Built on Tokio async runtime
- **Lightweight**: Zero-copy serialization with serde

## Usage

### Server

```rust,no_run
use hphe_ipc::server::{NamedPipeServer, NamedPipeServerBuilder, DefaultHandler};

#[tokio::main]
async fn main() {
    let mut server = NamedPipeServerBuilder::new()
        .pipe_name("hphe-index")
        .apply_restrictive_acl(true)
        .build(DefaultHandler);

    server.start().await.unwrap();
    server.run().await.unwrap();
}
```

### Client

```rust,no_run
use hphe_ipc::client::{Client, ClientBuilder};

#[tokio::main]
async fn main() {
    let client = ClientBuilder::new()
        .pipe_name("hphe-index")
        .build();

    client.connect().await.unwrap();
    
    // Make requests
    let ping = client.ping().await.unwrap();
    let stats = client.stats().await.unwrap();
    let search = client.search("query", 10, 0).await.unwrap();
    let resolve = client.resolve(123).await.unwrap();
    
    client.disconnect().await.unwrap();
}
```

## Protocol

### Message Format

All messages are NDJSON formatted - one JSON object per line:

```json
{"id":1,"method":"ping","params":{}}\n{"id":1,"result":{"version":"1.0.0","uptime_ms":1234,"timestamp":5678}}\n```

### Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `ping` | - | PingResponse | Health check |
| `stats` | - | IndexStats | Get index statistics |
| `search` | {query, limit, offset} | SearchResponse | Search the index |
| `resolve` | {row} | ResolveResponse | Resolve row to path |
| `watch` | {subscribe, volume?} | WatchResponse | Subscribe to USN events |

### Error Response

```json
{"id":1,"error":{"code":"NOT_FOUND","message":"Row not found"}}
```

## Security

### Restrictive ACL

The server applies a restrictive DACL that only allows:
- The pipe creator/owner
- SYSTEM account
- Local Administrators group

This ensures that only authorized processes can connect to the daemon.

### Implementation Note

The `interprocess` crate doesn't directly support setting ACL on Windows named pipes. In a production implementation, you should use the Windows API directly (`CreateNamedPipe` with explicit security descriptor) for full ACL control.

## Performance

### Targets

- Ping roundtrip: < 1ms
- Simple request (stats): < 2ms
- Search request: < 10ms
- Concurrent connections: 100+

### Benchmarking

```bash
# Run benchmarks
cargo bench

# Output includes:
# - ping_roundtrip
# - stats_roundtrip
# - search_roundtrip
# - resolve_roundtrip
# - concurrent_ping_10
# - sequential_ping_100
```

## Examples

```bash
# Run server example
cargo run --example server

# Run client example (in another terminal)
cargo run --example client

# Run integration tests
cargo test --test integration

# Run benchmarks
cargo bench
```

## License

MIT License

## Contributing

Contributions are welcome! Please see the main [Hephaistos](https://github.com/HephaistosKit) repository for contribution guidelines.
