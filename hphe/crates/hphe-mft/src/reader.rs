//! High-performance NTFS $MFT streaming reader.

use std::fmt;
use std::io;
use std::time::{Duration, Instant};

use crate::boot::{parse_boot_sector, BootSectorError, NtfsBootSector, NTFS_BOOT_SECTOR_SIZE};
use crate::record::{parse_file_record, MftEntry, RecordError, FILE_RECORD_MAGIC};
use crate::runlist::MftExtent;
use crate::volume::{BlockReader, Volume, VolumeError};

/// Default buffer size for streaming MFT records (1 MiB = 1024 records of 1024 bytes).
pub const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct MftScanStats {
    pub total_records: u64,
    pub valid_entries: u64,
    pub directories_count: u64,
    pub files_count: u64,
    pub total_file_size: u64,
    pub duration: Duration,
    pub peak_working_set_bytes: usize,
    pub valid_ratio_pct: f64,
}

#[derive(Debug)]
pub enum MftError {
    Volume(VolumeError),
    BootSector(BootSectorError),
    Record(RecordError),
    Io(io::Error),
    MissingMftDataRunlist,
}

impl fmt::Display for MftError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Volume(e) => write!(f, "Volume error: {e}"),
            Self::BootSector(e) => write!(f, "Boot sector error: {e}"),
            Self::Record(e) => write!(f, "Record error: {e}"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::MissingMftDataRunlist => write!(f, "Record 0 ($MFT) does not contain a valid $DATA runlist"),
        }
    }
}

impl std::error::Error for MftError {}

impl From<VolumeError> for MftError {
    fn from(e: VolumeError) -> Self {
        Self::Volume(e)
    }
}

impl From<BootSectorError> for MftError {
    fn from(e: BootSectorError) -> Self {
        Self::BootSector(e)
    }
}

impl From<RecordError> for MftError {
    fn from(e: RecordError) -> Self {
        Self::Record(e)
    }
}

impl From<io::Error> for MftError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Retrieves current process peak working set size in bytes on Windows.
pub fn get_peak_working_set_bytes() -> usize {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        // SAFETY: Querying memory counters for current process handle.
        unsafe {
            let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let proc = GetCurrentProcess();
            if GetProcessMemoryInfo(proc, &mut pmc as *mut _ as _, pmc.cb) != 0 {
                pmc.PeakWorkingSetSize
            } else {
                0
            }
        }
    }

    #[cfg(not(windows))]
    {
        0
    }
}

/// MFT reader instance holding the boot sector and parsed MFT extents.
pub struct MftReader<R> {
    reader: R,
    boot: NtfsBootSector,
    mft_extents: Vec<MftExtent>,
    mft_real_size: u64,
}

impl MftReader<Volume> {
    /// Opens a live Windows volume (e.g. "C:") and initializes the MFT reader.
    pub fn open_volume(drive: &str) -> Result<Self, MftError> {
        let volume = Volume::open(drive)?;
        Self::from_reader(volume)
    }
}

impl<R: BlockReader> MftReader<R> {
    /// Initializes an MFT reader from any source implementing `BlockReader`.
    pub fn from_reader(mut reader: R) -> Result<Self, MftError> {
        // 1. Read boot sector at offset 0
        let mut boot_buf = vec![0u8; NTFS_BOOT_SECTOR_SIZE];
        reader.read_exact_at(0, &mut boot_buf)?;
        let boot = parse_boot_sector(&boot_buf)?;

        // 2. Read FILE record 0 ($MFT itself)
        let record_size = boot.file_record_size as usize;
        let mft_offset = boot.mft_lcn * boot.cluster_size;
        let mut rec0_buf = vec![0u8; record_size];
        reader.read_exact_at(mft_offset, &mut rec0_buf)?;

        let parsed_rec0 = parse_file_record(&mut rec0_buf, 0)?;
        let mft_extents = parsed_rec0
            .mft_data_runlist
            .ok_or(MftError::MissingMftDataRunlist)?;
        let mft_real_size = parsed_rec0.mft_data_real_size.unwrap_or(0);

        Ok(Self {
            reader,
            boot,
            mft_extents,
            mft_real_size,
        })
    }

    pub fn boot_sector(&self) -> &NtfsBootSector {
        &self.boot
    }

    pub fn mft_extents(&self) -> &[MftExtent] {
        &self.mft_extents
    }

    pub fn mft_real_size(&self) -> u64 {
        self.mft_real_size
    }

    /// Estimated number of MFT records according to $MFT real size.
    pub fn estimated_records_count(&self) -> u64 {
        if self.boot.file_record_size == 0 {
            0
        } else {
            self.mft_real_size / (self.boot.file_record_size as u64)
        }
    }

    /// Streams all FILE records from the MFT and invokes the provided callback on each valid entry.
    pub fn scan_records<F>(&mut self, mut on_entry: F) -> Result<MftScanStats, MftError>
    where
        F: FnMut(MftEntry),
    {
        let start_time = Instant::now();
        let record_size = self.boot.file_record_size as usize;
        let cluster_size = self.boot.cluster_size;

        let mut total_records = 0u64;
        let mut valid_entries = 0u64;
        let mut directories_count = 0u64;
        let mut files_count = 0u64;
        let mut total_file_size = 0u64;

        // Chunk buffer aligned to record_size
        let chunk_size = (DEFAULT_CHUNK_SIZE / record_size) * record_size;
        let mut buffer = vec![0u8; chunk_size];

        let mut current_record_index = 0u64;

        for extent in &self.mft_extents {
            let extent_bytes = extent.clusters * cluster_size;

            let lcn = match extent.lcn {
                Some(l) => l,
                None => {
                    // Sparse extent: records are unallocated/empty
                    let sparse_records = extent_bytes / (record_size as u64);
                    total_records += sparse_records;
                    current_record_index += sparse_records;
                    continue;
                }
            };

            let mut extent_offset = 0u64;
            while extent_offset < extent_bytes {
                let to_read = std::cmp::min((extent_bytes - extent_offset) as usize, chunk_size);
                let disk_offset = lcn * cluster_size + extent_offset;

                self.reader.read_exact_at(disk_offset, &mut buffer[..to_read])?;

                let records_in_chunk = to_read / record_size;
                for i in 0..records_in_chunk {
                    let record_idx = current_record_index;
                    current_record_index += 1;
                    total_records += 1;

                    let rec_start = i * record_size;
                    let rec_end = rec_start + record_size;
                    let rec_slice = &mut buffer[rec_start..rec_end];

                    // Quick signature check
                    if &rec_slice[0..4] != FILE_RECORD_MAGIC {
                        continue;
                    }

                    if let Ok(parsed) = parse_file_record(rec_slice, record_idx) {
                        if let Some(entry) = parsed.entry {
                            if entry.is_in_use {
                                valid_entries += 1;
                                if entry.is_dir {
                                    directories_count += 1;
                                } else {
                                    files_count += 1;
                                    total_file_size += entry.size;
                                }
                                on_entry(entry);
                            }
                        }
                    }
                }

                extent_offset += to_read as u64;
            }
        }

        let duration = start_time.elapsed();
        let peak_working_set_bytes = get_peak_working_set_bytes();
        let valid_ratio_pct = if total_records > 0 {
            (valid_entries as f64 / total_records as f64) * 100.0
        } else {
            0.0
        };

        Ok(MftScanStats {
            total_records,
            valid_entries,
            directories_count,
            files_count,
            total_file_size,
            duration,
            peak_working_set_bytes,
            valid_ratio_pct,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_synthetic_disk() -> Vec<u8> {
        let cluster_size = 4096usize;
        let record_size = 1024usize;
        // Total disk: 10 clusters = 40960 bytes
        let mut disk = vec![0u8; 10 * cluster_size];

        // 1. Boot sector at cluster 0 (offset 0)
        disk[0..3].copy_from_slice(&[0xEB, 0x52, 0x90]);
        disk[3..11].copy_from_slice(b"NTFS    ");
        disk[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes()); // 512 b/sector
        disk[0x0D] = 8; // 8 sectors/cluster = 4096 b/cluster
        disk[0x28..0x30].copy_from_slice(&100_000u64.to_le_bytes());
        disk[0x30..0x38].copy_from_slice(&2u64.to_le_bytes()); // MFT LCN = 2
        disk[0x38..0x40].copy_from_slice(&3u64.to_le_bytes());
        disk[0x40] = 0xF6; // 1024 bytes/record (-10)
        disk[0x48..0x50].copy_from_slice(&0xDEAD_BEEF_CAFE_BABEu64.to_le_bytes());

        // 2. MFT at LCN 2 (offset 2 * 4096 = 8192)
        // Record 0 ($MFT itself)
        let rec0_offset = 2 * cluster_size;
        let mut rec0 = vec![0u8; record_size];
        rec0[0..4].copy_from_slice(FILE_RECORD_MAGIC);
        rec0[4..6].copy_from_slice(&48u16.to_le_bytes());
        rec0[6..8].copy_from_slice(&3u16.to_le_bytes());
        rec0[0x10..0x12].copy_from_slice(&1u16.to_le_bytes());
        rec0[0x14..0x16].copy_from_slice(&56u16.to_le_bytes());
        rec0[0x16..0x18].copy_from_slice(&1u16.to_le_bytes()); // in use

        // Fixup array
        let usn: u16 = 0x55AA;
        rec0[48..50].copy_from_slice(&usn.to_le_bytes());
        rec0[50..52].copy_from_slice(&0x1111u16.to_le_bytes());
        rec0[52..54].copy_from_slice(&0x2222u16.to_le_bytes());
        rec0[510..512].copy_from_slice(&usn.to_le_bytes());
        rec0[1022..1024].copy_from_slice(&usn.to_le_bytes());

        // Attr 1: $FILE_NAME for $MFT
        let mut off = 56;
        let name_u16: Vec<u16> = "$MFT".encode_utf16().collect();
        let fn_val_len = 0x42 + name_u16.len() * 2;
        let fn_attr_len = (24 + fn_val_len + 7) & !7;
        rec0[off..off + 4].copy_from_slice(&crate::record::ATTR_FILE_NAME.to_le_bytes());
        rec0[off + 4..off + 8].copy_from_slice(&(fn_attr_len as u32).to_le_bytes());
        rec0[off + 8] = 0; // resident
        rec0[off + 0x10..off + 0x14].copy_from_slice(&(fn_val_len as u32).to_le_bytes());
        rec0[off + 0x14..off + 0x16].copy_from_slice(&24u16.to_le_bytes());
        let fn_voff = off + 24;
        rec0[fn_voff + 0x40] = name_u16.len() as u8;
        rec0[fn_voff + 0x41] = 3; // Win32 & DOS
        for (i, c) in name_u16.iter().enumerate() {
            rec0[fn_voff + 0x42 + i * 2..fn_voff + 0x44 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        off += fn_attr_len;

        // Attr 2: Non-resident $DATA with runlist for $MFT
        // Extent 1: 1 cluster at LCN 2 (where records 0..3 live)
        // Runlist byte format: header 0x11 (1 len byte, 1 offset byte), len = 1, offset = 2
        let runlist = [0x11, 0x01, 0x02, 0x00];
        let data_attr_len = 72usize;
        rec0[off..off + 4].copy_from_slice(&crate::record::ATTR_DATA.to_le_bytes());
        rec0[off + 4..off + 8].copy_from_slice(&(data_attr_len as u32).to_le_bytes());
        rec0[off + 8] = 1; // non-resident!
        rec0[off + 9] = 0; // unnamed
        rec0[off + 0x20..off + 0x22].copy_from_slice(&64u16.to_le_bytes()); // runlist offset = 64
        let mft_real_sz = 4096u64; // 1 cluster = 4 records
        rec0[off + 0x28..off + 0x30].copy_from_slice(&mft_real_sz.to_le_bytes());
        rec0[off + 0x30..off + 0x38].copy_from_slice(&mft_real_sz.to_le_bytes());
        rec0[off + 64..off + 64 + runlist.len()].copy_from_slice(&runlist);
        off += data_attr_len;

        rec0[off..off + 4].copy_from_slice(&crate::record::ATTR_END_MARKER.to_le_bytes());
        disk[rec0_offset..rec0_offset + record_size].copy_from_slice(&rec0);

        // Record 1: sample valid file
        let rec1_offset = rec0_offset + record_size;
        let mut rec1 = vec![0u8; record_size];
        rec1[0..4].copy_from_slice(FILE_RECORD_MAGIC);
        rec1[4..6].copy_from_slice(&48u16.to_le_bytes());
        rec1[6..8].copy_from_slice(&3u16.to_le_bytes());
        rec1[0x10..0x12].copy_from_slice(&1u16.to_le_bytes());
        rec1[0x14..0x16].copy_from_slice(&56u16.to_le_bytes());
        rec1[0x16..0x18].copy_from_slice(&1u16.to_le_bytes()); // in use

        rec1[48..50].copy_from_slice(&usn.to_le_bytes());
        rec1[50..52].copy_from_slice(&0x3333u16.to_le_bytes());
        rec1[52..54].copy_from_slice(&0x4444u16.to_le_bytes());
        rec1[510..512].copy_from_slice(&usn.to_le_bytes());
        rec1[1022..1024].copy_from_slice(&usn.to_le_bytes());

        let mut off1 = 56;
        let f1_name_u16: Vec<u16> = "kernel.bin".encode_utf16().collect();
        let f1_val_len = 0x42 + f1_name_u16.len() * 2;
        let f1_attr_len = (24 + f1_val_len + 7) & !7;
        rec1[off1..off1 + 4].copy_from_slice(&crate::record::ATTR_FILE_NAME.to_le_bytes());
        rec1[off1 + 4..off1 + 8].copy_from_slice(&(f1_attr_len as u32).to_le_bytes());
        rec1[off1 + 8] = 0;
        rec1[off1 + 0x10..off1 + 0x14].copy_from_slice(&(f1_val_len as u32).to_le_bytes());
        rec1[off1 + 0x14..off1 + 0x16].copy_from_slice(&24u16.to_le_bytes());
        let f1_voff = off1 + 24;
        rec1[f1_voff + 0x30..f1_voff + 0x38].copy_from_slice(&9999u64.to_le_bytes());
        rec1[f1_voff + 0x40] = f1_name_u16.len() as u8;
        rec1[f1_voff + 0x41] = 1; // Win32
        for (i, c) in f1_name_u16.iter().enumerate() {
            rec1[f1_voff + 0x42 + i * 2..f1_voff + 0x44 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        off1 += f1_attr_len;
        rec1[off1..off1 + 4].copy_from_slice(&crate::record::ATTR_END_MARKER.to_le_bytes());
        disk[rec1_offset..rec1_offset + record_size].copy_from_slice(&rec1);

        disk
    }

    #[test]
    fn test_mft_reader_scan() {
        let disk = build_synthetic_disk();
        let cursor = io::Cursor::new(disk);
        let mut reader = MftReader::from_reader(cursor).expect("should initialize from cursor");

        assert_eq!(reader.boot_sector().cluster_size, 4096);
        assert_eq!(reader.mft_extents().len(), 1);
        assert_eq!(reader.mft_extents()[0].lcn, Some(2));
        assert_eq!(reader.mft_real_size(), 4096);

        let mut found_names = Vec::new();
        let stats = reader.scan_records(|entry| {
            found_names.push(entry.name);
        }).expect("scan should succeed");

        assert_eq!(stats.total_records, 4);
        assert_eq!(stats.valid_entries, 2);
        assert_eq!(found_names, vec!["$MFT", "kernel.bin"]);
    }
}
