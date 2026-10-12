//! Index Scanner Module.
//!
//! Enchains raw NTFS MFT streaming via `hphe-mft` with SoA index construction.

use std::time::{Duration, Instant};

use crate::{FileIndex, IndexError};
use hphe_mft::reader::{get_peak_working_set_bytes, MftReader};
use hphe_mft::record::MftEntry;

/// Statistics gathered during the MFT scan and index build.
#[derive(Debug, Clone)]
pub struct ScanResult {
    pub drive: String,
    pub total_records: u64,
    pub valid_entries: u64,
    pub valid_ratio_pct: f64,
    pub scan_duration: Duration,
    pub build_duration_ms: u64,
    pub total_duration_ms: u64,
    pub peak_working_set_bytes: usize,
}

/// Scanner that bridges `MftReader` and `FileIndex`.
pub struct IndexScanner;

impl IndexScanner {
    /// Opens the specified drive, streams all FILE records, and builds the SoA index.
    pub fn scan(drive: &str) -> Result<(FileIndex, ScanResult), IndexError> {
        let drive_clean = drive.trim_end_matches([':', '\\', '/']).to_uppercase();
        let mut reader = MftReader::open_volume(&drive_clean)?;

        let scan_start = Instant::now();
        let mut entries = Vec::new();
        let mft_stats = reader.scan_records(|entry| {
            entries.push(entry);
        })?;
        let scan_duration = scan_start.elapsed();

        let build_start = Instant::now();
        let index = FileIndex::build_with_drive(&drive_clean, entries);
        let build_duration_ms = build_start.elapsed().as_millis() as u64;

        let total_duration_ms = scan_duration.as_millis() as u64 + build_duration_ms;

        let result = ScanResult {
            drive: drive_clean,
            total_records: mft_stats.total_records,
            valid_entries: mft_stats.valid_entries,
            valid_ratio_pct: mft_stats.valid_ratio_pct,
            scan_duration,
            build_duration_ms,
            total_duration_ms,
            peak_working_set_bytes: get_peak_working_set_bytes(),
        };

        Ok((index, result))
    }
}

/// Builder helper for constructing FileIndex from various sources.
pub struct IndexBuilder;

impl IndexBuilder {
    /// Builds an index from synthetic MFT entries.
    pub fn from_synthetic(count: usize) -> FileIndex {
        let entries = crate::generate_synthetic_entries(count);
        FileIndex::build_with_drive("C:", entries)
    }

    /// Builds an index from an iterator of `MftEntry`.
    pub fn from_iter<I>(entries: I) -> FileIndex
    where
        I: IntoIterator<Item = MftEntry>,
    {
        FileIndex::build(entries)
    }
}
