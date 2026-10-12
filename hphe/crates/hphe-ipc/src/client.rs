//! Client for hphe-ipc named pipe communication
//!
//! Provides a high-level client API for connecting to the hphe-indexd daemon
//! and making NDJSON protocol requests.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use interprocess::os::windows::named_pipe::{pipe_mode, tokio::DuplexPipeStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::error::{IpcError, IpcResult};
use crate::protocol::{
    deserialize_ndjson, Method, MethodParams, Request,
    RequestId, Response, ResultResponse, SearchParams, SearchResponse, serialize_ndjson,
    WatchParams,
};

/// Default pipe name
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\hphe-index";

/// Default connection timeout
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 5000;

/// Default request timeout
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30000;

/// Client configuration
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Pipe name to connect to
    pub pipe_name: String,
    /// Connection timeout in milliseconds
    pub connect_timeout_ms: u64,
    /// Request timeout in milliseconds
    pub request_timeout_ms: u64,
    /// Maximum retry attempts
    pub max_retries: usize,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            pipe_name: DEFAULT_PIPE_NAME.to_string(),
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            max_retries: 3,
        }
    }
}

impl ClientConfig {
    /// Create a new client configuration
    pub fn new(pipe_name: impl Into<String>) -> Self {
        Self {
            pipe_name: pipe_name.into(),
            ..Default::default()
        }
    }

    /// Get the full pipe name
    pub fn full_pipe_name(&self) -> String {
        if self.pipe_name.starts_with(r"\\.\pipe\") {
            self.pipe_name.clone()
        } else {
            format!(r"\\.\pipe\{}", self.pipe_name)
        }
    }
}

/// Client connection state
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    /// Not connected
    Disconnected,
    /// Connected and ready
    Connected,
    /// Connection in progress
    Connecting,
    /// Connection closed
    Closed,
}

/// Named pipe client
#[derive(Debug)]
pub struct IpcClient {
    config: ClientConfig,
    stream: Option<DuplexPipeStream<pipe_mode::Bytes>>,
    state: ConnectionState,
    next_request_id: std::sync::atomic::AtomicU64,
    read_buffer: Vec<u8>,
}

impl IpcClient {
    /// Create a new client with default configuration
    pub fn new() -> Self {
        Self::with_config(ClientConfig::default())
    }

    /// Create a new client with custom configuration
    pub fn with_config(config: ClientConfig) -> Self {
        Self {
            config,
            stream: None,
            state: ConnectionState::Disconnected,
            next_request_id: std::sync::atomic::AtomicU64::new(1),
            read_buffer: vec![0u8; 4096],
        }
    }

    /// Get the next request ID
    pub fn next_request_id(&self) -> RequestId {
        self.next_request_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    /// Connect to the server
    pub async fn connect(&mut self) -> IpcResult<()> {
        if self.state == ConnectionState::Connected {
            return Ok(());
        }

        self.state = ConnectionState::Connecting;

        let pipe_name = self.config.full_pipe_name();
        let connect_timeout = Duration::from_millis(self.config.connect_timeout_ms);

        let mut last_err = None;
        for attempt in 0..self.config.max_retries {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(100 * attempt as u64)).await;
            }

            let connect_fut = DuplexPipeStream::<pipe_mode::Bytes>::connect_by_path(Path::new(&pipe_name));
            match tokio::time::timeout(connect_timeout, connect_fut).await {
                Ok(Ok(stream)) => {
                    self.stream = Some(stream);
                    self.state = ConnectionState::Connected;
                    return Ok(());
                }
                Ok(Err(e)) => {
                    let ipc_err = if e.kind() == std::io::ErrorKind::PermissionDenied {
                        IpcError::AccessDenied
                    } else {
                        IpcError::Io(e)
                    };
                    if ipc_err.is_access_denied() {
                        self.state = ConnectionState::Closed;
                        return Err(IpcError::AccessDenied);
                    }
                    last_err = Some(ipc_err);
                }
                Err(_) => {
                    last_err = Some(IpcError::Timeout(self.config.connect_timeout_ms));
                }
            }
        }

        self.state = ConnectionState::Disconnected;
        Err(last_err.unwrap_or_else(|| {
            IpcError::ConnectionError(format!(
                "Failed to connect to {} after {} attempts",
                pipe_name, self.config.max_retries
            ))
        }))
    }

    /// Disconnect from the server
    pub async fn disconnect(&mut self) -> IpcResult<()> {
        self.stream = None;
        self.state = ConnectionState::Disconnected;
        Ok(())
    }

    /// Check if connected
    pub fn is_connected(&self) -> bool {
        matches!(self.state, ConnectionState::Connected)
    }

    /// Get current connection state
    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    /// Ensure connection is active
    async fn ensure_connected(&mut self) -> IpcResult<()> {
        if !self.is_connected() {
            self.connect().await?;
        }
        Ok(())
    }

    /// Send a raw request and receive response
    pub async fn send_request(&mut self, request: &Request) -> IpcResult<Response> {
        self.ensure_connected().await?;

        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| IpcError::ConnectionError("Not connected".to_string()))?;

        let request_timeout = Duration::from_millis(self.config.request_timeout_ms);

        // Serialize and send the request
        let request_bytes = serialize_ndjson(request)?;
        
        // Use tokio::io traits
        tokio::time::timeout(
            request_timeout,
            stream.write_all(request_bytes.as_bytes()),
        )
        .await
        .map_err(|_| IpcError::Timeout(self.config.request_timeout_ms))?
        .map_err(IpcError::Io)?;

        // Flush
        stream.flush().await.map_err(IpcError::Io)?;

        // Read the response
        let mut response_buffer = Vec::with_capacity(4096);
        let mut total_read = 0usize;

        loop {
            let bytes_read = tokio::time::timeout(
                request_timeout,
                stream.read(&mut self.read_buffer),
            )
            .await
            .map_err(|_| IpcError::Timeout(self.config.request_timeout_ms))?
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::ConnectionReset
                    || e.kind() == std::io::ErrorKind::BrokenPipe
                {
                    IpcError::ConnectionClosed
                } else {
                    IpcError::Io(e)
                }
            })?;

            if bytes_read == 0 {
                // Connection closed
                self.state = ConnectionState::Closed;
                return Err(IpcError::ConnectionClosed);
            }

            // Append to response buffer
            response_buffer.extend_from_slice(&self.read_buffer[..bytes_read]);
            total_read += bytes_read;

            // Check if we have a complete frame (ends with newline)
            if let Some(pos) = memchr::memchr(b'\n', &response_buffer) {
                // Parse the response
                let response_str = &response_buffer[..=pos];
                match deserialize_ndjson::<Response>(response_str) {
                    Ok(response) => {
                        // Check if this is the response we're waiting for
                        if response.id == request.id {
                            return Ok(response);
                        }
                        return Err(IpcError::InvalidFrame(
                            format!(
                                "Received unexpected response ID: expected {}, got {}",
                                request.id, response.id
                            ),
                        ));
                    }
                    Err(e) => {
                        return Err(IpcError::Json(e));
                    }
                }
            }

            // Prevent infinite loop on incomplete frames
            if total_read >= 16 * 1024 * 1024 {
                return Err(IpcError::InvalidFrame(
                    "Response too large or incomplete".to_string(),
                ));
            }
        }
    }

    /// Make a request with the given method and parameters
    pub async fn call(&mut self, method: Method, params: MethodParams) -> IpcResult<Response> {
        let request = Request {
            id: self.next_request_id(),
            method,
            params,
        };
        self.send_request(&request).await
    }

    /// Ping the server
    pub async fn ping(&mut self) -> IpcResult<crate::protocol::PingResponse> {
        let response = self.call(Method::Ping, MethodParams::Ping(crate::protocol::PingParams)).await?;
        
        match response.result {
            Some(ResultResponse::Ping(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for ping".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Ping response has no result or error".into()))
                }
            }
        }
    }

    /// Get index statistics
    pub async fn stats(&mut self) -> IpcResult<crate::protocol::IndexStats> {
        let response = self.call(Method::Stats, MethodParams::Stats(crate::protocol::StatsParams)).await?;
        
        match response.result {
            Some(ResultResponse::Stats(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for stats".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Stats response has no result or error".into()))
                }
            }
        }
    }

    /// Search the index
    pub async fn search(
        &mut self,
        query: impl Into<String>,
        limit: usize,
        offset: usize,
    ) -> IpcResult<SearchResponse> {
        let params = MethodParams::Search(SearchParams {
            query: query.into(),
            limit,
            offset,
            include_deleted: false,
        });

        let response = self.call(Method::Search, params).await?;
        
        match response.result {
            Some(ResultResponse::Search(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for search".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Search response has no result or error".into()))
                }
            }
        }
    }

    /// Resolve a row to its full path
    pub async fn resolve(&mut self, row: usize) -> IpcResult<crate::protocol::ResolveResponse> {
        let params = MethodParams::Resolve(crate::protocol::ResolveParams { row });
        let response = self.call(Method::Resolve, params).await?;
        
        match response.result {
            Some(ResultResponse::Resolve(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for resolve".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Resolve response has no result or error".into()))
                }
            }
        }
    }

    /// Subscribe to USN events
    pub async fn subscribe(&mut self, volume: Option<char>) -> IpcResult<crate::protocol::WatchResponse> {
        let params = MethodParams::Watch(WatchParams {
            subscribe: true,
            volume,
        });
        let response = self.call(Method::Watch, params).await?;
        
        match response.result {
            Some(ResultResponse::Watch(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for watch subscribe".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Watch subscribe response has no result or error".into()))
                }
            }
        }
    }

    /// Unsubscribe from USN events
    pub async fn unsubscribe(&mut self) -> IpcResult<crate::protocol::WatchResponse> {
        let params = MethodParams::Watch(WatchParams {
            subscribe: false,
            volume: None,
        });
        let response = self.call(Method::Watch, params).await?;
        
        match response.result {
            Some(ResultResponse::Watch(resp)) => Ok(resp),
            Some(_) => Err(IpcError::InvalidFrame("Unexpected response type for watch unsubscribe".into())),
            None => {
                if let Some(ref err) = response.error {
                    Err(IpcError::protocol(err.code.clone(), err.message.clone()))
                } else {
                    Err(IpcError::InvalidFrame("Watch unsubscribe response has no result or error".into()))
                }
            }
        }
    }
}

/// High-level client wrapper with automatic reconnection
#[derive(Debug, Clone)]
pub struct Client {
    inner: Arc<Mutex<IpcClient>>,
    config: ClientConfig,
}

impl Client {
    /// Create a new client with default configuration
    pub fn new() -> Self {
        Self::with_config(ClientConfig::default())
    }

    /// Create a new client with custom configuration
    pub fn with_config(config: ClientConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(IpcClient::with_config(config.clone()))),
            config,
        }
    }

    /// Get client configuration
    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    /// Connect to the server
    pub async fn connect(&self) -> IpcResult<()> {
        let mut client = self.inner.lock().await;
        client.connect().await
    }

    /// Disconnect from the server
    pub async fn disconnect(&self) -> IpcResult<()> {
        let mut client = self.inner.lock().await;
        client.disconnect().await
    }

    /// Check if connected
    pub async fn is_connected(&self) -> bool {
        let client = self.inner.lock().await;
        client.is_connected()
    }

    /// Ping the server
    pub async fn ping(&self) -> IpcResult<crate::protocol::PingResponse> {
        let mut client = self.inner.lock().await;
        client.ping().await
    }

    /// Get index statistics
    pub async fn stats(&self) -> IpcResult<crate::protocol::IndexStats> {
        let mut client = self.inner.lock().await;
        client.stats().await
    }

    /// Search the index
    pub async fn search(
        &self,
        query: impl Into<String>,
        limit: usize,
        offset: usize,
    ) -> IpcResult<SearchResponse> {
        let mut client = self.inner.lock().await;
        client.search(query, limit, offset).await
    }

    /// Resolve a row to its full path
    pub async fn resolve(&self, row: usize) -> IpcResult<crate::protocol::ResolveResponse> {
        let mut client = self.inner.lock().await;
        client.resolve(row).await
    }

    /// Subscribe to USN events
    pub async fn subscribe(&self, volume: Option<char>) -> IpcResult<crate::protocol::WatchResponse> {
        let mut client = self.inner.lock().await;
        client.subscribe(volume).await
    }

    /// Unsubscribe from USN events
    pub async fn unsubscribe(&self) -> IpcResult<crate::protocol::WatchResponse> {
        let mut client = self.inner.lock().await;
        client.unsubscribe().await
    }

    /// Make a raw request
    pub async fn call(&self, method: Method, params: MethodParams) -> IpcResult<Response> {
        let mut client = self.inner.lock().await;
        client.call(method, params).await
    }
}

/// Builder for Client
#[derive(Debug, Default)]
pub struct ClientBuilder {
    config: ClientConfig,
}

impl ClientBuilder {
    pub fn new() -> Self {
        Self {
            config: ClientConfig::default(),
        }
    }

    pub fn pipe_name(mut self, name: impl Into<String>) -> Self {
        self.config.pipe_name = name.into();
        self
    }

    pub fn connect_timeout_ms(mut self, timeout: u64) -> Self {
        self.config.connect_timeout_ms = timeout;
        self
    }

    pub fn request_timeout_ms(mut self, timeout: u64) -> Self {
        self.config.request_timeout_ms = timeout;
        self
    }

    pub fn max_retries(mut self, retries: usize) -> Self {
        self.config.max_retries = retries;
        self
    }

    pub fn build(self) -> Client {
        Client::with_config(self.config)
    }
}
