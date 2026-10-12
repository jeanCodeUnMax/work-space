//! # hphe-mft: High-Performance NTFS $MFT Direct Reader
//!
//! Autonomous, low-latency NTFS MFT parser and streamer for the Hephaistos engine.
//! Bypasses Windows filesystem traversal by directly reading raw NTFS volumes (`\\.\X:`),
//! parsing the master boot record / BPB, resolving non-resident $DATA runlists for `$MFT`,
//! applying Update Sequence Array (USA) fixups, and extracting file records.

pub mod boot;
pub mod fixup;
pub mod reader;
pub mod record;
pub mod runlist;
pub mod volume;

pub use boot::{parse_boot_sector, BootSectorError, NtfsBootSector};
pub use fixup::{apply_usa_fixup, FixupError};
pub use reader::{get_peak_working_set_bytes, MftError, MftReader, MftScanStats};
pub use record::{parse_file_record, FileNameNamespace, MftEntry, RecordError};
pub use runlist::{parse_runlist, MftExtent, RunlistError};
pub use volume::{BlockReader, Volume, VolumeError};
