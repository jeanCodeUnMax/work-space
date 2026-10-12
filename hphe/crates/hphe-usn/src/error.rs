//! Error types for the USN watcher.

use std::fmt;
use std::io;

/// Error types for USN journal operations.
#[derive(Debug)]
pub enum UsnError {
    /// I/O error when accessing the volume or journal
    Io(io::Error),
    /// IOCTL operation failed
    IoctlError {
        operation: String,
        source: io::Error,
    },
    /// Journal not found or not enabled on the volume
    JournalNotAvailable,
    /// Insufficient buffer size for reading records
    BufferTooSmall {
        required: usize,
        available: usize,
    },
    /// Invalid USN record encountered
    InvalidUsnRecord {
        reason: String,
    },
    /// Journal wrap detected - requires full resync
    JournalWrapDetected {
        old_journal_id: i64,
        new_journal_id: i64,
    },
    /// Backlog too large - requires full resync
    BacklogTooLarge {
        backlog_bytes: u64,
        threshold: u64,
    },
    /// Failed to apply delta to index
    DeltaApplyFailed {
        frn: u64,
        reason: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// Checkpoint read/write error
    CheckpointError {
        path: String,
        source: io::Error,
    },
    /// Volume access requires elevation
    ElevationRequired {
        drive: String,
    },
}

impl fmt::Display for UsnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UsnError::Io(e) => write!(f, "I/O error: {e}"),
            UsnError::IoctlError { operation, source } => {
                write!(f, "IOCTL operation '{operation}' failed: {source}")
            }
            UsnError::JournalNotAvailable => {
                write!(f, "USN journal not available on this volume")
            }
            UsnError::BufferTooSmall { required, available } => {
                write!(
                    f,
                    "Buffer too small: need {required} bytes, have {available} bytes"
                )
            }
            UsnError::InvalidUsnRecord { reason } => {
                write!(f, "Invalid USN record: {reason}")
            }
            UsnError::JournalWrapDetected {
                old_journal_id,
                new_journal_id,
            } => {
                write!(
                    f,
                    "Journal wrap detected: old ID={old_journal_id}, new ID={new_journal_id}"
                )
            }
            UsnError::BacklogTooLarge {
                backlog_bytes,
                threshold,
            } => {
                write!(
                    f,
                    "Backlog too large: {backlog_bytes} bytes > threshold {threshold} bytes"
                )
            }
            UsnError::DeltaApplyFailed { frn, reason, .. } => {
                write!(f, "Failed to apply delta for FRN {frn}: {reason}")
            }
            UsnError::CheckpointError { path, source } => {
                write!(f, "Checkpoint error for '{path}': {source}")
            }
            UsnError::ElevationRequired { drive } => {
                write!(
                    f,
                    "Access to volume \\\\.\\{drive}: requires administrator privileges"
                )
            }
        }
    }
}

impl std::error::Error for UsnError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            UsnError::Io(e) => Some(e),
            UsnError::IoctlError { source, .. } => Some(source),
            UsnError::CheckpointError { source, .. } => Some(source),
            UsnError::DeltaApplyFailed { source, .. } => {
                source.as_ref().map(|e| &**e as &(dyn std::error::Error + 'static))
            }
            _ => None,
        }
    }
}

impl From<io::Error> for UsnError {
    fn from(e: io::Error) -> Self {
        UsnError::Io(e)
    }
}

impl From<hphe_mft::VolumeError> for UsnError {
    fn from(e: hphe_mft::VolumeError) -> Self {
        match e {
            hphe_mft::VolumeError::ElevationRequired { drive } => UsnError::ElevationRequired { drive },
            hphe_mft::VolumeError::Io(err) => UsnError::Io(err),
            hphe_mft::VolumeError::InvalidDriveName(d) => {
                UsnError::Io(io::Error::new(io::ErrorKind::InvalidInput, format!("Invalid drive name: {d}")))
            }
        }
    }
}

/// Result type for USN operations.
pub type UsnResult<T> = Result<T, UsnError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn test_error_display() {
        let io_err = UsnError::Io(io::Error::new(io::ErrorKind::NotFound, "file not found"));
        assert!(io_err.to_string().contains("file not found"));

        let wrap_err = UsnError::JournalWrapDetected {
            old_journal_id: 100,
            new_journal_id: 200,
        };
        assert!(wrap_err.to_string().contains("100"));
        assert!(wrap_err.to_string().contains("200"));
    }

    #[test]
    fn test_error_source() {
        let io_err = io::Error::new(io::ErrorKind::NotFound, "test");
        let usn_err: UsnError = io_err.into();
        assert!(usn_err.source().is_some());
    }
}
