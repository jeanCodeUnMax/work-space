//! Named Pipe Server for hphe-ipc
//!
//! Implements a named pipe server on Windows with:
//! - NDJSON protocol framing
//! - Concurrent connection support
//! - Request handling with timeout/keepalive
//!
//! Note: ACL support requires direct Windows API usage (not yet implemented in this version)

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use interprocess::os::windows::named_pipe::{
    pipe_mode, PipeListenerOptions, PipeMode,
};
use interprocess::os::windows::named_pipe::tokio::{
    DuplexPipeStream, PipeListener,
};
use interprocess::os::windows::security_descriptor::SecurityDescriptor;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, trace, warn};
use widestring::U16CString;

use crate::error::{IpcError, IpcResult};
use crate::protocol::{
    deserialize_ndjson, ErrorCode, ErrorResponse, Method, MethodParams, Request,
    RequestId, Response, ResultResponse, SearchParams, SearchResponse, serialize_ndjson,
    UsnEvent, WatchParams, WatchResponse,
};

/// Default pipe name: \\.\pipe\hphe-index
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\hphe-index";

/// Default connection timeout in milliseconds
pub const DEFAULT_CONNECTION_TIMEOUT_MS: u64 = 5000;

/// Default read timeout in milliseconds
pub const DEFAULT_READ_TIMEOUT_MS: u64 = 30000;

/// Default write timeout in milliseconds
pub const DEFAULT_WRITE_TIMEOUT_MS: u64 = 10000;

/// Maximum message size in bytes
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MiB

/// Maximum concurrent connections
pub const MAX_CONNECTIONS: usize = 128;

/// Server statistics
#[derive(Debug, Clone)]
pub struct ServerStats {
    pub started_at: Instant,
    pub connection_count: usize,
    pub request_count: usize,
    pub error_count: usize,
    pub active_connections: usize,
}

impl Default for ServerStats {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            connection_count: 0,
            request_count: 0,
            error_count: 0,
            active_connections: 0,
        }
    }
}

impl ServerStats {
    pub fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

/// Configuration for the named pipe server
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Pipe name (without \\.\pipe\ prefix will be added)
    pub pipe_name: String,
    /// Maximum concurrent connections
    pub max_connections: usize,
    /// Connection timeout in milliseconds
    pub connection_timeout_ms: u64,
    /// Read timeout in milliseconds
    pub read_timeout_ms: u64,
    /// Write timeout in milliseconds
    pub write_timeout_ms: u64,
    /// Maximum message size
    pub max_message_size: usize,
    /// Whether to apply restrictive ACL (Owner + SYSTEM + Administrators)
    pub apply_restrictive_acl: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            pipe_name: DEFAULT_PIPE_NAME.to_string(),
            max_connections: MAX_CONNECTIONS,
            connection_timeout_ms: DEFAULT_CONNECTION_TIMEOUT_MS,
            read_timeout_ms: DEFAULT_READ_TIMEOUT_MS,
            write_timeout_ms: DEFAULT_WRITE_TIMEOUT_MS,
            max_message_size: MAX_MESSAGE_SIZE,
            apply_restrictive_acl: true,
        }
    }
}

impl ServerConfig {
    /// Create a new server configuration
    pub fn new(pipe_name: impl Into<String>) -> Self {
        Self {
            pipe_name: pipe_name.into(),
            ..Default::default()
        }
    }

    /// Get the full pipe name with \\.\pipe\ prefix if not present
    pub fn full_pipe_name(&self) -> String {
        if self.pipe_name.starts_with(r"\\.\pipe\") {
            self.pipe_name.clone()
        } else {
            format!(r"\\.\pipe\{}", self.pipe_name)
        }
    }
}

/// Trait for handling requests (to be implemented by application code)
#[async_trait::async_trait]
pub trait RequestHandler: Send + Sync {
    /// Handle a ping request
    async fn handle_ping(&self, request_id: RequestId) -> IpcResult<ResultResponse>;

    /// Handle a stats request
    async fn handle_stats(&self, request_id: RequestId) -> IpcResult<ResultResponse>;

    /// Handle a search request
    async fn handle_search(&self, request_id: RequestId, params: SearchParams) -> IpcResult<ResultResponse>;

    /// Handle a resolve request
    async fn handle_resolve(&self, request_id: RequestId, row: usize) -> IpcResult<ResultResponse>;

    /// Handle a watch request
    async fn handle_watch(&self, request_id: RequestId, params: WatchParams) -> IpcResult<ResultResponse>;

    /// Called when a new connection is established
    fn on_connect(&self) {}

    /// Called when a connection is closed
    fn on_disconnect(&self) {}

    /// Called when an error occurs
    fn on_error(&self, _error: &IpcError) {}
}

/// Default request handler implementation
#[derive(Debug, Clone, Default)]
pub struct DefaultHandler;

#[async_trait::async_trait]
impl RequestHandler for DefaultHandler {
    async fn handle_ping(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        use std::time::SystemTime;

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(ResultResponse::Ping(crate::protocol::PingResponse {
            version: "1.0.0".to_string(),
            uptime_ms: 0,
            timestamp: now,
        }))
    }

    async fn handle_stats(&self, _request_id: RequestId) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Stats(crate::protocol::IndexStats {
            total_entries: 0,
            file_count: 0,
            dir_count: 0,
            total_size: 0,
            memory_usage_bytes: 0,
            build_time_ms: 0,
            avg_name_length: 0.0,
            volumes: None,
        }))
    }

    async fn handle_search(
        &self,
        _request_id: RequestId,
        params: SearchParams,
    ) -> IpcResult<ResultResponse> {
        // Return empty results for default handler
        Ok(ResultResponse::Search(SearchResponse {
            total: 0,
            entries: Vec::new(),
            has_more: false,
            offset: params.offset,
            limit: params.limit,
        }))
    }

    async fn handle_resolve(
        &self,
        _request_id: RequestId,
        row: usize,
    ) -> IpcResult<ResultResponse> {
        Ok(ResultResponse::Resolve(crate::protocol::ResolveResponse {
            path: format!("C:\\path\\to\\row_{}", row),
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
}

/// State for handling watch subscriptions
#[derive(Debug, Default)]
pub struct WatchState {
    subscribers: RwLock<HashMap<RequestId, mpsc::Sender<UsnEvent>>>,
    next_subscription_id: std::sync::atomic::AtomicU64,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            subscribers: RwLock::new(HashMap::new()),
            next_subscription_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    pub fn subscribe(&self) -> (RequestId, mpsc::Receiver<UsnEvent>) {
        let id = self
            .next_subscription_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(100);
        
        self.subscribers
            .write()
            .unwrap()
            .insert(id, tx);
        
        (id, rx)
    }

    pub fn unsubscribe(&self, id: RequestId) {
        self.subscribers
            .write()
            .unwrap()
            .remove(&id);
    }

    pub fn broadcast(&self, event: UsnEvent) {
        let subscribers = self.subscribers.read().unwrap();
        for (_, tx) in subscribers.iter() {
            let _ = tx.try_send(event.clone());
        }
    }
}

///// Shared server state
pub struct ServerState {
    pub config: ServerConfig,
    pub stats: Mutex<ServerStats>,
    pub handler: Arc<dyn RequestHandler>,
    pub watch_state: Arc<WatchState>,
    pub shutdown_signal: tokio::sync::watch::Sender<bool>,
}

impl std::fmt::Debug for ServerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerState")
            .field("config", &self.config)
            .field("stats", &self.stats)
            .finish()
    }
}

impl ServerState {
    pub fn new(config: ServerConfig, handler: impl RequestHandler + 'static) -> Self {
        let (shutdown_tx, _) = tokio::sync::watch::channel(false);

        Self {
            config,
            stats: Mutex::new(ServerStats::default()),
            handler: Arc::new(handler),
            watch_state: Arc::new(WatchState::new()),
            shutdown_signal: shutdown_tx,
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        *self.shutdown_signal.borrow()
    }

    pub fn signal_shutdown(&self) {
        let _ = self.shutdown_signal.send(true);
    }
}

/// Handle a single connection using a DuplexPipeStream
async fn handle_connection(
    state: Arc<ServerState>,
    mut stream: DuplexPipeStream<pipe_mode::Bytes>,
) -> IpcResult<()> {
    let config = &state.config;
    let stats = &state.stats;
    let handler = &state.handler;
    let watch_state = &state.watch_state;

    // Increment connection count
    {
        let mut stats_guard = stats.lock().await;
        stats_guard.connection_count += 1;
        stats_guard.active_connections += 1;
        handler.on_connect();
    }

    debug!("New connection established");

    let read_timeout = Duration::from_millis(config.read_timeout_ms);
    let write_timeout = Duration::from_millis(config.write_timeout_ms);

    let mut read_buffer = vec![0u8; config.max_message_size];
    let mut total_read = 0usize;

    while !state.is_shutting_down() {
        let bytes_read = match tokio::time::timeout(
            read_timeout,
            stream.read(&mut read_buffer[total_read..]),
        )
        .await
        {
            Ok(Ok(0)) => {
                debug!("Connection closed by client");
                break;
            }
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                if e.kind() == std::io::ErrorKind::ConnectionReset
                    || e.kind() == std::io::ErrorKind::BrokenPipe
                {
                    debug!("Connection closed by client");
                } else {
                    warn!("Read error: {}", e);
                }
                break;
            }
            Err(_) => {
                warn!("Read timeout");
                break;
            }
        };

        total_read += bytes_read;

        while let Some(pos) = memchr::memchr(b'\n', &read_buffer[..total_read]) {
            let frame = &read_buffer[..=pos];

            match deserialize_ndjson::<Request>(frame) {
                Ok(request) => {
                    let response = process_request(
                        handler,
                        &state.stats,
                        watch_state,
                        request,
                    )
                    .await;

                    match response {
                        Ok(response_bytes) => {
                            if let Err(e) = tokio::time::timeout(
                                write_timeout,
                                stream.write_all(&response_bytes),
                            )
                            .await
                            {
                                warn!("Failed to write response: {}", e);
                                break;
                            }

                            if let Err(e) = stream.flush().await {
                                warn!("Failed to flush stream: {}", e);
                                break;
                            }
                        }
                        Err(e) => {
                            error!("Error processing request: {}", e);

                            let error_resp = Response::error(
                                0,
                                e.to_error_response(),
                            );

                            if let Ok(response_str) = serialize_ndjson(&error_resp) {
                                let _ = stream.write_all(response_str.as_bytes()).await;
                                let _ = stream.flush().await;
                            }

                            if e.is_access_denied() || e.is_connection_error() {
                                break;
                            }
                        }
                    }

                    {
                        let mut stats_guard = stats.lock().await;
                        stats_guard.request_count += 1;
                    }
                }
                Err(e) => {
                    warn!("Failed to parse request: {}", e);

                    let error_resp = Response::error(
                        0,
                        ErrorResponse::new(
                            ErrorCode::InvalidRequest,
                            format!("Failed to parse request: {}", e),
                        ),
                    );

                    if let Ok(response_str) = serialize_ndjson(&error_resp) {
                        let _ = stream.write_all(response_str.as_bytes()).await;
                        let _ = stream.flush().await;
                    }

                    {
                        let mut stats_guard = stats.lock().await;
                        stats_guard.error_count += 1;
                    }
                }
            }

            let remaining = total_read - (pos + 1);
            if remaining > 0 {
                read_buffer.copy_within((pos + 1)..total_read, 0);
            }
            total_read = remaining;
        }

        if total_read >= config.max_message_size {
            warn!("Message too large without newline delimiter");
            break;
        }
    }

    {
        let mut stats_guard = stats.lock().await;
        if stats_guard.active_connections > 0 {
            stats_guard.active_connections -= 1;
        }
        handler.on_disconnect();
    }

    Ok(())
}

/// Process a single request
async fn process_request(
    handler: &Arc<dyn RequestHandler>,
    stats: &Mutex<ServerStats>,
    watch_state: &Arc<WatchState>,
    request: Request,
) -> IpcResult<Vec<u8>> {
    use crate::protocol::WatchResponse;

    trace!("Processing request: id={}, method={}", request.id, request.method);

    let result = match request.method {
        Method::Ping => {
            let result = handler.handle_ping(request.id).await?;
            Ok(Response::success(request.id, result))
        }
        Method::Stats => {
            let result = handler.handle_stats(request.id).await?;
            Ok(Response::success(request.id, result))
        }
        Method::Search => {
            match request.params {
                MethodParams::Search(params) => {
                    let result = handler.handle_search(request.id, params).await?;
                    Ok(Response::success(request.id, result))
                }
                _ => Err(IpcError::protocol(
                    ErrorCode::InvalidParams,
                    "Expected SearchParams for search method",
                )),
            }
        }
        Method::Resolve => {
            match request.params {
                MethodParams::Resolve(params) => {
                    let result = handler.handle_resolve(request.id, params.row).await?;
                    Ok(Response::success(request.id, result))
                }
                _ => Err(IpcError::protocol(
                    ErrorCode::InvalidParams,
                    "Expected ResolveParams for resolve method",
                )),
            }
        }
        Method::Watch => {
            match request.params {
                MethodParams::Watch(params) => {
                    if params.subscribe {
                        let (_sub_id, _rx) = watch_state.subscribe();

                        let response = WatchResponse {
                            subscribed: true,
                            volume: params.volume,
                        };
                        Ok(Response::success(request.id, ResultResponse::Watch(response)))
                    } else {
                        watch_state.unsubscribe(request.id);
                        let response = WatchResponse {
                            subscribed: false,
                            volume: None,
                        };
                        Ok(Response::success(request.id, ResultResponse::Watch(response)))
                    }
                }
                _ => Err(IpcError::protocol(
                    ErrorCode::InvalidParams,
                    "Expected WatchParams for watch method",
                )),
            }
        }
    };

    match result {
        Ok(response) => {
            serialize_ndjson(&response)
                .map(|s| s.into_bytes())
                .map_err(|e| {
                    error!("Failed to serialize response: {}", e);
                    IpcError::Json(e)
                })
        }
        Err(e) => {
            error!("Request handler error: {}", e);
            handler.on_error(&e);

            {
                let mut stats_guard = stats.lock().await;
                stats_guard.error_count += 1;
            }

            let error_response = Response::error(request.id, e.to_error_response());
            serialize_ndjson(&error_response)
                .map(|s| s.into_bytes())
                .map_err(IpcError::Json)
        }
    }
}

/// Security utilities for Windows ACL
pub mod security {
    use super::*;

    /// Well-known SIDs for Windows
    pub mod sids {
        // SYSTEM SID: S-1-5-18
        pub const SYSTEM: [u8; 12] = [
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x12, 0x00, 0x00, 0x00,
        ];

        // Local Administrators SID: S-1-5-32-544
        pub const ADMINISTRATORS: [u8; 20] = [
            0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x20, 0x00, 0x00, 0x00,
            0x32, 0x00, 0x02, 0x00, 0x00, 0x01, 0x02, 0x00,
        ];
    }

    /// SDDL string restricting access to:
    /// - SYSTEM (SY)
    /// - Built-in Administrators (BA)
    /// - Authenticated Users (AU) — required: MCP clients (IDE extensions)
    ///   run with a UAC-filtered token and are NOT effectively in BA, so a
    ///   BA-only DACL denies every real client. The fs_* write tools remain
    ///   protected by the daemon-side allowed_roots policy.
    /// - Current Owner Rights (OW)
    /// - Creator Owner (CO)
    /// Protected DACL (P) prevents inheritance.
    pub const RESTRICTIVE_SDDL: &str =
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)(A;;GA;;;OW)(A;;GA;;;CO)";

    /// Create a restrictive SecurityDescriptor using SDDL
    pub fn create_restrictive_security_descriptor() -> IpcResult<SecurityDescriptor> {
        let sddl_cstr = U16CString::from_str(RESTRICTIVE_SDDL)
            .map_err(|e| IpcError::AclError(format!("Invalid SDDL string: {}", e)))?;
        SecurityDescriptor::deserialize(&sddl_cstr)
            .map_err(|e| IpcError::AclError(format!("Failed to deserialize SDDL: {}", e)))
    }
}

/// Named Pipe Server
pub struct NamedPipeServer {
    state: Arc<ServerState>,
    listener: Option<PipeListener<pipe_mode::Bytes, pipe_mode::Bytes>>,
    connection_tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl std::fmt::Debug for NamedPipeServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamedPipeServer")
            .field("state", &self.state)
            .finish()
    }
}

impl NamedPipeServer {
    /// Create a new named pipe server with default configuration
    pub fn new(handler: impl RequestHandler + 'static) -> Self {
        Self::with_config(ServerConfig::default(), handler)
    }

    /// Create a new named pipe server with custom configuration
    pub fn with_config(config: ServerConfig, handler: impl RequestHandler + 'static) -> Self {
        let state = ServerState::new(config, handler);

        Self {
            state: Arc::new(state),
            listener: None,
            connection_tasks: Mutex::new(Vec::new()),
        }
    }

    /// Start the server
    pub async fn start(&mut self) -> IpcResult<()> {
        let config = &self.state.config;
        let pipe_name = config.full_pipe_name();

        info!("Starting named pipe server on {}", pipe_name);

        let mut options = PipeListenerOptions::new()
            .path(Path::new(&pipe_name))
            .mode(PipeMode::Bytes);

        // Apply restrictive ACL if configured
        if config.apply_restrictive_acl {
            let sd = security::create_restrictive_security_descriptor()?;
            options = options.security_descriptor(Some(sd));
            debug!("Applied restrictive DACL (Owner + SYSTEM + Administrators + Authenticated Users)");
        }

        let listener = options
            .create_tokio_duplex::<pipe_mode::Bytes>()
            .map_err(|e| IpcError::CreationError(format!("Failed to create pipe listener: {}", e)))?;

        self.listener = Some(listener);

        // Update stats
        {
            let mut stats = self.state.stats.lock().await;
            stats.started_at = Instant::now();
        }

        info!("Named pipe server started on {}", pipe_name);
        Ok(())
    }

    /// Accept and handle incoming connections
    pub async fn run(&self) -> IpcResult<()> {
        let listener = self
            .listener
            .as_ref()
            .ok_or_else(|| IpcError::Generic("Server not started".to_string()))?;

        info!("Named pipe server running, accepting connections...");

        let mut shutdown_rx = self.state.shutdown_signal.subscribe();

        loop {
            if self.state.is_shutting_down() {
                info!("Server shutting down");
                break;
            }

            tokio::select! {
                accept_res = listener.accept() => {
                    match accept_res {
                        Ok(stream) => {
                            let state = self.state.clone();
                            let task = tokio::spawn(async move {
                                if let Err(e) = handle_connection(state, stream).await {
                                    debug!("Connection finished: {}", e);
                                }
                            });
                            self.connection_tasks.lock().await.push(task);
                        }
                        Err(e) => {
                            if self.state.is_shutting_down() {
                                break;
                            }
                            warn!("Failed to accept connection: {}", e);
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }
                }
                _ = shutdown_rx.changed() => {
                    info!("Server shutdown signaled");
                    break;
                }
            }
        }

        info!("Waiting for active connections to close...");
        let mut tasks = self.connection_tasks.lock().await;
        for task in tasks.drain(..) {
            let _ = task.await;
        }

        Ok(())
    }

    /// Stop the server
    pub async fn stop(&mut self) -> IpcResult<()> {
        info!("Stopping named pipe server...");

        self.state.signal_shutdown();
        self.listener = None;

        Ok(())
    }

    /// Get the server state
    pub fn state(&self) -> &Arc<ServerState> {
        &self.state
    }

    /// Get current statistics
    pub async fn stats(&self) -> ServerStats {
        self.state.stats.lock().await.clone()
    }
}

impl Drop for NamedPipeServer {
    fn drop(&mut self) {
        // Signal shutdown on drop
        self.state.signal_shutdown();
    }
}

/// Builder for NamedPipeServer
#[derive(Debug, Default)]
pub struct NamedPipeServerBuilder {
    config: ServerConfig,
}

impl NamedPipeServerBuilder {
    pub fn new() -> Self {
        Self {
            config: ServerConfig::default(),
        }
    }

    pub fn pipe_name(mut self, name: impl Into<String>) -> Self {
        self.config.pipe_name = name.into();
        self
    }

    pub fn max_connections(mut self, max: usize) -> Self {
        self.config.max_connections = max;
        self
    }

    pub fn connection_timeout_ms(mut self, timeout: u64) -> Self {
        self.config.connection_timeout_ms = timeout;
        self
    }

    pub fn read_timeout_ms(mut self, timeout: u64) -> Self {
        self.config.read_timeout_ms = timeout;
        self
    }

    pub fn write_timeout_ms(mut self, timeout: u64) -> Self {
        self.config.write_timeout_ms = timeout;
        self
    }

    pub fn max_message_size(mut self, size: usize) -> Self {
        self.config.max_message_size = size;
        self
    }

    pub fn apply_restrictive_acl(mut self, apply: bool) -> Self {
        self.config.apply_restrictive_acl = apply;
        self
    }

    pub fn build<H: RequestHandler + 'static>(self, handler: H) -> NamedPipeServer {
        NamedPipeServer::with_config(self.config, handler)
    }
}
