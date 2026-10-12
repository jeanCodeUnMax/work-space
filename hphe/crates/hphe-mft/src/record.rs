//! NTFS FILE record and attribute parser.

use crate::fixup::{apply_usa_fixup, FixupError};
use crate::runlist::{parse_runlist, MftExtent, RunlistError};

pub const FILE_RECORD_MAGIC: &[u8; 4] = b"FILE";
pub const ATTR_END_MARKER: u32 = 0xFFFF_FFFF;

pub const ATTR_STANDARD_INFORMATION: u32 = 0x10;
pub const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
pub const ATTR_FILE_NAME: u32 = 0x30;
pub const ATTR_DATA: u32 = 0x80;

pub const RECORD_FLAG_IN_USE: u16 = 0x0001;
pub const RECORD_FLAG_DIRECTORY: u16 = 0x0002;

/// File namespace in $FILE_NAME attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FileNameNamespace {
    Dos8_3 = 1,
    Posix = 2,
    Win32AndDos = 3,
    Win32 = 4,
}

impl FileNameNamespace {
    pub fn from_u8(ns: u8) -> Option<Self> {
        match ns {
            0 => Some(Self::Posix),
            1 => Some(Self::Win32),
            2 => Some(Self::Dos8_3),
            3 => Some(Self::Win32AndDos),
            _ => None,
        }
    }
}

/// Extracted metadata from a single FILE record in the $MFT.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MftEntry {
    /// Full 64-bit File Reference Number (sequence << 48 | record_number).
    pub frn: u64,
    /// 48-bit MFT record index.
    pub record_number: u64,
    /// Sequence number.
    pub sequence_number: u16,
    /// Parent directory File Reference Number.
    pub parent_frn: u64,
    /// Parent directory record index (lower 48 bits).
    pub parent_record_number: u64,
    /// File or directory name.
    pub name: String,
    /// Real file size in bytes (0 for directories).
    pub size: u64,
    /// Allocated file size on disk.
    pub allocated_size: u64,
    /// Creation timestamp (Windows FILETIME, 100ns since 1601).
    pub created: u64,
    /// Last modification timestamp (Windows FILETIME).
    pub modified: u64,
    /// Last access timestamp (Windows FILETIME).
    pub accessed: u64,
    /// MFT record change timestamp (Windows FILETIME).
    pub mft_changed: u64,
    /// File attributes (e.g. 0x10 for directory, 0x20 for archive).
    pub attributes: u32,
    /// Whether the entry is a directory.
    pub is_dir: bool,
    /// Whether the record is in use.
    pub is_in_use: bool,
    /// Hard link count.
    pub hard_links: u16,
    /// Base record reference (0 if base record, != 0 if extension record).
    pub base_record_frn: u64,
}

impl MftEntry {
    /// Converts a Windows FILETIME (100ns units since 1601-01-01) to Unix epoch seconds.
    pub fn filetime_to_unix_secs(ft: u64) -> i64 {
        const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;
        if ft < FILETIME_EPOCH_DIFF {
            return 0;
        }
        ((ft - FILETIME_EPOCH_DIFF) / 10_000_000) as i64
    }

    pub fn created_unix_secs(&self) -> i64 {
        Self::filetime_to_unix_secs(self.created)
    }

    pub fn modified_unix_secs(&self) -> i64 {
        Self::filetime_to_unix_secs(self.modified)
    }

    pub fn accessed_unix_secs(&self) -> i64 {
        Self::filetime_to_unix_secs(self.accessed)
    }

    pub fn mft_changed_unix_secs(&self) -> i64 {
        Self::filetime_to_unix_secs(self.mft_changed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordError {
    BufferTooSmall(usize),
    InvalidMagic([u8; 4]),
    FixupFailed(FixupError),
    CorruptedAttributes,
    RunlistParseFailed(RunlistError),
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferTooSmall(sz) => write!(f, "Record buffer too small: {sz} bytes"),
            Self::InvalidMagic(m) => write!(f, "Invalid magic signature: {:?}", String::from_utf8_lossy(m)),
            Self::FixupFailed(e) => write!(f, "USA fixup error: {e}"),
            Self::CorruptedAttributes => write!(f, "Corrupted attribute stream in record"),
            Self::RunlistParseFailed(e) => write!(f, "Failed to parse $DATA runlist: {e}"),
        }
    }
}

impl std::error::Error for RecordError {}

impl From<FixupError> for RecordError {
    fn from(e: FixupError) -> Self {
        Self::FixupFailed(e)
    }
}

impl From<RunlistError> for RecordError {
    fn from(e: RunlistError) -> Self {
        Self::RunlistParseFailed(e)
    }
}

/// Parsed FILE record data including attributes and potential MFT runlist.
pub struct ParsedRecord {
    pub entry: Option<MftEntry>,
    pub mft_data_runlist: Option<Vec<MftExtent>>,
    pub mft_data_real_size: Option<u64>,
}

/// Parses an in-memory FILE record buffer.
///
/// Applies the USA fixup in-place and extracts `MftEntry` attributes.
/// If this is Record #0, also extracts the non-resident $DATA runlist and real size.
pub fn parse_file_record(
    record: &mut [u8],
    mft_record_index: u64,
) -> Result<ParsedRecord, RecordError> {
    if record.len() < 48 {
        return Err(RecordError::BufferTooSmall(record.len()));
    }

    let mut magic = [0u8; 4];
    magic.copy_from_slice(&record[0..4]);
    if &magic != FILE_RECORD_MAGIC {
        return Err(RecordError::InvalidMagic(magic));
    }

    // Apply USA fixup
    apply_usa_fixup(record)?;

    let seq_num = u16::from_le_bytes([record[0x10], record[0x11]]);
    let hard_links = u16::from_le_bytes([record[0x12], record[0x13]]);
    let first_attr_offset = u16::from_le_bytes([record[0x14], record[0x15]]) as usize;
    let flags = u16::from_le_bytes([record[0x16], record[0x17]]);
    let base_record_frn = u64::from_le_bytes(
        record[0x20..0x28].try_into().map_err(|_| RecordError::CorruptedAttributes)?
    );

    let is_in_use = (flags & RECORD_FLAG_IN_USE) != 0;
    let is_dir = (flags & RECORD_FLAG_DIRECTORY) != 0;

    let frn = ((seq_num as u64) << 48) | (mft_record_index & 0x0000_FFFF_FFFF_FFFF);

    let mut mft_data_runlist: Option<Vec<MftExtent>> = None;
    let mut mft_data_real_size: Option<u64> = None;

    let mut std_created = 0u64;
    let mut std_modified = 0u64;
    let mut std_accessed = 0u64;
    let mut std_mft_changed = 0u64;
    let mut std_attrs = 0u32;
    let mut has_std_info = false;

    let mut best_name: Option<String> = None;
    let mut best_name_ns = FileNameNamespace::Dos8_3;
    let mut best_parent_frn = 0u64;
    let mut fn_created = 0u64;
    let mut fn_modified = 0u64;
    let mut fn_accessed = 0u64;
    let mut fn_mft_changed = 0u64;
    let mut fn_real_size = 0u64;
    let mut fn_attrs = 0u32;

    let mut unnamed_data_size: Option<u64> = None;
    let mut unnamed_data_allocated: Option<u64> = None;

    let mut offset = first_attr_offset;
    while offset + 8 <= record.len() {
        let attr_type = u32::from_le_bytes([
            record[offset],
            record[offset + 1],
            record[offset + 2],
            record[offset + 3],
        ]);

        if attr_type == ATTR_END_MARKER {
            break;
        }

        let attr_len = u32::from_le_bytes([
            record[offset + 4],
            record[offset + 5],
            record[offset + 6],
            record[offset + 7],
        ]) as usize;

        if attr_len == 0 || offset + attr_len > record.len() {
            break;
        }

        let non_resident = record[offset + 8] != 0;
        let name_len = record[offset + 9] as usize;

        match attr_type {
            ATTR_STANDARD_INFORMATION if !non_resident => {
                if offset + 0x16 <= record.len() {
                    let val_len = u32::from_le_bytes([
                        record[offset + 0x10],
                        record[offset + 0x11],
                        record[offset + 0x12],
                        record[offset + 0x13],
                    ]) as usize;
                    let val_offset = offset + u16::from_le_bytes([
                        record[offset + 0x14],
                        record[offset + 0x15],
                    ]) as usize;

                    if val_offset + 32 <= record.len() && val_len >= 32 {
                        std_created = u64::from_le_bytes(record[val_offset..val_offset + 8].try_into().unwrap());
                        std_modified = u64::from_le_bytes(record[val_offset + 8..val_offset + 16].try_into().unwrap());
                        std_mft_changed = u64::from_le_bytes(record[val_offset + 16..val_offset + 24].try_into().unwrap());
                        std_accessed = u64::from_le_bytes(record[val_offset + 24..val_offset + 32].try_into().unwrap());

                        if val_offset + 36 <= record.len() && val_len >= 36 {
                            std_attrs = u32::from_le_bytes(record[val_offset + 32..val_offset + 36].try_into().unwrap());
                        }
                        has_std_info = true;
                    }
                }
            }

            ATTR_FILE_NAME if !non_resident => {
                if offset + 0x16 <= record.len() {
                    let val_offset = offset + u16::from_le_bytes([
                        record[offset + 0x14],
                        record[offset + 0x15],
                    ]) as usize;

                    if val_offset + 0x42 <= record.len() {
                        let parent_frn = u64::from_le_bytes(record[val_offset..val_offset + 8].try_into().unwrap());
                        let cur_fn_created = u64::from_le_bytes(record[val_offset + 8..val_offset + 16].try_into().unwrap());
                        let cur_fn_modified = u64::from_le_bytes(record[val_offset + 16..val_offset + 24].try_into().unwrap());
                        let cur_fn_mft_changed = u64::from_le_bytes(record[val_offset + 24..val_offset + 32].try_into().unwrap());
                        let cur_fn_accessed = u64::from_le_bytes(record[val_offset + 32..val_offset + 40].try_into().unwrap());
                        let cur_fn_real_size = u64::from_le_bytes(record[val_offset + 0x30..val_offset + 0x38].try_into().unwrap());
                        let cur_fn_attrs = u32::from_le_bytes(record[val_offset + 0x38..val_offset + 0x3C].try_into().unwrap());

                        let chars_cnt = record[val_offset + 0x40] as usize;
                        let ns_byte = record[val_offset + 0x41];
                        let ns = FileNameNamespace::from_u8(ns_byte).unwrap_or(FileNameNamespace::Dos8_3);

                        let name_bytes_len = chars_cnt * 2;
                        let name_start = val_offset + 0x42;
                        if name_start + name_bytes_len <= record.len() {
                            let u16_chars: Vec<u16> = record[name_start..name_start + name_bytes_len]
                                .chunks_exact(2)
                                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                                .collect();
                            let decoded_name = String::from_utf16_lossy(&u16_chars);

                            let should_replace = match &best_name {
                                None => true,
                                Some(_) => ns > best_name_ns,
                            };

                            if should_replace {
                                best_name = Some(decoded_name);
                                best_name_ns = ns;
                                best_parent_frn = parent_frn;
                                fn_created = cur_fn_created;
                                fn_modified = cur_fn_modified;
                                fn_accessed = cur_fn_accessed;
                                fn_mft_changed = cur_fn_mft_changed;
                                fn_real_size = cur_fn_real_size;
                                fn_attrs = cur_fn_attrs;
                            }
                        }
                    }
                }
            }

            ATTR_DATA if name_len == 0 => {
                // Default unnamed $DATA stream
                if !non_resident {
                    if offset + 0x14 <= record.len() {
                        let val_len = u32::from_le_bytes([
                            record[offset + 0x10],
                            record[offset + 0x11],
                            record[offset + 0x12],
                            record[offset + 0x13],
                        ]) as u64;
                        unnamed_data_size = Some(val_len);
                        unnamed_data_allocated = Some(val_len);
                    }
                } else if offset + 0x38 <= record.len() {
                    let allocated = u64::from_le_bytes(
                        record[offset + 0x28..offset + 0x30].try_into().unwrap()
                    );
                    let real_sz = u64::from_le_bytes(
                        record[offset + 0x30..offset + 0x38].try_into().unwrap()
                    );
                    unnamed_data_allocated = Some(allocated);
                    unnamed_data_size = Some(real_sz);

                    // For Record 0 ($MFT), extract the runlist
                    if mft_record_index == 0 {
                        let runlist_offset = u16::from_le_bytes([
                            record[offset + 0x20],
                            record[offset + 0x21],
                        ]) as usize;

                        if offset + runlist_offset <= offset + attr_len {
                            let rl_bytes = &record[offset + runlist_offset..offset + attr_len];
                            let extents = parse_runlist(rl_bytes)?;
                            mft_data_runlist = Some(extents);
                            mft_data_real_size = Some(real_sz);
                        }
                    }
                }
            }

            _ => {}
        }

        offset += attr_len;
    }

    let entry = if let Some(name) = best_name {
        let size = if is_dir {
            0
        } else {
            unnamed_data_size.unwrap_or(fn_real_size)
        };

        let allocated_size = if is_dir {
            0
        } else {
            unnamed_data_allocated.unwrap_or(size)
        };

        let created = if has_std_info && std_created != 0 { std_created } else { fn_created };
        let modified = if has_std_info && std_modified != 0 { std_modified } else { fn_modified };
        let accessed = if has_std_info && std_accessed != 0 { std_accessed } else { fn_accessed };
        let mft_changed = if has_std_info && std_mft_changed != 0 { std_mft_changed } else { fn_mft_changed };
        let attributes = if has_std_info && std_attrs != 0 { std_attrs } else { fn_attrs };

        Some(MftEntry {
            frn,
            record_number: mft_record_index,
            sequence_number: seq_num,
            parent_frn: best_parent_frn,
            parent_record_number: best_parent_frn & 0x0000_FFFF_FFFF_FFFF,
            name,
            size,
            allocated_size,
            created,
            modified,
            accessed,
            mft_changed,
            attributes,
            is_dir,
            is_in_use,
            hard_links,
            base_record_frn,
        })
    } else {
        None
    };

    Ok(ParsedRecord {
        entry,
        mft_data_runlist,
        mft_data_real_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_record(name_str: &str, is_dir: bool, size: u64) -> Vec<u8> {
        let mut buf = vec![0u8; 1024];
        buf[0..4].copy_from_slice(FILE_RECORD_MAGIC);
        // USA offset = 48, count = 3
        buf[4..6].copy_from_slice(&48u16.to_le_bytes());
        buf[6..8].copy_from_slice(&3u16.to_le_bytes());
        // Seq num = 1
        buf[0x10..0x12].copy_from_slice(&1u16.to_le_bytes());
        // First attr offset = 56
        buf[0x14..0x16].copy_from_slice(&56u16.to_le_bytes());
        // Flags: IN_USE | (DIRECTORY if is_dir)
        let flags = RECORD_FLAG_IN_USE | if is_dir { RECORD_FLAG_DIRECTORY } else { 0 };
        buf[0x16..0x18].copy_from_slice(&flags.to_le_bytes());

        // USN setup for USA fixup:
        let usn: u16 = 0x1234;
        buf[48..50].copy_from_slice(&usn.to_le_bytes());
        buf[50..52].copy_from_slice(&0xAAAAu16.to_le_bytes());
        buf[52..54].copy_from_slice(&0xBBBBu16.to_le_bytes());
        buf[510..512].copy_from_slice(&usn.to_le_bytes());
        buf[1022..1024].copy_from_slice(&usn.to_le_bytes());

        let mut offset = 56;

        // Attribute 1: $STANDARD_INFORMATION (0x10)
        let std_len = 72usize;
        buf[offset..offset + 4].copy_from_slice(&ATTR_STANDARD_INFORMATION.to_le_bytes());
        buf[offset + 4..offset + 8].copy_from_slice(&(std_len as u32).to_le_bytes());
        buf[offset + 8] = 0; // resident
        buf[offset + 0x10..offset + 0x14].copy_from_slice(&48u32.to_le_bytes()); // val len
        buf[offset + 0x14..offset + 0x16].copy_from_slice(&24u16.to_le_bytes()); // val offset
        let val_off = offset + 24;
        buf[val_off..val_off + 8].copy_from_slice(&132_000_000_000_000_000u64.to_le_bytes()); // created
        buf[val_off + 8..val_off + 16].copy_from_slice(&133_000_000_000_000_000u64.to_le_bytes()); // modified
        buf[val_off + 16..val_off + 24].copy_from_slice(&133_000_000_000_000_000u64.to_le_bytes()); // mft_changed
        buf[val_off + 24..val_off + 32].copy_from_slice(&134_000_000_000_000_000u64.to_le_bytes()); // accessed
        buf[val_off + 32..val_off + 36].copy_from_slice(&0x20u32.to_le_bytes()); // archive
        offset += std_len;

        // Attribute 2: $FILE_NAME (0x30)
        let name_u16: Vec<u16> = name_str.encode_utf16().collect();
        let name_bytes_len = name_u16.len() * 2;
        let fn_val_len = 0x42 + name_bytes_len;
        let fn_attr_len = (24 + fn_val_len + 7) & !7; // 8-byte aligned

        buf[offset..offset + 4].copy_from_slice(&ATTR_FILE_NAME.to_le_bytes());
        buf[offset + 4..offset + 8].copy_from_slice(&(fn_attr_len as u32).to_le_bytes());
        buf[offset + 8] = 0; // resident
        buf[offset + 0x10..offset + 0x14].copy_from_slice(&(fn_val_len as u32).to_le_bytes());
        buf[offset + 0x14..offset + 0x16].copy_from_slice(&24u16.to_le_bytes());
        let fn_val_off = offset + 24;
        buf[fn_val_off..fn_val_off + 8].copy_from_slice(&5u64.to_le_bytes()); // parent FRN = 5 (root dir)
        buf[fn_val_off + 0x30..fn_val_off + 0x38].copy_from_slice(&size.to_le_bytes());
        buf[fn_val_off + 0x40] = name_u16.len() as u8;
        buf[fn_val_off + 0x41] = 3; // Win32 & DOS namespace
        for (i, ch) in name_u16.iter().enumerate() {
            buf[fn_val_off + 0x42 + i * 2..fn_val_off + 0x44 + i * 2].copy_from_slice(&ch.to_le_bytes());
        }
        offset += fn_attr_len;

        // Attribute 3: $DATA (0x80) resident if not dir
        if !is_dir {
            let data_attr_len = 32;
            buf[offset..offset + 4].copy_from_slice(&ATTR_DATA.to_le_bytes());
            buf[offset + 4..offset + 8].copy_from_slice(&(data_attr_len as u32).to_le_bytes());
            buf[offset + 8] = 0; // resident
            buf[offset + 9] = 0; // unnamed
            buf[offset + 0x10..offset + 0x14].copy_from_slice(&(size as u32).to_le_bytes());
            buf[offset + 0x14..offset + 0x16].copy_from_slice(&24u16.to_le_bytes());
            offset += data_attr_len;
        }

        // End marker
        buf[offset..offset + 4].copy_from_slice(&ATTR_END_MARKER.to_le_bytes());

        buf
    }

    #[test]
    fn test_parse_file_record() {
        let mut buf = build_test_record("test_file.txt", false, 12345);
        let parsed = parse_file_record(&mut buf, 42).expect("should parse");
        let entry = parsed.entry.expect("should have entry");

        assert_eq!(entry.name, "test_file.txt");
        assert_eq!(entry.record_number, 42);
        assert_eq!(entry.sequence_number, 1);
        assert_eq!(entry.parent_record_number, 5);
        assert_eq!(entry.size, 12345);
        assert!(!entry.is_dir);
        assert!(entry.is_in_use);
        assert_eq!(entry.attributes, 0x20);
        assert_eq!(entry.created, 132_000_000_000_000_000);
    }

    #[test]
    fn test_filetime_to_unix() {
        // 2026-10-12 approx: 134_350_000_000_000_000
        let ft = 132_000_000_000_000_000u64;
        let unix = MftEntry::filetime_to_unix_secs(ft);
        assert!(unix > 0);
    }
}
