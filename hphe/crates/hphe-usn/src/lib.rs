//! # hphe-usn: NTFS USN Journal Watcher for Continuous Index Updates
//!
//! Real-time USN journal monitoring component for the Hephaistos engine.
//! Watches NTFS volumes for file system changes and applies deltas to the FileIndex.
//!
//! ## Features
//!
//! - **FSCTL_QUERY_USN_JOURNAL**: Query journal metadata (USN_JOURNAL_DATA_V2)
//! - **FSCTL_READ_USN_JOURNAL**: Read journal records (USN_RECORD_V2/V4)
//! - **Delta Application**: Apply create/delete/rename/data_overwrite operations to FileIndex
//! - **Wrap Detection**: Detect journal wrap (UsnJournalID change or FirstUsn > next_usn)
//! - **Checkpoint Persistence**: Save last_usn to disk for crash recovery
//!
//! ## Usage
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! use hphe_usn::{UsnWatcher, UsnConfig};
//! use hphe_index::FileIndex;
//! use std::sync::Arc;
//!
//! let index = Arc::new(FileIndex::new());
//! let config = UsnConfig::default();
//! let mut watcher = UsnWatcher::new("C", index.clone(), config)?;
//!
//! // Start watching
//! watcher.poll()?;
//!
//! // Get current USN position
//! let last_usn = watcher.next_usn();
//! # Ok(())
//! # }
//! ```
//!
//! ## Architecture
//!
//! The watcher maintains a continuous polling loop that:
//! 1. Queries the USN journal metadata
//! 2. Reads new records since last processed USN
//! 3. Applies changes to the FileIndex
//! 4. Persists checkpoint (last_usn, journal_id)
//! 5. Detects wrap conditions and triggers full resync

#![allow(clippy::excessive_precision)]

pub mod checkpoint;
pub mod delta;
pub mod error;
pub mod journal;
pub mod watcher;

#[cfg(test)]
mod tests;

pub use checkpoint::{Checkpoint, CheckpointStore, MemoryCheckpointStore};
pub use delta::{DeltaApplyError, DeltaProcessor, DeltaType, FileDelta};
pub use error::UsnError;
pub use journal::{
    read_usn_journal, query_usn_journal, UsnJournalData, UsnReadData, UsnRecord,
    READ_USN_JOURNAL_DATA_V1, USN_JOURNAL_DATA_V2, USN_READ_JOURNAL_DATA_V1, USN_RECORD_V2, USN_RECORD_V4,
};
pub use watcher::{UsnConfig, UsnStats, UsnWatcher};

/// Re-export commonly used types
pub use hphe_index::{EntryId, FileIndex, Frn, Timestamp};
pub use hphe_mft::record::MftEntry;
pub use hphe_mft::volume::Volume;

/// Magic value indicating a full resync is required due to journal wrap
pub const USN_WRAP_DETECTED: i64 = -1;

/// Default poll interval in milliseconds
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 250;

/// Default buffer size for reading USN records (64 KB)
pub const DEFAULT_READ_BUFFER_SIZE: usize = 65536;

/// Threshold in bytes before triggering a full resync (256 MB)
pub const DEFAULT_BACKLOG_THRESHOLD: u64 = 256 * 1024 * 1024;

/// Maximum number of records to process in a single batch
pub const DEFAULT_MAX_BATCH_SIZE: usize = 10000;
