//! Error types for hphe-ipc
//!
//! Provides comprehensive error handling for named pipe IPC operations.


use std::io;
use thiserror::Error;

use crate::protocol::{ErrorCode, Method};

/// Main error type for hphe-ipc operations
#[derive(Debug, Error)]
pub enum IpcError {
    /// I/O error (wraps std::io::Error)
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    /// JSON serialization/deserialization error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Protocol error with a specific error code
    #[error("Protocol error: {code} - {message}")]
    Protocol {
        code: ErrorCode,
        message: String,
    },

    /// Named pipe connection error
    #[error("Named pipe connection error: {0}")]
    ConnectionError(String),

    /// Named pipe creation error
    #[error("Named pipe creation error: {0}")]
    CreationError(String),

    /// ACL/security descriptor error
    #[error("ACL error: {0}")]
    AclError(String),

    /// Invalid pipe name
    #[error("Invalid pipe name: {0}")]
    InvalidPipeName(String),

    /// Method not implemented
    #[error("Method not implemented: {0}")]
    MethodNotImplemented(Method),

    /// Invalid request format
    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    /// Timeout error
    #[error("Timeout after {0}ms")]
    Timeout(u64),

    /// Connection closed by peer
    #[error("Connection closed by peer")]
    ConnectionClosed,

    /// Access denied (ACL rejection)
    #[error("Access denied")]
    AccessDenied,

    /// Invalid message frame
    #[error("Invalid message frame: {0}")]
    InvalidFrame(String),

    /// Server is shutting down
    #[error("Server shutting down")]
    Shutdown,

    /// Task join error
    #[error("Task join error: {0}")]
    Join(#[from] tokio::task::JoinError),

    /// Generic error with context
    #[error("IPC error: {0}")]
    Generic(String),
}

impl IpcError {
    /// Create a protocol error from an error code
    pub fn protocol(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::Protocol {
            code,
            message: message.into(),
        }
    }

    /// Check if this is a connection error
    pub fn is_connection_error(&self) -> bool {
        matches!(
            self,
            IpcError::Io(e) if e.kind() == io::ErrorKind::ConnectionRefused
                || e.kind() == io::ErrorKind::ConnectionReset
                || e.kind() == io::ErrorKind::BrokenPipe
        ) || matches!(self, IpcError::ConnectionError(_))
            || matches!(self, IpcError::ConnectionClosed)
    }

    /// Check if this is a timeout error
    pub fn is_timeout(&self) -> bool {
        matches!(self, IpcError::Timeout(_))
            || matches!(self, IpcError::Io(e) if e.kind() == io::ErrorKind::TimedOut)
    }

    /// Check if this is an access denied error
    pub fn is_access_denied(&self) -> bool {
        matches!(self, IpcError::AccessDenied)
            || matches!(self, IpcError::Protocol { code: ErrorCode::AccessDenied, .. })
            || matches!(self, IpcError::Io(e) if e.kind() == io::ErrorKind::PermissionDenied)
    }

    /// Get the error code if this is a protocol error
    pub fn error_code(&self) -> Option<ErrorCode> {
        match self {
            IpcError::Protocol { code, .. } => Some(code.clone()),
            IpcError::AccessDenied => Some(ErrorCode::AccessDenied),
            IpcError::ConnectionError(_) => Some(ErrorCode::ConnectionFailed),
            IpcError::Timeout(_) => Some(ErrorCode::Timeout),
            IpcError::InvalidFrame(_) | IpcError::InvalidRequest(_) => Some(ErrorCode::InvalidRequest),
            IpcError::MethodNotImplemented(_) => Some(ErrorCode::MethodNotFound),
            _ => None,
        }
    }

    /// Convert to a protocol ErrorResponse
    pub fn to_error_response(&self) -> crate::protocol::ErrorResponse {
        use crate::protocol::ErrorResponse;
        
        let message = self.to_string();
        let code = self.error_code().unwrap_or(ErrorCode::InternalError);
        
        ErrorResponse::new(code, message)
    }
}

/// Result type for hphe-ipc operations
pub type IpcResult<T> = Result<T, IpcError>;

/// Helper trait for converting std::io::Error to IpcError with context
pub trait IoContext<T> {
    fn with_context(self, context: impl Into<String>) -> IpcResult<T>;
}

impl<T> IoContext<T> for io::Result<T> {
    fn with_context(self, context: impl Into<String>) -> IpcResult<T> {
        self.map_err(|e| {
            if e.kind() == io::ErrorKind::PermissionDenied {
                IpcError::AccessDenied
            } else if e.kind() == io::ErrorKind::ConnectionRefused {
                IpcError::ConnectionError(format!("{}: {}", context.into(), e))
            } else {
                IpcError::Io(e)
            }
        })
    }
}

/// Helper trait for creating IpcError from string with context
pub trait ContextExt {
    fn context(self, context: impl Into<String>) -> Self;
}

impl ContextExt for IpcError {
    fn context(mut self, context: impl Into<String>) -> Self {
        match &mut self {
            IpcError::Generic(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::Protocol { message, .. } => {
                *message = format!("{}: {}", context.into(), message);
            }
            IpcError::ConnectionError(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::CreationError(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::AclError(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::InvalidPipeName(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::InvalidRequest(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            IpcError::InvalidFrame(msg) => {
                *msg = format!("{}: {}", context.into(), msg);
            }
            _ => {}
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_error() {
        let err = IpcError::protocol(ErrorCode::NotFound, "Row not found");
        assert!(err.is_access_denied() == false);
        assert_eq!(err.error_code(), Some(ErrorCode::NotFound));
    }

    #[test]
    fn test_access_denied() {
        let err = IpcError::AccessDenied;
        assert!(err.is_access_denied());
        assert_eq!(err.error_code(), Some(ErrorCode::AccessDenied));
    }

    #[test]
    fn test_io_permission_denied() {
        let io_err = io::Error::new(io::ErrorKind::PermissionDenied, "Access denied");
        let err: IpcError = io_err.into();
        assert!(err.is_access_denied());
    }

    #[test]
    fn test_to_error_response() {
        let err = IpcError::protocol(ErrorCode::NotFound, "Row 123 not found");
        let resp = err.to_error_response();
        assert_eq!(resp.code, ErrorCode::NotFound);
        assert!(resp.message.contains("Row 123 not found"));
    }

    #[test]
    fn test_context_extension() {
        let err = IpcError::Generic("Base error".to_string());
        let err_with_context = err.context("Context");
        let msg = err_with_context.to_string();
        assert!(msg.contains("Context"));
        assert!(msg.contains("Base error"));
    }
}
