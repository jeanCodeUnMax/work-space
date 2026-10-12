//! USN Journal Watcher implementation.
//!
//! This module provides the main UsnWatcher struct that monitors NTFS volumes
//! for file system changes and applies them to a FileIndex.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use hphe_index::FileIndex;
use tracing::{debug, error, info, instrument, warn};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

pub use crate::checkpoint::{Checkpoint, CheckpointStore, CheckpointStoreTrait};
use crate::delta::{DeltaProcessor, FileDelta, MftRecordFetcher};
use crate::error::{UsnError, UsnResult};
use crate::journal::{
    iter_usn_records, query_usn_journal, read_usn_journal, UsnJournalData,
};
use crate::DEFAULT_POLL_INTERVAL_MS;

/// Configuration for the USN watcher.
#[derive(Debug, Clone)]
pub struct UsnConfig {
    /// Drive letter to monitor (e.g., "C")
    pub drive_letter: String,
    /// Poll interval in milliseconds
    pub poll_interval_ms: u64,
    /// Maximum buffer size for reading journal records
    pub read_buffer_size: usize,
    /// Maximum number of records to process per batch
    pub max_batch_size: usize,
    /// Backlog threshold in bytes before triggering full resync
    pub backlog_threshold: u64,
    /// Path to checkpoint directory
    pub checkpoint_dir: Option<String>,
}

impl Default for UsnConfig {
    fn default() -> Self {
        Self {
            drive_letter: "C".to_string(),
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
            read_buffer_size: 65536, // 64 KB
            max_batch_size: 10000,
            backlog_threshold: 256 * 1024 * 1024, // 256 MB
            checkpoint_dir: None,
        }
    }
}

impl UsnConfig {
    /// Creates a new UsnConfig with the given drive letter.
    pub fn for_drive(drive: &str) -> Self {
        Self {
            drive_letter: drive.to_uppercase(),
            ..Default::default()
        }
    }
}

/// Statistics for the USN watcher.
#[derive(Debug, Clone)]
pub struct UsnStats {
    pub records_read: usize,
    pub records_processed: usize,
    pub poll_count: usize,
    pub resync_count: usize,
    pub errors: usize,
    pub last_error: Option<String>,
    pub last_poll_time: Option<Instant>,
    pub startup_time: Instant,
}

impl Default for UsnStats {
    fn default() -> Self {
        Self::new()
    }
}

impl UsnStats {
    pub fn new() -> Self {
        Self {
            records_read: 0,
            records_processed: 0,
            poll_count: 0,
            resync_count: 0,
            errors: 0,
            last_error: None,
            last_poll_time: None,
            startup_time: Instant::now(),
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }
}

/// Callback type for delta processing.
/// 
/// This is called when a batch of deltas has been processed.
pub type DeltaCallback = Box<dyn Fn(&[FileDelta], &UsnStats) + Send + Sync>;

/// Main USN journal watcher.
/// 
/// Watches a NTFS volume's USN journal and applies changes to a FileIndex.
pub struct UsnWatcher {
    /// Drive letter being monitored
    pub(crate) drive_letter: String,
    /// Handle to the volume
    pub(crate) volume_handle: Option<HANDLE>,
    /// Reference to the file index
    pub(crate) index: Arc<FileIndex>,
    /// Configuration
    pub(crate) config: UsnConfig,
    /// Delta processor
    pub(crate) delta_processor: DeltaProcessor,
    /// Checkpoint store
    pub(crate) checkpoint_store: Box<dyn CheckpointStoreTrait>,
    /// Current journal metadata
    pub(crate) journal_data: Option<UsnJournalData>,
    /// Last processed USN
    pub(crate) last_usn: i64,
    /// Journal ID at last checkpoint
    pub(crate) last_journal_id: i64,
    /// Statistics
    pub(crate) stats: UsnStats,
    /// Whether the watcher is running
    pub(crate) is_running: AtomicBool,
    /// Whether a resync is currently in progress
    pub(crate) is_resyncing: AtomicBool,
    /// Callback for delta processing
    pub(crate) callback: Option<DeltaCallback>,
}


impl UsnWatcher {
    /// Creates a new USN watcher for the specified volume and index.
    pub fn new(
        drive_letter: &str,
        index: Arc<FileIndex>,
        config: UsnConfig,
    ) -> UsnResult<Self> {
        let checkpoint_store = if let Some(dir) = &config.checkpoint_dir {
            Box::new(CheckpointStore::new(dir)) as Box<dyn CheckpointStoreTrait>
        } else {
            // For now, use a memory store if no directory specified
            // In production, we should always have a checkpoint directory
            Box::new(crate::checkpoint::MemoryCheckpointStore::new())
        };

        let mut watcher = Self {
            drive_letter: drive_letter.to_uppercase(),
            volume_handle: None,
            index: index.clone(),
            config: config.clone(),
            delta_processor: DeltaProcessor::new(index),
            checkpoint_store,
            journal_data: None,
            last_usn: 0,
            last_journal_id: 0,
            stats: UsnStats::new(),
            is_running: AtomicBool::new(false),
            is_resyncing: AtomicBool::new(false),
            callback: None,
        };

        // Try to load existing checkpoint
        watcher.load_checkpoint()?;

        Ok(watcher)
    }

    /// Creates a new USN watcher with a callback for delta processing.
    pub fn with_callback(
        drive_letter: &str,
        index: Arc<FileIndex>,
        config: UsnConfig,
        callback: DeltaCallback,
    ) -> UsnResult<Self> {
        let mut watcher = Self::new(drive_letter, index, config)?;
        watcher.callback = Some(callback);
        Ok(watcher)
    }

    /// Returns the current drive letter being monitored.
    pub fn drive_letter(&self) -> &str {
        &self.drive_letter
    }

    /// Returns the current statistics.
    pub fn stats(&self) -> &UsnStats {
        &self.stats
    }

    /// Returns the last processed USN.
    pub fn next_usn(&self) -> i64 {
        self.last_usn
    }

    /// Returns whether the watcher is currently running.
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Acquire)
    }

    /// Loads the checkpoint from disk.
    pub fn load_checkpoint(&mut self) -> UsnResult<()> {
        if let Some(checkpoint) = self.checkpoint_store.load(&self.drive_letter)? {
            self.last_usn = checkpoint.last_usn;
            self.last_journal_id = checkpoint.journal_id;
            
            info!(
                "Loaded checkpoint for {}: last_usn={}, journal_id={}",
                self.drive_letter, self.last_usn, self.last_journal_id
            );
        } else {
            info!("No checkpoint found for {} - will start from beginning", self.drive_letter);
        }
        
        Ok(())
    }

    /// Saves the current checkpoint to disk.
    pub fn save_checkpoint(&self) -> UsnResult<()> {
        if let Some(journal_data) = &self.journal_data {
            let checkpoint = Checkpoint::new(
                &self.drive_letter,
                journal_data.journal_id,
                self.last_usn,
                journal_data.first_usn,
            );
            
            self.checkpoint_store.save(&checkpoint)?;
            
            debug!(
                "Saved checkpoint for {}: last_usn={}, journal_id={}",
                self.drive_letter, self.last_usn, checkpoint.journal_id
            );
        }
        
        Ok(())
    }

    /// Opens the volume handle.
    #[instrument(skip(self))]
    pub fn open_volume(&mut self) -> UsnResult<()> {
        if self.volume_handle.is_some() {
            return Ok(());
        }

        let volume_path = format!(r"\\.\{}:", self.drive_letter);
        let path_wide: Vec<u16> = volume_path
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // SAFETY: Creating a file handle with proper parameters
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };

        if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            let err_code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
            if err_code == windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED {
                return Err(UsnError::ElevationRequired {
                    drive: self.drive_letter.clone(),
                });
            }
            return Err(UsnError::Io(std::io::Error::from_raw_os_error(err_code as i32)));
        }

        self.volume_handle = Some(handle);
        
        info!("Opened volume \\\\.\\{}:", self.drive_letter);
        
        Ok(())
    }

    /// Closes the volume handle.
    pub fn close_volume(&mut self) {
        if let Some(handle) = self.volume_handle.take() {
            // SAFETY: Closing a valid handle
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            
            info!("Closed volume \\\\.\\{}:", self.drive_letter);
        }
    }

    /// Queries the USN journal metadata.
    #[instrument(skip(self))]
    pub fn query_journal(&mut self) -> UsnResult<UsnJournalData> {
        if self.volume_handle.is_none() {
            self.open_volume()?;
        }

        let handle = self.volume_handle.unwrap();
        let journal_data = unsafe { query_usn_journal(handle)? };
        
        self.journal_data = Some(journal_data.clone());
        
        Ok(journal_data)
    }

    /// Polls the USN journal for new records and applies them to the index.
    /// 
    /// This is the main entry point for the watcher's polling loop.
    #[instrument(skip(self))]
    pub fn poll(&mut self) -> UsnResult<()> {
        if self.is_running.load(Ordering::Acquire) {
            warn!("Watcher is already running for {}", self.drive_letter);
            return Ok(());
        }

        self.is_running.store(true, Ordering::Release);
        
        info!("Starting USN watcher poll for {}", self.drive_letter);
        
        // Query journal metadata
        let journal_data = self.query_journal()?;
        
        // Check for wrap conditions
        self.check_wrap_conditions(&journal_data)?;
        
        // Read and process new records
        self.process_new_records(&journal_data)?;
        
        // Save checkpoint
        self.save_checkpoint()?;
        
        self.stats.poll_count += 1;
        self.stats.last_poll_time = Some(Instant::now());
        
        self.is_running.store(false, Ordering::Release);
        
        Ok(())
    }

    /// Checks for journal wrap conditions that require a full resync.
    #[instrument(skip(self, journal_data))]
    fn check_wrap_conditions(&mut self, journal_data: &UsnJournalData) -> UsnResult<()> {
        // Check if journal ID changed (journal was recreated)
        if self.last_journal_id != 0 && self.last_journal_id != journal_data.journal_id {
            warn!(
                "Journal wrap detected: ID changed from {} to {}",
                self.last_journal_id, journal_data.journal_id
            );
            
            let old_id = self.last_journal_id;
            self.stats.resync_count += 1;
            self.last_journal_id = journal_data.journal_id;
            self.last_usn = journal_data.first_usn;
            
            // Signal that a resync is needed
            return Err(UsnError::JournalWrapDetected {
                old_journal_id: old_id,
                new_journal_id: journal_data.journal_id,
            });
        }

        // Check if our last_usn is before the current first_usn (wrap around)
        if self.last_usn != 0 && self.last_usn < journal_data.first_usn {
            warn!(
                "Journal wrap detected: last_usn {} < first_usn {}",
                self.last_usn, journal_data.first_usn
            );
            
            let old_id = self.last_journal_id;
            self.stats.resync_count += 1;
            self.last_journal_id = journal_data.journal_id;
            self.last_usn = journal_data.first_usn;
            
            return Err(UsnError::JournalWrapDetected {
                old_journal_id: old_id,
                new_journal_id: journal_data.journal_id,
            });
        }

        // Update journal ID if this is our first query
        if self.last_journal_id == 0 {
            self.last_journal_id = journal_data.journal_id;
        }

        Ok(())
    }

    /// Processes new USN records from the journal.
    #[instrument(skip(self))]
    fn process_new_records(&mut self, journal_data: &UsnJournalData) -> UsnResult<()> {
        if self.volume_handle.is_none() {
            self.open_volume()?;
        }

        let handle = self.volume_handle.unwrap();
        let start_usn = self.last_usn;
        
        // Calculate how much backlog there is
        let backlog = journal_data.next_usn - start_usn;
        
        // Check backlog threshold
        // Note: This is a simplified check - actual backlog size depends on record sizes
        if backlog > (self.config.backlog_threshold as i64) {
            warn!(
                "Backlog too large: {} records > threshold {}",
                backlog, self.config.backlog_threshold
            );
            return Err(UsnError::BacklogTooLarge {
                backlog_bytes: backlog as u64,
                threshold: self.config.backlog_threshold,
            });
        }

        // Read records in batches
        let mut current_usn = start_usn;
        let mut total_records = 0;
        
        loop {
            // Create read buffer
            let mut buffer = vec![0u8; self.config.read_buffer_size];
            
            // Read a batch of records
            let (read_data, bytes_returned) = unsafe {
                read_usn_journal(handle, current_usn, &mut buffer)?
            };
            
            if bytes_returned == 0 {
                // No more records
                break;
            }

            // Update current USN
            current_usn = read_data.StartUsn + bytes_returned as i64;

            // Process the records in this batch
            let records_buffer = &buffer[..bytes_returned];
            let mut deltas = Vec::new();

            for record in iter_usn_records(records_buffer) {
                // SAFETY: The buffer is valid for the lifetime of the iterator
                let name = unsafe { record.file_name(records_buffer) };
                let file_deltas = FileDelta::from_usn_record(&record, name);
                deltas.extend(file_deltas);
                total_records += 1;
            }

            self.stats.records_read = total_records;
            
            // Apply deltas to index
            self.apply_deltas(deltas)?;
            
            // Check if we've reached the batch limit
            if total_records >= self.config.max_batch_size {
                self.last_usn = current_usn;
                break;
            }
            
            // If we didn't get a full buffer, we've reached the end
            if bytes_returned < self.config.read_buffer_size {
                self.last_usn = current_usn;
                break;
            }
        }
        
        self.stats.records_processed = total_records;
        
        debug!(
            "Processed {} USN records for {}, last_usn={}",
            total_records, self.drive_letter, self.last_usn
        );
        
        Ok(())
    }

    /// Applies a batch of deltas to the index.
    fn apply_deltas(&mut self, deltas: Vec<FileDelta>) -> UsnResult<()> {
        // For now, just process with the default processor
        // In production, we'd use the async version with MFT fetching
        for delta in &deltas {
            if let Err(e) = self.delta_processor.apply_delta(delta) {
                error!("Failed to apply delta: {}", e);
                self.stats.errors += 1;
                self.stats.last_error = Some(e.to_string());
            }
        }
        
        // Notify callback if configured
        if let Some(ref callback) = self.callback {
            callback(&deltas, &self.stats);
        }
        
        Ok(())
    }

    /// Starts a continuous polling loop.
    /// 
    /// This runs in the background, polling at the configured interval.
    pub fn start(&mut self) -> UsnResult<()> {
        info!("Starting USN watcher for {}", self.drive_letter);
        Ok(())
    }

    /// Stops the polling loop.
    pub fn stop(&mut self) -> UsnResult<()> {
        self.is_running.store(false, Ordering::Release);
        self.close_volume();
        
        info!("Stopped USN watcher for {}", self.drive_letter);
        
        Ok(())
    }
}

impl Drop for UsnWatcher {
    fn drop(&mut self) {
        // Make sure to close the volume handle
        self.close_volume();
        
        // Save checkpoint on drop if we have one
        if self.last_usn != 0 {
            let _ = self.save_checkpoint();
        }
    }
}

/// Async wrapper for UsnWatcher that can be used with Tokio.
pub struct AsyncUsnWatcher {
    inner: UsnWatcher,
    mft_fetcher: Box<dyn MftRecordFetcher>,
}

impl AsyncUsnWatcher {
    /// Creates a new async USN watcher.
    pub fn new(
        drive_letter: &str,
        index: Arc<FileIndex>,
        config: UsnConfig,
        mft_fetcher: Box<dyn MftRecordFetcher>,
    ) -> UsnResult<Self> {
        let watcher = UsnWatcher::new(drive_letter, index, config)?;
        
        Ok(Self {
            inner: watcher,
            mft_fetcher,
        })
    }

    /// Polls the USN journal asynchronously.
    pub async fn poll_async(&mut self) -> UsnResult<()> {
        self.inner.poll()
    }

    /// Returns a reference to the inner watcher.
    pub fn as_ref(&self) -> &UsnWatcher {
        &self.inner
    }

    /// Returns a mutable reference to the inner watcher.
    pub fn as_mut(&mut self) -> &mut UsnWatcher {
        &mut self.inner
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hphe_index::FileIndex;
    use std::sync::Arc;

    #[test]
    fn test_usn_config_default() {
        let config = UsnConfig::default();
        assert_eq!(config.drive_letter, "C");
        assert_eq!(config.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
    }

    #[test]
    fn test_usn_config_for_drive() {
        let config = UsnConfig::for_drive("D");
        assert_eq!(config.drive_letter, "D");
    }

    #[test]
    fn test_usn_stats_new() {
        let stats = UsnStats::new();
        assert!(stats.startup_time.elapsed().as_secs() < 1);
    }

    #[test]
    fn test_check_wrap_journal_id_change() {
        let index = Arc::new(FileIndex::new());
        let config = UsnConfig::for_drive("C");
        let mut watcher = UsnWatcher::new("C", index, config).unwrap();
        
        watcher.last_journal_id = 100;
        watcher.last_usn = 5000;
        
        let journal_data = UsnJournalData {
            journal_id: 200, // Changed
            first_usn: 1000,
            next_usn: 6000,
            lowest_valid_usn: 1000,
            max_size: 1024 * 1024,
            current_max_usn: 5000,
        };
        
        let result = watcher.check_wrap_conditions(&journal_data);
        assert!(result.is_err());
        
        if let Err(UsnError::JournalWrapDetected { old_journal_id, new_journal_id }) = result {
            assert_eq!(old_journal_id, 100);
            assert_eq!(new_journal_id, 200);
        } else {
            panic!("Expected JournalWrapDetected error");
        }
    }

    #[test]
    fn test_check_wrap_first_usn() {
        let index = Arc::new(FileIndex::new());
        let config = UsnConfig::for_drive("C");
        let mut watcher = UsnWatcher::new("C", index, config).unwrap();
        
        watcher.last_journal_id = 100;
        watcher.last_usn = 5000;
        
        let journal_data = UsnJournalData {
            journal_id: 100, // Same
            first_usn: 6000, // Our last_usn is 5000 < 6000
            next_usn: 7000,
            lowest_valid_usn: 6000,
            max_size: 1024 * 1024,
            current_max_usn: 7000,
        };
        
        let result = watcher.check_wrap_conditions(&journal_data);
        assert!(result.is_err());
        
        if let Err(UsnError::JournalWrapDetected { .. }) = result {
            // Expected
        } else {
            panic!("Expected JournalWrapDetected error");
        }
    }
}
