//! hphe-ipc - Named Pipe IPC with NDJSON Protocol
//!
//! This crate provides secure inter-process communication for the Hephaistos
//! search engine daemon (`hphe-indexd`) using Windows named pipes with NDJSON
//! protocol framing.
//!
//! # Features
//!
//! - **Named Pipes**: Windows named pipe communication
//! - **NDJSON Protocol**: Newline-delimited JSON message framing
//! - **Restrictive ACL**: DACL limited to owner + SYSTEM + local admins
//! - **Concurrent Connections**: Multiple simultaneous client connections
//! - **Async**: Built on Tokio async runtime
//!
//! # Example Usage
//!
//! ## Server
//!
//! ```no_run
//! use hphe_ipc::server::{NamedPipeServer, NamedPipeServerBuilder, DefaultHandler};
//!
//! #[tokio::main]
//! async fn main() {
//!     let mut server = NamedPipeServerBuilder::new()
//!         .pipe_name("hphe-index")
//!         .apply_restrictive_acl(true)
//!         .build(DefaultHandler);
//!
//!     server.start().await.unwrap();
//!     server.run().await.unwrap();
//! }
//! ```
//!
//! ## Client
//!
//! ```no_run
//! use hphe_ipc::client::{Client, ClientBuilder};
//!
//! #[tokio::main]
//! async fn main() {
//!     let client = ClientBuilder::new()
//!         .pipe_name("hphe-index")
//!         .build();
//!
//!     client.connect().await.unwrap();
//!     let ping = client.ping().await.unwrap();
//!     println!("Server version: {}", ping.version);
//! }
//! ```

#![warn(clippy::all)]
#![allow(clippy::needless_doctest_main)]

pub mod client;
pub mod error;
pub mod protocol;
pub mod server;

// Re-export commonly used items
pub use client::{Client, ClientBuilder, ClientConfig, ConnectionState, IpcClient};
pub use error::{IpcError, IpcResult};
pub use protocol::{
    deserialize_ndjson, ErrorCode, ErrorResponse, FileEntry, IndexStats, Method,
    MethodParams, PingResponse, Request, RequestId, ResultResponse, Response,
    ResolveParams, ResolveResponse, SearchParams, SearchResponse, serialize_ndjson,
    UsnEvent, VolumeStats, WatchParams, WatchResponse,
};
pub use server::{
    DefaultHandler, NamedPipeServer, NamedPipeServerBuilder, RequestHandler, ServerConfig,
    ServerStats, WatchState,
};

/// Default pipe name: \\.\pipe\hphe-index
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\hphe-index";

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exports() {
        // Verify all public exports are accessible
        let _: Client = Client::new();
        let _: NamedPipeServer = NamedPipeServer::new(DefaultHandler);
        let _: IpcError = IpcError::ConnectionError("test".to_string());
        let _: Request = Request::ping(1);
    }

    #[test]
    fn test_version() {
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn test_default_pipe_name() {
        assert_eq!(DEFAULT_PIPE_NAME, r"\\.\pipe\hphe-index");
    }
}
