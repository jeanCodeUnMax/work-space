//! NDJSON Protocol for hphe-ipc
//!
//! Implements a Newline-Delimited JSON protocol for communication between
//! the elevated hphe-indexd daemon and non-elevated clients.
//!
//! Each request and response is a single JSON object followed by a newline.
//! This provides a simple, debuggable, line-framed protocol.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Unique request identifier (correlates request with response)
pub type RequestId = u64;

/// Method names supported by the protocol
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// Health check - returns server status
    Ping,
    /// Get index statistics
    Stats,
    /// Search the index with query parameters
    Search,
    /// Resolve a row to its full path
    Resolve,
    /// Subscribe to watch for USN change events (streaming)
    Watch,
}

impl fmt::Display for Method {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Method::Ping => write!(f, "ping"),
            Method::Stats => write!(f, "stats"),
            Method::Search => write!(f, "search"),
            Method::Resolve => write!(f, "resolve"),
            Method::Watch => write!(f, "watch"),
        }
    }
}

impl std::str::FromStr for Method {
    type Err = String;
    
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "ping" => Ok(Method::Ping),
            "stats" => Ok(Method::Stats),
            "search" => Ok(Method::Search),
            "resolve" => Ok(Method::Resolve),
            "watch" => Ok(Method::Watch),
            _ => Err(format!("Unknown method: {}", s)),
        }
    }
}

/// Parameters for the Search method
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchParams {
    /// The search query string
    pub query: String,
    /// Maximum number of results to return
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Offset for pagination
    #[serde(default)]
    pub offset: usize,
    /// Whether to include deleted entries
    #[serde(default)]
    pub include_deleted: bool,
}

fn default_limit() -> usize {
    100
}

/// Parameters for the Resolve method
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolveParams {
    /// The row index to resolve
    pub row: usize,
}

/// Parameters for the Watch method
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchParams {
    /// Subscribe to events (true) or unsubscribe (false)
    #[serde(default)]
    pub subscribe: bool,
    /// Optional filter for specific volume
    #[serde(default)]
    pub volume: Option<char>,
}

/// Parameters for the Ping method (empty struct)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PingParams;

/// Parameters for the Stats method (empty struct)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatsParams;

/// Union type for all method parameters
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MethodParams {
    Ping(PingParams),
    Stats(StatsParams),
    Search(SearchParams),
    Resolve(ResolveParams),
    Watch(WatchParams),
}

/// A request message
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// Unique request identifier
    pub id: RequestId,
    /// The method to call
    pub method: Method,
    /// Method-specific parameters
    #[serde(flatten)]
    pub params: MethodParams,
}

impl Request {
    /// Create a new request
    pub fn new(id: RequestId, method: Method, params: MethodParams) -> Self {
        Self { id, method, params }
    }
    
    /// Create a ping request
    pub fn ping(id: RequestId) -> Self {
        Self::new(id, Method::Ping, MethodParams::Ping(PingParams))
    }
    
    /// Create a stats request
    pub fn stats(id: RequestId) -> Self {
        Self::new(id, Method::Stats, MethodParams::Stats(StatsParams))
    }
    
    /// Create a search request
    pub fn search(id: RequestId, query: impl Into<String>, limit: usize, offset: usize) -> Self {
        Self::new(
            id,
            Method::Search,
            MethodParams::Search(SearchParams {
                query: query.into(),
                limit,
                offset,
                include_deleted: false,
            }),
        )
    }
    
    /// Create a resolve request
    pub fn resolve(id: RequestId, row: usize) -> Self {
        Self::new(id, Method::Resolve, MethodParams::Resolve(ResolveParams { row }))
    }
    
    /// Create a watch subscribe request
    pub fn watch_subscribe(id: RequestId, volume: Option<char>) -> Self {
        Self::new(
            id,
            Method::Watch,
            MethodParams::Watch(WatchParams {
                subscribe: true,
                volume,
            }),
        )
    }
    
    /// Create a watch unsubscribe request
    pub fn watch_unsubscribe(id: RequestId) -> Self {
        Self::new(
            id,
            Method::Watch,
            MethodParams::Watch(WatchParams {
                subscribe: false,
                volume: None,
            }),
        )
    }
}

/// Error codes for the protocol
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Invalid request format
    InvalidRequest,
    /// Method not found or not implemented
    MethodNotFound,
    /// Invalid parameters for the method
    InvalidParams,
    /// Internal server error
    InternalError,
    /// Access denied (ACL rejection)
    AccessDenied,
    /// Pipe connection failed
    ConnectionFailed,
    /// Timeout occurred
    Timeout,
    /// Row not found
    NotFound,
    /// Already subscribed
    AlreadySubscribed,
    /// Not subscribed
    NotSubscribed,
    /// Volume not found
    VolumeNotFound,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorCode::InvalidRequest => write!(f, "INVALID_REQUEST"),
            ErrorCode::MethodNotFound => write!(f, "METHOD_NOT_FOUND"),
            ErrorCode::InvalidParams => write!(f, "INVALID_PARAMS"),
            ErrorCode::InternalError => write!(f, "INTERNAL_ERROR"),
            ErrorCode::AccessDenied => write!(f, "ACCESS_DENIED"),
            ErrorCode::ConnectionFailed => write!(f, "CONNECTION_FAILED"),
            ErrorCode::Timeout => write!(f, "TIMEOUT"),
            ErrorCode::NotFound => write!(f, "NOT_FOUND"),
            ErrorCode::AlreadySubscribed => write!(f, "ALREADY_SUBSCRIBED"),
            ErrorCode::NotSubscribed => write!(f, "NOT_SUBSCRIBED"),
            ErrorCode::VolumeNotFound => write!(f, "VOLUME_NOT_FOUND"),
        }
    }
}

/// Error response data
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorResponse {
    /// Error code
    pub code: ErrorCode,
    /// Human-readable error message
    pub message: String,
    /// Optional additional context
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<HashMap<String, String>>,
}

impl ErrorResponse {
    /// Create a new error response
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            context: None,
        }
    }
    
    /// Add context to the error
    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.get_or_insert_with(HashMap::new)
            .insert(key.into(), value.into());
        self
    }
}

/// A single file entry result for search
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    /// Row index in the index
    pub row: usize,
    /// File Reference Number (FRN)
    pub frn: u64,
    /// Parent FRN
    pub parent_frn: u64,
    /// Filename (original case)
    pub name: String,
    /// Full resolved path
    pub path: String,
    /// File size in bytes
    pub size: u64,
    /// Whether this is a directory
    pub is_dir: bool,
    /// Creation timestamp (FILETIME)
    pub created: u64,
    /// Last modification timestamp (FILETIME)
    pub modified: u64,
    /// Last access timestamp (FILETIME)
    pub accessed: u64,
    /// File attributes
    pub attributes: u32,
}

/// Statistics about the index
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexStats {
    /// Total number of entries
    pub total_entries: usize,
    /// Number of files
    pub file_count: usize,
    /// Number of directories
    pub dir_count: usize,
    /// Total size of all files in bytes
    pub total_size: u64,
    /// Memory usage in bytes
    pub memory_usage_bytes: usize,
    /// Build time in milliseconds
    pub build_time_ms: u64,
    /// Average name length
    pub avg_name_length: f64,
    /// Per-volume statistics (volume letter -> stats)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volumes: Option<HashMap<char, VolumeStats>>,
}

/// Statistics for a single volume
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VolumeStats {
    pub entry_count: usize,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub last_usn: u64,
    pub journal_id: u64,
    pub is_building: bool,
    pub last_error: Option<String>,
}

/// USN Journal event for watch streaming
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsnEvent {
    /// Volume letter
    pub volume: char,
    /// File Reference Number
    pub frn: u64,
    /// Parent FRN
    pub parent_frn: u64,
    /// Event reason (USN reason flags)
    pub reason: u32,
    /// Filename
    pub name: String,
    /// Full path
    pub path: String,
    /// Whether it's a directory
    pub is_dir: bool,
    /// New size (for create/overwrite)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// New timestamps (for create/modify)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
}

/// Result types for successful responses
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResultResponse {
    /// Ping response with server info
    Ping(PingResponse),
    /// Stats response with index statistics
    Stats(IndexStats),
    /// Search response with matching entries
    Search(SearchResponse),
    /// Resolve response with full path
    Resolve(ResolveResponse),
    /// Watch response with subscription status
    Watch(WatchResponse),
    /// Stream of USN events (only used in streaming mode)
    Stream(UsnEvent),
}

/// Response to a ping request
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PingResponse {
    /// Server version
    pub version: String,
    /// Server uptime in milliseconds
    pub uptime_ms: u64,
    /// Current timestamp
    pub timestamp: u64,
}

/// Response to a search request
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResponse {
    /// Total number of matching entries
    pub total: usize,
    /// Returned entries
    pub entries: Vec<FileEntry>,
    /// Whether more results are available (for pagination)
    pub has_more: bool,
    /// Offset used
    pub offset: usize,
    /// Limit used
    pub limit: usize,
}

/// Response to a resolve request
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolveResponse {
    /// The full resolved path
    pub path: String,
    /// The row that was resolved
    pub row: usize,
    /// The FRN of the entry
    pub frn: u64,
}

/// Response to a watch request
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchResponse {
    /// Whether subscription is now active
    pub subscribed: bool,
    /// Volume being watched (if specified)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<char>,
}

/// A response message
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    /// Request ID this response corresponds to
    pub id: RequestId,
    /// Result if successful
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ResultResponse>,
    /// Error if the request failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorResponse>,
}

impl Response {
    /// Create a successful response
    pub fn success(id: RequestId, result: ResultResponse) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }
    
    /// Create an error response
    pub fn error(id: RequestId, error: ErrorResponse) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
    
    /// Check if this is a successful response
    pub fn is_success(&self) -> bool {
        self.error.is_none()
    }
    
    /// Check if this is an error response
    pub fn is_error(&self) -> bool {
        self.error.is_some()
    }
    
    /// Get the error code if this is an error response
    pub fn error_code(&self) -> Option<&ErrorCode> {
        self.error.as_ref().and_then(|e| Some(&e.code))
    }
}

/// Serialize a message (request or response) to NDJSON format
pub fn serialize_ndjson<T: Serialize>(message: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(message).map(|s| s + "\n")
}

/// Deserialize a message from NDJSON format
pub fn deserialize_ndjson<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    // Trim trailing newline if present
    let trimmed = if bytes.ends_with(b"\n") {
        &bytes[..bytes.len() - 1]
    } else {
        bytes
    };
    serde_json::from_slice(trimmed)
}

/// Parse a line-framed message from a byte stream
/// Returns (message, bytes_consumed) or error
pub fn parse_line_frame<T: for<'de> Deserialize<'de>>(
    buffer: &[u8],
) -> Result<Option<(T, usize)>, serde_json::Error> {
    if buffer.is_empty() {
        return Ok(None);
    }
    
    // Find the first newline
    let newline_pos = match memchr::memchr(b'\n', buffer) {
        Some(pos) => pos,
        None => return Ok(None), // Incomplete frame
    };
    
    // Try to parse the line (excluding the newline)
    let line = &buffer[..newline_pos];
    let message: T = deserialize_ndjson(line)?;
    
    // Return the message and total bytes consumed (including newline)
    Ok(Some((message, newline_pos + 1)))
}

/// Check if a buffer contains a complete line-framed message
pub fn has_complete_frame(buffer: &[u8]) -> bool {
    memchr::memchr(b'\n', buffer).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_deserialize_request() {
        let request = Request::ping(1);
        let serialized = serialize_ndjson(&request).unwrap();
        assert!(serialized.ends_with('\n'));
        
        let deserialized: Request = deserialize_ndjson(serialized.as_bytes()).unwrap();
        assert_eq!(deserialized.id, 1);
        assert_eq!(deserialized.method, Method::Ping);
    }

    #[test]
    fn test_serialize_deserialize_response() {
        let response = Response::success(
            1,
            ResultResponse::Ping(PingResponse {
                version: "1.0.0".to_string(),
                uptime_ms: 1000,
                timestamp: 1234567890,
            }),
        );
        let serialized = serialize_ndjson(&response).unwrap();
        assert!(serialized.ends_with('\n'));
        
        let deserialized: Response = deserialize_ndjson(serialized.as_bytes()).unwrap();
        assert_eq!(deserialized.id, 1);
        assert!(deserialized.is_success());
    }

    #[test]
    fn test_error_response() {
        let response = Response::error(
            1,
            ErrorResponse::new(ErrorCode::NotFound, "Row 123 not found"),
        );
        let serialized = serialize_ndjson(&response).unwrap();
        let deserialized: Response = deserialize_ndjson(serialized.as_bytes()).unwrap();
        assert!(deserialized.is_error());
        assert_eq!(deserialized.error_code(), Some(&ErrorCode::NotFound));
    }

    #[test]
    fn test_search_request() {
        let request = Request::search(42, "test query", 100, 0);
        let serialized = serialize_ndjson(&request).unwrap();
        let deserialized: Request = deserialize_ndjson(serialized.as_bytes()).unwrap();
        
        assert_eq!(deserialized.id, 42);
        assert_eq!(deserialized.method, Method::Search);
        
        match deserialized.params {
            MethodParams::Search(ref params) => {
                assert_eq!(params.query, "test query");
                assert_eq!(params.limit, 100);
                assert_eq!(params.offset, 0);
            }
            _ => panic!("Expected Search params"),
        }
    }

    #[test]
    fn test_parse_line_frame() {
        let frame1 = serialize_ndjson(&Request::ping(1)).unwrap();
        let frame2 = serialize_ndjson(&Request::stats(2)).unwrap();
        let combined = format!("{}{}", frame1, frame2);
        
        let buffer = combined.as_bytes();
        
        // Parse first frame
        let (req1, consumed1) = parse_line_frame::<Request>(buffer).unwrap().unwrap();
        assert_eq!(req1.id, 1);
        assert_eq!(consumed1, frame1.len());
        
        // Parse second frame
        let (req2, consumed2) = parse_line_frame::<Request>(&buffer[consumed1..]).unwrap().unwrap();
        assert_eq!(req2.id, 2);
        assert_eq!(consumed2, frame2.len());
    }

    #[test]
    fn test_has_complete_frame() {
        let complete = b"{\"id\":1,\"method\":\"ping\"}\n";
        let incomplete = b"{\"id\":1,\"method\":\"ping\"";
        
        assert!(has_complete_frame(complete));
        assert!(!has_complete_frame(incomplete));
    }
}
