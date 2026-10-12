//! Delta processing for USN journal records.
//!
//! This module handles the application of USN journal changes to the FileIndex,
//! including create, delete, rename, and data overwrite operations.

use std::sync::Arc;

use hphe_index::{FileIndex, Frn};
use hphe_mft::record::MftEntry;

use crate::error::UsnError;
use crate::journal::UsnRecord;
use crate::journal::usn_reason;

/// Type of file system change detected in USN journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeltaType {
    /// File was created
    Create,
    /// File was deleted
    Delete,
    /// File was renamed (old name)
    RenameOld,
    /// File was renamed (new name)
    RenameNew,
    /// File basic info changed (attributes, timestamps)
    BasicInfoChange,
    /// File data was overwritten
    DataOverwrite,
    /// File data was extended
    DataExtend,
    /// File data was truncated
    DataTruncate,
    /// File was closed
    Close,
}

impl DeltaType {
    /// Returns true if this delta type requires fetching the full MFT record.
    pub fn needs_mft_fetch(&self) -> bool {
        matches!(
            self,
            DeltaType::Create
                | DeltaType::RenameNew
                | DeltaType::BasicInfoChange
                | DeltaType::DataOverwrite
                | DeltaType::DataExtend
                | DeltaType::DataTruncate
                | DeltaType::Close
        )
    }

    /// Returns the corresponding USN_REASON flag for this delta type.
    pub fn to_reason_mask(&self) -> u32 {
        match self {
            DeltaType::Create => usn_reason::FILE_CREATE,
            DeltaType::Delete => usn_reason::FILE_DELETE,
            DeltaType::RenameOld => usn_reason::RENAME_OLD_NAME,
            DeltaType::RenameNew => usn_reason::RENAME_NEW_NAME,
            DeltaType::BasicInfoChange => usn_reason::BASIC_INFO_CHANGE,
            DeltaType::DataOverwrite => usn_reason::DATA_OVERWRITE,
            DeltaType::DataExtend => usn_reason::DATA_EXTEND,
            DeltaType::DataTruncate => usn_reason::DATA_TRUNCATION,
            DeltaType::Close => usn_reason::FILE_CLOSE,
        }
    }

    /// Parses USN_REASON flags and returns all applicable delta types.
    pub fn from_reason_flags(reason: u32) -> Vec<DeltaType> {
        let mut types = Vec::new();

        if reason & usn_reason::FILE_CREATE != 0 {
            types.push(DeltaType::Create);
        }
        if reason & usn_reason::FILE_DELETE != 0 {
            types.push(DeltaType::Delete);
        }
        if reason & usn_reason::RENAME_OLD_NAME != 0 {
            types.push(DeltaType::RenameOld);
        }
        if reason & usn_reason::RENAME_NEW_NAME != 0 {
            types.push(DeltaType::RenameNew);
        }
        if reason & usn_reason::BASIC_INFO_CHANGE != 0 {
            types.push(DeltaType::BasicInfoChange);
        }
        if reason & usn_reason::DATA_OVERWRITE != 0 {
            types.push(DeltaType::DataOverwrite);
        }
        if reason & usn_reason::DATA_EXTEND != 0 {
            types.push(DeltaType::DataExtend);
        }
        if reason & usn_reason::DATA_TRUNCATION != 0 {
            types.push(DeltaType::DataTruncate);
        }
        if reason & usn_reason::FILE_CLOSE != 0 {
            types.push(DeltaType::Close);
        }

        types
    }
}

/// Represents a single file system change from the USN journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDelta {
    /// Type of change
    pub delta_type: DeltaType,
    /// File Reference Number
    pub frn: Frn,
    /// Parent File Reference Number
    pub parent_frn: Frn,
    /// File name (if available)
    pub name: Option<String>,
    /// File attributes
    pub attributes: u32,
    /// Timestamp from the USN record (FILETIME)
    pub timestamp: i64,
    /// USN of this record
    pub usn: i64,
    /// Reason flags
    pub reason: u32,
}

impl FileDelta {
    /// Creates a new FileDelta from a USN record.
    pub fn from_usn_record(record: &UsnRecord, name: Option<String>) -> Vec<Self> {
        let delta_types = DeltaType::from_reason_flags(record.reason());
        let frn = record.file_reference_number();
        let parent_frn = record.parent_file_reference_number();
        let attributes = record.file_attributes();
        let timestamp = record.timestamp();
        let usn = record.usn();

        delta_types
            .into_iter()
            .map(|dt| Self {
                delta_type: dt,
                frn,
                parent_frn,
                name: name.clone(),
                attributes,
                timestamp,
                usn,
                reason: record.reason(),
            })
            .collect()
    }

    /// Returns true if this delta should trigger fetching the full MFT record.
    /// 
    /// We need the full MFT record for operations that require accurate metadata
    /// (sizes, timestamps) that aren't in the USN record.
    pub fn needs_mft_fetch(&self) -> bool {
        self.delta_type.needs_mft_fetch()
    }
}

/// Error that can occur when applying a delta to the index.
#[derive(Debug, Clone)]
pub struct DeltaApplyError {
    /// The delta that failed to apply
    pub delta: FileDelta,
    /// The error message
    pub message: String,
}

impl std::fmt::Display for DeltaApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Delta apply error for FRN {}: {}",
            self.delta.frn, self.message
        )
    }
}

impl std::error::Error for DeltaApplyError {}

/// Processes and applies USN journal deltas to a FileIndex.
pub struct DeltaProcessor {
    /// Reference to the file index
    index: Arc<FileIndex>,
    /// Maximum number of deltas to process in a batch
    max_batch_size: usize,
    /// Statistics
    stats: DeltaStats,
}

/// Statistics for delta processing.
#[derive(Debug, Clone, Default)]
pub struct DeltaStats {
    pub deltas_processed: usize,
    pub creates: usize,
    pub deletes: usize,
    pub renames: usize,
    pub updates: usize,
    pub errors: usize,
    pub mft_fetches: usize,
}

impl DeltaStats {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

impl DeltaProcessor {
    /// Creates a new DeltaProcessor for the given index.
    pub fn new(index: Arc<FileIndex>) -> Self {
        Self {
            index,
            max_batch_size: 10000,
            stats: DeltaStats::default(),
        }
    }

    /// Creates a new DeltaProcessor with custom batch size.
    pub fn with_batch_size(index: Arc<FileIndex>, batch_size: usize) -> Self {
        Self {
            index,
            max_batch_size: batch_size,
            stats: DeltaStats::default(),
        }
    }

    /// Returns the current statistics.
    pub fn stats(&self) -> &DeltaStats {
        &self.stats
    }

    /// Resets the statistics.
    pub fn reset_stats(&mut self) {
        self.stats.reset();
    }

    /// Applies a single delta to the index.
    pub fn apply_delta(&mut self, delta: &FileDelta) -> Result<(), DeltaApplyError> {
        match delta.delta_type {
            DeltaType::Create | DeltaType::RenameNew | DeltaType::Close => {
                // For create/rename_new/close, we need to fetch the full MFT record
                // to get accurate size and timestamps
                self.stats.creates += 1;
                Err(DeltaApplyError {
                    delta: delta.clone(),
                    message: "MFT fetch required for create/rename_new".to_string(),
                })
            }
            DeltaType::Delete => {
                self.apply_delete(delta);
                self.stats.deletes += 1;
                Ok(())
            }
            DeltaType::RenameOld => {
                self.apply_rename_old(delta);
                self.stats.renames += 1;
                Ok(())
            }
            DeltaType::BasicInfoChange | DeltaType::DataOverwrite | DeltaType::DataExtend | DeltaType::DataTruncate => {
                self.stats.updates += 1;
                Err(DeltaApplyError {
                    delta: delta.clone(),
                    message: "MFT fetch required for update".to_string(),
                })
            }
        }
    }

    /// Applies a delete delta: removes the entry from the index.
    fn apply_delete(&self, delta: &FileDelta) {
        self.index.apply_delete(delta.frn);
    }

    /// Applies a rename_old delta: invalidates the old path.
    /// 
    /// This is paired with a rename_new delta that will add the new path.
    fn apply_rename_old(&self, delta: &FileDelta) {
        self.index.apply_rename_old(delta.frn);
    }

    /// Applies a batch of deltas, fetching MFT records as needed.
    /// 
    /// This method handles the case where we need to fetch the full MFT record
    /// for certain delta types.
    pub fn apply_batch_with_fetch(
        &mut self,
        deltas: Vec<FileDelta>,
        mft_reader: &impl MftRecordFetcher,
    ) -> Result<Vec<DeltaApplyError>, UsnError> {
        let mut errors = Vec::new();
        let mut needs_fetch = Vec::new();
        let mut can_apply_directly = Vec::new();

        // Separate deltas that need MFT fetch from those that don't
        for delta in deltas {
            if delta.needs_mft_fetch() {
                needs_fetch.push(delta);
            } else {
                can_apply_directly.push(delta);
            }
        }

        // Apply deltas that don't need fetching
        for delta in can_apply_directly {
            if let Err(e) = self.apply_delta(&delta) {
                errors.push(e);
            }
        }

        // Batch fetch MFT records for deltas that need it
        let frns_to_fetch: Vec<Frn> = needs_fetch.iter().map(|d| d.frn).collect();
        let mft_entries = mft_reader.fetch_records(&frns_to_fetch)?;

        // Apply deltas with MFT data
        for delta in needs_fetch {
            if let Some(mft_entry) = mft_entries.get(&delta.frn) {
                if let Err(e) = self.apply_delta_with_mft(&delta, mft_entry) {
                    errors.push(e);
                }
            } else {
                // Failed to fetch MFT record - log and continue
                errors.push(DeltaApplyError {
                    delta,
                    message: "Failed to fetch MFT record".to_string(),
                });
            }
        }

        Ok(errors)
    }

    /// Applies a delta with full MFT record data.
    fn apply_delta_with_mft(&mut self, delta: &FileDelta, mft_entry: &MftEntry) -> Result<(), DeltaApplyError> {
        match delta.delta_type {
            DeltaType::Create | DeltaType::RenameNew | DeltaType::Close => {
                self.apply_create_or_update(mft_entry);
                self.stats.creates += 1;
                Ok(())
            }
            DeltaType::BasicInfoChange | DeltaType::DataOverwrite | DeltaType::DataExtend | DeltaType::DataTruncate => {
                self.apply_update(mft_entry);
                self.stats.updates += 1;
                Ok(())
            }
            _ => {
                // Should not happen - these are handled by apply_delta
                Err(DeltaApplyError {
                    delta: delta.clone(),
                    message: "Unexpected delta type for MFT-augmented apply".to_string(),
                })
            }
        }
    }

    /// Applies a create or update delta with full MFT data.
    fn apply_create_or_update(&self, mft_entry: &MftEntry) {
        self.index.apply_create_or_update(mft_entry);
    }

    /// Applies an update delta with full MFT data.
    fn apply_update(&self, mft_entry: &MftEntry) {
        // Same as create_or_update for now - we update with the new MFT data
        self.apply_create_or_update(mft_entry);
    }
}

/// Trait for fetching MFT records by FRN.
/// 
/// This is used by DeltaProcessor to get the full file metadata
/// when USN records don't contain enough information.
pub trait MftRecordFetcher: Send + Sync {
    /// Fetches MFT records for the given FRNs.
    fn fetch_records(&self, frns: &[Frn]) -> Result<std::collections::HashMap<Frn, MftEntry>, UsnError>;
}

/// Default implementation of MftRecordFetcher using hphe-mft.
#[derive(Clone)]
pub struct DefaultMftRecordFetcher {
    drive_letter: char,
}

impl MftRecordFetcher for DefaultMftRecordFetcher {
    fn fetch_records(&self, frns: &[Frn]) -> Result<std::collections::HashMap<Frn, MftEntry>, UsnError> {
        // This is a placeholder - in a real implementation, we would
        // open the volume and fetch individual FILE records
        // using FSCTL_GET_NTFS_FILE_RECORD
        
        let mut results = std::collections::HashMap::new();
        
        for &frn in frns {
            // For now, return a synthetic entry
            // In production, this would call the actual MFT reader
            results.insert(frn, MftEntry {
                frn,
                record_number: frn & 0x0000_FFFF_FFFF_FFFF,
                sequence_number: (frn >> 48) as u16,
                parent_frn: 0,
                parent_record_number: 0,
                name: format!("file_{frn}.txt"),
                size: 1024,
                allocated_size: 2048,
                created: 0,
                modified: 0,
                accessed: 0,
                mft_changed: 0,
                attributes: 0x20, // FILE_ATTRIBUTE_ARCHIVE
                is_dir: false,
                is_in_use: true,
                hard_links: 1,
                base_record_frn: 0,
            });
        }
        
        Ok(results)
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delta_type_from_reason_flags() {
        let reason = usn_reason::FILE_CREATE | usn_reason::FILE_CLOSE;
        let types = DeltaType::from_reason_flags(reason);
        
        assert!(types.contains(&DeltaType::Create));
        assert!(types.contains(&DeltaType::Close));
        assert_eq!(types.len(), 2);
    }

    #[test]
    fn test_delta_type_needs_mft_fetch() {
        assert!(DeltaType::Create.needs_mft_fetch());
        assert!(!DeltaType::Delete.needs_mft_fetch());
        assert!(DeltaType::BasicInfoChange.needs_mft_fetch());
        assert!(!DeltaType::RenameOld.needs_mft_fetch());
        assert!(DeltaType::RenameNew.needs_mft_fetch());
    }

    #[test]
    fn test_file_delta_from_usn_record() {
        // This would need actual USN record construction
        // For now, just test that the function exists
    }
}
