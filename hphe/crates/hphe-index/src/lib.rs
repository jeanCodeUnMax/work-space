//! # hphe-index: High-Performance NTFS File Index (SoA Layout)
//!
//! Autonomous, low-latency in-memory file index using Struct-of-Arrays (SoA) layout,
//! SIMD-accelerated substring search via `memchr::memmem`, and hierarchical path resolution.
//!
//! Component P1 of the Hephaistos Engine.

pub mod index;
pub mod path_resolver;
pub mod scanner;
pub mod snapshot;
pub mod synthetic;

pub use index::{FileIndex, FileIndexStats, IndexEntry, IndexError, SearchResult};
pub use path_resolver::{PathResolver, PathResolverStats, SegmentCache};
pub use scanner::{IndexBuilder, IndexScanner, ScanResult};
pub use snapshot::{Column, SectionHeader, SnapshotError, SnapshotHeader};
pub use synthetic::{generate_synthetic_entries, SyntheticMftGenerator};

// Re-export MftEntry and related types from hphe-mft
pub use hphe_mft::record::MftEntry;
pub use hphe_mft::reader::get_peak_working_set_bytes;

/// File Reference Number (NTFS unique record id).
pub type Frn = u64;
/// Volume slot index (0-25 for drive letters A-Z).
pub type VolumeIndex = u8;
/// Dense row id inside the SoA index.
pub type EntryId = u32;
/// Unix epoch seconds.
pub type Timestamp = i64;
/// File size in bytes.
pub type FileSize = u64;

pub const FLAG_DIRECTORY: u32 = 0x0001;
pub const FLAG_IN_USE: u32 = 0x0002;
pub const FLAG_HARDLINK: u32 = 0x0004;

/// Flags for an index entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EntryFlags {
    pub is_dir: bool,
    pub is_in_use: bool,
    pub is_hardlink: bool,
    pub raw_attributes: u32,
}

impl EntryFlags {
    pub fn new(is_dir: bool, is_in_use: bool, is_hardlink: bool, raw_attributes: u32) -> Self {
        Self {
            is_dir,
            is_in_use,
            is_hardlink,
            raw_attributes,
        }
    }

    pub fn to_u32(&self) -> u32 {
        let mut bits = 0u32;
        if self.is_dir {
            bits |= FLAG_DIRECTORY;
        }
        if self.is_in_use {
            bits |= FLAG_IN_USE;
        }
        if self.is_hardlink {
            bits |= FLAG_HARDLINK;
        }
        bits | (self.raw_attributes << 8)
    }

    pub fn from_u32(bits: u32) -> Self {
        Self {
            is_dir: (bits & FLAG_DIRECTORY) != 0,
            is_in_use: (bits & FLAG_IN_USE) != 0,
            is_hardlink: (bits & FLAG_HARDLINK) != 0,
            raw_attributes: bits >> 8,
        }
    }
}

/// Convert Windows FILETIME (100ns units since 1601-01-01) to Unix epoch seconds.
pub fn filetime_to_unix(ft: u64) -> i64 {
    const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if ft < FILETIME_EPOCH_DIFF {
        return 0;
    }
    ((ft - FILETIME_EPOCH_DIFF) / 10_000_000) as i64
}

/// Convert Unix epoch seconds to Windows FILETIME.
pub fn unix_to_filetime(unix: i64) -> u64 {
    const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if unix <= 0 {
        return 0;
    }
    FILETIME_EPOCH_DIFF + (unix as u64 * 10_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entry_flags_roundtrip() {
        let flags = EntryFlags::new(true, true, false, 0x20);
        let bits = flags.to_u32();
        let decoded = EntryFlags::from_u32(bits);
        assert_eq!(flags, decoded);
        assert!(decoded.is_dir);
        assert!(decoded.is_in_use);
        assert!(!decoded.is_hardlink);
        assert_eq!(decoded.raw_attributes, 0x20);
    }

    #[test]
    fn test_filetime_conversion() {
        let ft = 132_000_000_000_000_000u64;
        let unix = filetime_to_unix(ft);
        assert!(unix > 0);
        let back_ft = unix_to_filetime(unix);
        assert!((ft as i64 - back_ft as i64).abs() < 10_000_000);
    }
}
