//! Binary snapshot persistence and zero-copy memory-mapped loading for `FileIndex`.
//!
//! Provides atomic snapshot writes (temp file + fsync + atomic rename) and
//! instant memory-mapped loads (<2s cold start @16M entries) with per-column CRC32
//! checksum validation and automatic fallback to rebuilding on corruption.

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rayon::prelude::*;

use crate::{FileIndex, FileIndexStats, IndexError};

/// Magic identifier at start of file: "HPHE" (HePHEistos Engine).
pub const SNAPSHOT_MAGIC: [u8; 4] = *b"HPHE";

/// Current format version.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Fixed header size padded to 512 bytes (sector-aligned).
pub const HEADER_SIZE: usize = 512;

/// Alignment for column sections (64 bytes = cache line / AVX-512 boundary).
pub const SECTION_ALIGNMENT: usize = 64;

/// Number of SoA column sections in the snapshot format.
pub const NUM_SECTIONS: usize = 11;

/// Human-readable section names for diagnostics and error reports.
pub const SECTION_NAMES: [&str; NUM_SECTIONS] = [
    "name_blob",
    "name_offsets",
    "name_lower_blob",
    "name_lower_offsets",
    "frn",
    "parent_frn",
    "size",
    "created",
    "modified",
    "accessed",
    "flags",
];

// Precomputed CRC32 table (IEEE 802.3 polynomial 0xEDB88320)
const CRC32_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut j = 0;
        while j < 8 {
            if c & 1 != 0 {
                c = 0xEDB8_8320 ^ (c >> 1);
            } else {
                c >>= 1;
            }
            j += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// Computes IEEE 802.3 CRC32 checksum for arbitrary byte slices.
#[inline]
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc = CRC32_TABLE[((crc ^ (b as u32)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// Header for an individual aligned column section.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SectionHeader {
    /// File offset where section begins (must be multiple of 64).
    pub offset: u64,
    /// Total byte length of the section.
    pub byte_len: u64,
    /// Number of elements stored.
    pub element_count: u64,
    /// CRC32 checksum of the raw section bytes.
    pub checksum: u32,
    /// Element size in bytes (1 for u8, 4 for u32, 8 for u64).
    pub element_size: u32,
}

impl SectionHeader {
    pub fn to_bytes(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&self.offset.to_le_bytes());
        buf[8..16].copy_from_slice(&self.byte_len.to_le_bytes());
        buf[16..24].copy_from_slice(&self.element_count.to_le_bytes());
        buf[24..28].copy_from_slice(&self.checksum.to_le_bytes());
        buf[28..32].copy_from_slice(&self.element_size.to_le_bytes());
        buf
    }

    pub fn from_bytes(buf: &[u8; 32]) -> Self {
        Self {
            offset: u64::from_le_bytes(buf[0..8].try_into().unwrap()),
            byte_len: u64::from_le_bytes(buf[8..16].try_into().unwrap()),
            element_count: u64::from_le_bytes(buf[16..24].try_into().unwrap()),
            checksum: u32::from_le_bytes(buf[24..28].try_into().unwrap()),
            element_size: u32::from_le_bytes(buf[28..32].try_into().unwrap()),
        }
    }
}

/// Fixed 512-byte snapshot header.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotHeader {
    pub magic: [u8; 4],
    pub version: u32,
    pub drive_letter: u8,
    pub _reserved1: [u8; 7],
    pub entry_count: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub total_size: u64,
    pub created_unix: u64,
    pub header_checksum: u32,
    pub _reserved2: u32,
    pub sections: [SectionHeader; NUM_SECTIONS],
    pub _padding: [u8; 96],
}

impl Default for SnapshotHeader {
    fn default() -> Self {
        Self {
            magic: SNAPSHOT_MAGIC,
            version: SNAPSHOT_VERSION,
            drive_letter: b'C',
            _reserved1: [0u8; 7],
            entry_count: 0,
            file_count: 0,
            dir_count: 0,
            total_size: 0,
            created_unix: 0,
            header_checksum: 0,
            _reserved2: 0,
            sections: [SectionHeader::default(); NUM_SECTIONS],
            _padding: [0u8; 96],
        }
    }
}

impl SnapshotHeader {
    pub fn to_bytes(&self) -> [u8; HEADER_SIZE] {
        let mut buf = [0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(&self.magic);
        buf[4..8].copy_from_slice(&self.version.to_le_bytes());
        buf[8] = self.drive_letter;
        buf[9..16].copy_from_slice(&self._reserved1);
        buf[16..24].copy_from_slice(&self.entry_count.to_le_bytes());
        buf[24..32].copy_from_slice(&self.file_count.to_le_bytes());
        buf[32..40].copy_from_slice(&self.dir_count.to_le_bytes());
        buf[40..48].copy_from_slice(&self.total_size.to_le_bytes());
        buf[48..56].copy_from_slice(&self.created_unix.to_le_bytes());
        buf[56..60].copy_from_slice(&self.header_checksum.to_le_bytes());
        buf[60..64].copy_from_slice(&self._reserved2.to_le_bytes());

        let mut offset = 64;
        for sec in &self.sections {
            buf[offset..offset + 32].copy_from_slice(&sec.to_bytes());
            offset += 32;
        }
        buf[offset..offset + 96].copy_from_slice(&self._padding);
        buf
    }

    pub fn from_bytes(buf: &[u8; HEADER_SIZE]) -> Self {
        let magic = [buf[0], buf[1], buf[2], buf[3]];
        let version = u32::from_le_bytes(buf[4..8].try_into().unwrap());
        let drive_letter = buf[8];
        let mut _reserved1 = [0u8; 7];
        _reserved1.copy_from_slice(&buf[9..16]);
        let entry_count = u64::from_le_bytes(buf[16..24].try_into().unwrap());
        let file_count = u64::from_le_bytes(buf[24..32].try_into().unwrap());
        let dir_count = u64::from_le_bytes(buf[32..40].try_into().unwrap());
        let total_size = u64::from_le_bytes(buf[40..48].try_into().unwrap());
        let created_unix = u64::from_le_bytes(buf[48..56].try_into().unwrap());
        let header_checksum = u32::from_le_bytes(buf[56..60].try_into().unwrap());
        let _reserved2 = u32::from_le_bytes(buf[60..64].try_into().unwrap());

        let mut sections = [SectionHeader::default(); NUM_SECTIONS];
        let mut offset = 64;
        for i in 0..NUM_SECTIONS {
            let mut sec_buf = [0u8; 32];
            sec_buf.copy_from_slice(&buf[offset..offset + 32]);
            sections[i] = SectionHeader::from_bytes(&sec_buf);
            offset += 32;
        }

        let mut _padding = [0u8; 96];
        _padding.copy_from_slice(&buf[offset..offset + 96]);

        Self {
            magic,
            version,
            drive_letter,
            _reserved1,
            entry_count,
            file_count,
            dir_count,
            total_size,
            created_unix,
            header_checksum,
            _reserved2,
            sections,
            _padding,
        }
    }
}

/// Column container that either holds an owned heap vector or borrows
/// directly from a memory-mapped file without copying.
#[derive(Clone)]
pub enum Column<T: 'static> {
    Owned(Vec<T>),
    Mmap {
        mmap: Arc<memmap2::Mmap>,
        ptr: *const T,
        len: usize,
    },
}

impl<T: 'static> Column<T> {
    /// Creates an empty column.
    pub fn empty() -> Self {
        Column::Owned(Vec::new())
    }

    /// Whether this column is backed by a memory map.
    pub fn is_mmap(&self) -> bool {
        matches!(self, Column::Mmap { .. })
    }

    /// Total capacity / byte allocation for statistics.
    pub fn capacity_bytes(&self) -> usize {
        match self {
            Column::Owned(v) => v.capacity() * std::mem::size_of::<T>(),
            Column::Mmap { len, .. } => *len * std::mem::size_of::<T>(),
        }
    }

    /// Creates a column borrowing from an mmap region.
    ///
    /// # Safety
    /// - `offset + len * size_of::<T>() <= mmap.len()`.
    /// - `(mmap.as_ptr().add(offset) as usize) % align_of::<T>() == 0`.
    /// - `T` must be a plain numeric type (`u8`, `u32`, `u64`) where all bit patterns are valid.
    pub unsafe fn from_mmap(
        mmap: Arc<memmap2::Mmap>,
        offset: usize,
        len: usize,
    ) -> Result<Self, SnapshotError> {
        let elem_size = std::mem::size_of::<T>();
        let align = std::mem::align_of::<T>();
        let total_bytes = len.checked_mul(elem_size).ok_or_else(|| {
            SnapshotError::InvalidFormat("Integer overflow calculating column size".into())
        })?;

        if offset + total_bytes > mmap.len() {
            return Err(SnapshotError::InvalidFormat(format!(
                "Section offset {} + {} bytes exceeds mapped file length {}",
                offset,
                total_bytes,
                mmap.len()
            )));
        }

        let ptr = mmap.as_ptr().add(offset);
        if (ptr as usize) % align != 0 {
            return Err(SnapshotError::InvalidFormat(format!(
                "Section pointer {:p} not aligned to {} bytes",
                ptr, align
            )));
        }

        Ok(Column::Mmap {
            mmap,
            ptr: ptr as *const T,
            len,
        })
    }
}

impl<T> Deref for Column<T> {
    type Target = [T];
    #[inline]
    fn deref(&self) -> &[T] {
        match self {
            Column::Owned(v) => v.as_slice(),
            Column::Mmap { ptr, len, .. } => {
                // SAFETY: `ptr` is aligned, points to `len` valid elements of `T`,
                // and the backing memory is kept alive by `mmap: Arc<memmap2::Mmap>` in `self`.
                unsafe { std::slice::from_raw_parts(*ptr, *len) }
            }
        }
    }
}

impl<T> From<Vec<T>> for Column<T> {
    fn from(v: Vec<T>) -> Self {
        Column::Owned(v)
    }
}

impl<T: fmt::Debug> fmt::Debug for Column<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Column(len={}, mmap={})",
            self.len(),
            self.is_mmap()
        )
    }
}

// SAFETY: Primitive types u8, u32, u64 are Send and Sync. Column can be sent
// and shared across threads because mmap memory is read-only.
unsafe impl<T: Send + Sync> Send for Column<T> {}
unsafe impl<T: Send + Sync> Sync for Column<T> {}

/// Error conditions for snapshot persistence and loading.
#[derive(Debug)]
pub enum SnapshotError {
    Io(std::io::Error),
    InvalidMagic([u8; 4]),
    VersionMismatch {
        expected: u32,
        found: u32,
    },
    HeaderChecksumMismatch {
        expected: u32,
        found: u32,
    },
    ChecksumMismatch {
        section: &'static str,
        expected: u32,
        found: u32,
    },
    InvalidFormat(String),
    Corrupted(String),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "Snapshot I/O error: {e}"),
            Self::InvalidMagic(m) => write!(
                f,
                "Invalid snapshot magic: {:?} (expected {:?})",
                String::from_utf8_lossy(m),
                "HPHE"
            ),
            Self::VersionMismatch { expected, found } => write!(
                f,
                "Snapshot version mismatch: expected {expected}, found {found}"
            ),
            Self::HeaderChecksumMismatch { expected, found } => write!(
                f,
                "Snapshot header checksum mismatch: expected {expected:#010X}, found {found:#010X}"
            ),
            Self::ChecksumMismatch {
                section,
                expected,
                found,
            } => write!(
                f,
                "Snapshot section '{section}' checksum mismatch: expected {expected:#010X}, found {found:#010X}"
            ),
            Self::InvalidFormat(msg) => write!(f, "Invalid snapshot format: {msg}"),
            Self::Corrupted(msg) => write!(f, "Corrupted snapshot file: {msg}"),
        }
    }
}

impl std::error::Error for SnapshotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for SnapshotError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<SnapshotError> for IndexError {
    fn from(e: SnapshotError) -> Self {
        IndexError::Io(e.to_string())
    }
}

/// Helper: casts a slice of plain-old-data `T` to a byte slice.
fn slice_as_bytes<T: Copy>(slice: &[T]) -> &[u8] {
    // SAFETY: T is Copy (u8, u32, u64) without padding or uninitialized memory.
    unsafe {
        std::slice::from_raw_parts(
            slice.as_ptr() as *const u8,
            slice.len() * std::mem::size_of::<T>(),
        )
    }
}

/// Helper: rounds up `offset` to the nearest multiple of `align`.
fn align_up(offset: usize, align: usize) -> usize {
    (offset + align - 1) & !(align - 1)
}

/// Saves the index to a snapshot file using atomic write (temp file + fsync + rename).
pub fn save_index(index: &FileIndex, path: &Path) -> Result<(), SnapshotError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let file_stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("hphe_index");
    let tmp_path = if let Some(parent) = path.parent() {
        parent.join(format!("{}.tmp.{}", file_stem, std::process::id()))
    } else {
        PathBuf::from(format!("{}.tmp.{}", file_stem, std::process::id()))
    };

    let write_result = (|| -> Result<(), SnapshotError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;

        // Collect slices for the 11 columns
        let col0 = index.name_blob_slice();
        let col1 = index.name_offsets_slice();
        let col2 = index.name_lower_blob_slice();
        let col3 = index.name_lower_offsets_slice();
        let col4 = index.frn_slice();
        let col5 = index.parent_frn_slice();
        let col6 = index.size_slice();
        let col7 = index.created_slice();
        let col8 = index.modified_slice();
        let col9 = index.accessed_slice();
        let col10 = index.flags_slice();

        let raw_slices: [&[u8]; NUM_SECTIONS] = [
            col0,
            slice_as_bytes(col1),
            col2,
            slice_as_bytes(col3),
            slice_as_bytes(col4),
            slice_as_bytes(col5),
            slice_as_bytes(col6),
            slice_as_bytes(col7),
            slice_as_bytes(col8),
            slice_as_bytes(col9),
            slice_as_bytes(col10),
        ];

        let elem_counts = [
            col0.len(),
            col1.len(),
            col2.len(),
            col3.len(),
            col4.len(),
            col5.len(),
            col6.len(),
            col7.len(),
            col8.len(),
            col9.len(),
            col10.len(),
        ];

        let elem_sizes = [1, 4, 1, 4, 8, 8, 8, 8, 8, 8, 4];

        // Compute checksums in parallel across sections
        let checksums: Vec<u32> = raw_slices
            .par_iter()
            .map(|slice| crc32(slice))
            .collect();

        // Calculate layout with 64-byte alignment
        let mut sections = [SectionHeader::default(); NUM_SECTIONS];
        let mut current_offset = HEADER_SIZE;

        for i in 0..NUM_SECTIONS {
            current_offset = align_up(current_offset, SECTION_ALIGNMENT);
            let byte_len = raw_slices[i].len();
            sections[i] = SectionHeader {
                offset: current_offset as u64,
                byte_len: byte_len as u64,
                element_count: elem_counts[i] as u64,
                checksum: checksums[i],
                element_size: elem_sizes[i],
            };
            current_offset += byte_len;
        }

        let stats = index.stats();
        let created_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut header = SnapshotHeader {
            magic: SNAPSHOT_MAGIC,
            version: SNAPSHOT_VERSION,
            drive_letter: index.drive_letter() as u8,
            _reserved1: [0u8; 7],
            entry_count: index.len() as u64,
            file_count: stats.file_count as u64,
            dir_count: stats.dir_count as u64,
            total_size: stats.total_size,
            created_unix,
            header_checksum: 0,
            _reserved2: 0,
            sections,
            _padding: [0u8; 96],
        };

        header.header_checksum = crc32(&header.to_bytes());

        // Write header
        file.write_all(&header.to_bytes())?;

        // Write sections with alignment padding
        let mut file_pos = HEADER_SIZE;
        for i in 0..NUM_SECTIONS {
            let target_offset = sections[i].offset as usize;
            if target_offset > file_pos {
                let pad = target_offset - file_pos;
                let zeroes = [0u8; 64];
                let mut remaining = pad;
                while remaining > 0 {
                    let chunk = remaining.min(zeroes.len());
                    file.write_all(&zeroes[..chunk])?;
                    remaining -= chunk;
                }
                file_pos = target_offset;
            }
            file.write_all(raw_slices[i])?;
            file_pos += raw_slices[i].len();
        }

        // Flush and fsync to ensure data is physically committed to storage
        file.flush()?;
        file.sync_all()?;
        drop(file);

        // Atomic replace / rename
        atomic_rename(&tmp_path, path)?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp_path);
    }

    write_result
}

/// Atomically replaces destination path with the source file.
fn atomic_rename(from: &Path, to: &Path) -> Result<(), SnapshotError> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) => {
            if to.exists() {
                let _ = std::fs::remove_file(to);
                std::fs::rename(from, to).map_err(SnapshotError::Io)
            } else {
                Err(SnapshotError::Io(e))
            }
        }
    }
}

/// Loads a `FileIndex` from a snapshot file using memory mapping without copying column data.
pub fn load_index_mmap(path: &Path) -> Result<FileIndex, SnapshotError> {
    if !path.exists() {
        return Err(SnapshotError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("Snapshot file not found: {}", path.display()),
        )));
    }

    let file = File::open(path)?;
    let metadata = file.metadata()?;
    let file_len = metadata.len() as usize;

    if file_len < HEADER_SIZE {
        return Err(SnapshotError::Corrupted(format!(
            "Snapshot file length {file_len} bytes is smaller than header size {HEADER_SIZE}"
        )));
    }

    // SAFETY: Read-only memory map over an existing verified file.
    let mmap = unsafe { memmap2::Mmap::map(&file)? };
    let mmap_arc = Arc::new(mmap);

    let mut header_bytes = [0u8; HEADER_SIZE];
    header_bytes.copy_from_slice(&mmap_arc[0..HEADER_SIZE]);
    let header = SnapshotHeader::from_bytes(&header_bytes);

    if header.magic != SNAPSHOT_MAGIC {
        return Err(SnapshotError::InvalidMagic(header.magic));
    }

    if header.version != SNAPSHOT_VERSION {
        return Err(SnapshotError::VersionMismatch {
            expected: SNAPSHOT_VERSION,
            found: header.version,
        });
    }

    // Verify header checksum
    let mut header_zeroed = header;
    header_zeroed.header_checksum = 0;
    let computed_header_crc = crc32(&header_zeroed.to_bytes());
    if computed_header_crc != header.header_checksum {
        return Err(SnapshotError::HeaderChecksumMismatch {
            expected: header.header_checksum,
            found: computed_header_crc,
        });
    }

    // Verify sections and column checksums in parallel
    header
        .sections
        .par_iter()
        .enumerate()
        .try_for_each(|(idx, sec)| {
            let name = SECTION_NAMES[idx];
            if sec.offset < HEADER_SIZE as u64 {
                return Err(SnapshotError::InvalidFormat(format!(
                    "Section {name} offset {} inside header",
                    sec.offset
                )));
            }
            let end = sec.offset.checked_add(sec.byte_len).ok_or_else(|| {
                SnapshotError::InvalidFormat(format!("Section {name} offset overflow"))
            })?;
            if end > file_len as u64 {
                return Err(SnapshotError::Corrupted(format!(
                    "Section {name} end {end} exceeds file length {file_len}"
                )));
            }
            if (sec.offset as usize) % SECTION_ALIGNMENT != 0 {
                return Err(SnapshotError::InvalidFormat(format!(
                    "Section {name} offset {} not aligned to {SECTION_ALIGNMENT}",
                    sec.offset
                )));
            }
            let expected_bytes = sec
                .element_count
                .checked_mul(sec.element_size as u64)
                .ok_or_else(|| {
                    SnapshotError::InvalidFormat(format!("Section {name} size overflow"))
                })?;
            if sec.byte_len != expected_bytes {
                return Err(SnapshotError::InvalidFormat(format!(
                    "Section {name} byte_len {} != element_count {} * element_size {}",
                    sec.byte_len, sec.element_count, sec.element_size
                )));
            }

            let section_bytes = &mmap_arc[sec.offset as usize..end as usize];
            let computed_crc = crc32(section_bytes);
            if computed_crc != sec.checksum {
                return Err(SnapshotError::ChecksumMismatch {
                    section: name,
                    expected: sec.checksum,
                    found: computed_crc,
                });
            }

            Ok(())
        })?;

    // SAFETY: We verified bounds, offsets, alignment, and CRC32 checksums for each section.
    let name_blob = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[0].offset as usize,
            header.sections[0].element_count as usize,
        )?
    };
    let name_offsets = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[1].offset as usize,
            header.sections[1].element_count as usize,
        )?
    };
    let name_lower_blob = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[2].offset as usize,
            header.sections[2].element_count as usize,
        )?
    };
    let name_lower_offsets = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[3].offset as usize,
            header.sections[3].element_count as usize,
        )?
    };
    let frn = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[4].offset as usize,
            header.sections[4].element_count as usize,
        )?
    };
    let parent_frn = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[5].offset as usize,
            header.sections[5].element_count as usize,
        )?
    };
    let size = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[6].offset as usize,
            header.sections[6].element_count as usize,
        )?
    };
    let created = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[7].offset as usize,
            header.sections[7].element_count as usize,
        )?
    };
    let modified = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[8].offset as usize,
            header.sections[8].element_count as usize,
        )?
    };
    let accessed = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[9].offset as usize,
            header.sections[9].element_count as usize,
        )?
    };
    let flags = unsafe {
        Column::from_mmap(
            mmap_arc.clone(),
            header.sections[10].offset as usize,
            header.sections[10].element_count as usize,
        )?
    };

    let entry_count = header.entry_count as usize;
    let mut frn_to_row = hashbrown::HashMap::with_capacity(entry_count);
    for (row, &f) in frn.iter().enumerate() {
        frn_to_row.insert(f, row as u32);
    }

    let avg_name_length = if entry_count > 0 {
        name_blob.len() as f64 / entry_count as f64
    } else {
        0.0
    };

    let stats = FileIndexStats {
        entry_count,
        file_count: header.file_count as usize,
        dir_count: header.dir_count as usize,
        total_size: header.total_size,
        memory_usage_bytes: 0,
        build_time_ms: 0,
        avg_name_length,
    };

    let drive_char = (header.drive_letter as char).to_ascii_uppercase();

    let mut index = FileIndex::from_columns(
        name_blob,
        name_offsets,
        name_lower_blob,
        name_lower_offsets,
        frn,
        parent_frn,
        size,
        created,
        modified,
        accessed,
        flags,
        drive_char,
        frn_to_row,
        stats,
    );
    index.update_memory_usage();
    Ok(index)
}

/// Attempts to load the index from a snapshot; on missing file or corruption,
/// falls back to rebuilding the index and saving a fresh snapshot.
pub fn load_or_rebuild_index<P, F>(path: P, rebuild: F) -> Result<FileIndex, IndexError>
where
    P: AsRef<Path>,
    F: FnOnce() -> Result<FileIndex, IndexError>,
{
    let p = path.as_ref();
    match load_index_mmap(p) {
        Ok(idx) => Ok(idx),
        Err(err) => {
            eprintln!(
                "[hphe-index] Snapshot load failed for '{}': {}. Rebuilding index...",
                p.display(),
                err
            );
            let index = rebuild()?;
            if let Err(save_err) = save_index(&index, p) {
                eprintln!(
                    "[hphe-index] Warning: Failed to save snapshot to '{}': {}",
                    p.display(),
                    save_err
                );
            }
            Ok(index)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hphe_mft::record::MftEntry;

    fn make_entry(frn: u64, parent_frn: u64, name: &str, is_dir: bool, size: u64) -> MftEntry {
        MftEntry {
            frn,
            record_number: frn & 0x0000_FFFF_FFFF_FFFF,
            sequence_number: 1,
            parent_frn,
            parent_record_number: parent_frn & 0x0000_FFFF_FFFF_FFFF,
            name: name.to_string(),
            size,
            allocated_size: size,
            created: 132_000_000_000_000_000,
            modified: 133_000_000_000_000_000,
            accessed: 134_000_000_000_000_000,
            mft_changed: 133_000_000_000_000_000,
            attributes: if is_dir { 0x10 } else { 0x20 },
            is_dir,
            is_in_use: true,
            hard_links: 1,
            base_record_frn: 0,
        }
    }

    #[test]
    fn test_crc32_standard() {
        assert_eq!(crc32(b"123456789"), 0xCBF43926);
    }

    #[test]
    fn test_snapshot_roundtrip() {
        let entries = vec![
            make_entry(5, 5, "C:", true, 0),
            make_entry(10, 5, "Windows", true, 0),
            make_entry(20, 10, "System32", true, 0),
            make_entry(30, 20, "kernel32.dll", false, 1_000_000),
            make_entry(40, 20, "user32.dll", false, 800_000),
            make_entry(50, 5, "autoexec.bat", false, 25),
        ];

        let index = FileIndex::build_with_drive("C:", entries);
        let temp_dir = std::env::temp_dir().join(format!("hphe_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let snap_path = temp_dir.join("test_roundtrip.snap");

        index.save(&snap_path).expect("save must succeed");
        assert!(snap_path.exists());

        let loaded = FileIndex::load_mmap(&snap_path).expect("load_mmap must succeed");

        assert_eq!(loaded.len(), index.len());
        assert_eq!(loaded.drive_letter(), 'C');
        assert!(loaded.is_mmap());

        for row in 0..index.len() {
            assert_eq!(loaded.name(row), index.name(row));
            assert_eq!(loaded.name_lower(row), index.name_lower(row));
            assert_eq!(loaded.frn(row), index.frn(row));
            assert_eq!(loaded.parent_frn(row), index.parent_frn(row));
            assert_eq!(loaded.size(row), index.size(row));
            assert_eq!(loaded.is_dir(row), index.is_dir(row));
            assert_eq!(loaded.resolve_path(row), index.resolve_path(row));
        }

        let query_res: Vec<usize> = loaded.find("32").collect();
        assert_eq!(query_res.len(), 3); // System32, kernel32.dll, user32.dll

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_corruption_detection() {
        let entries = vec![
            make_entry(5, 5, "C:", true, 0),
            make_entry(10, 5, "file.txt", false, 123),
        ];
        let index = FileIndex::build(entries);
        let temp_dir = std::env::temp_dir().join(format!("hphe_test_corrupt_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let snap_path = temp_dir.join("corrupt.snap");

        index.save(&snap_path).expect("save must succeed");

        // Corrupt a byte in the column payload (after the 512-byte header)
        let mut bytes = std::fs::read(&snap_path).unwrap();
        let corrupt_idx = 520.min(bytes.len() - 1);
        bytes[corrupt_idx] ^= 0xFF;
        std::fs::write(&snap_path, &bytes).unwrap();

        let load_res = FileIndex::load_mmap(&snap_path);
        assert!(
            matches!(load_res, Err(SnapshotError::ChecksumMismatch { .. })),
            "Expected ChecksumMismatch, got: {:?}",
            load_res
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_version_mismatch() {
        let entries = vec![make_entry(5, 5, "C:", true, 0)];
        let index = FileIndex::build(entries);
        let temp_dir = std::env::temp_dir().join(format!("hphe_test_ver_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let snap_path = temp_dir.join("version_mismatch.snap");

        index.save(&snap_path).expect("save must succeed");

        // Change version from 1 to 99
        let mut bytes = std::fs::read(&snap_path).unwrap();
        bytes[4..8].copy_from_slice(&99u32.to_le_bytes());
        std::fs::write(&snap_path, &bytes).unwrap();

        let load_res = FileIndex::load_mmap(&snap_path);
        assert!(
            matches!(
                load_res,
                Err(SnapshotError::VersionMismatch {
                    expected: 1,
                    found: 99
                })
            ),
            "Expected VersionMismatch, got: {:?}",
            load_res
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_invalid_magic() {
        let entries = vec![make_entry(5, 5, "C:", true, 0)];
        let index = FileIndex::build(entries);
        let temp_dir = std::env::temp_dir().join(format!("hphe_test_magic_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let snap_path = temp_dir.join("bad_magic.snap");

        index.save(&snap_path).expect("save must succeed");

        let mut bytes = std::fs::read(&snap_path).unwrap();
        bytes[0..4].copy_from_slice(b"NOPE");
        std::fs::write(&snap_path, &bytes).unwrap();

        let load_res = FileIndex::load_mmap(&snap_path);
        assert!(
            matches!(load_res, Err(SnapshotError::InvalidMagic(_))),
            "Expected InvalidMagic, got: {:?}",
            load_res
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_fallback_rebuild() {
        let temp_dir = std::env::temp_dir().join(format!("hphe_test_fallback_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let snap_path = temp_dir.join("non_existent.snap");

        let mut rebuilt = false;
        let index = FileIndex::load_or_rebuild(&snap_path, || {
            rebuilt = true;
            Ok(FileIndex::build(vec![make_entry(5, 5, "C:", true, 0)]))
        })
        .expect("fallback should rebuild and succeed");

        assert!(rebuilt);
        assert_eq!(index.len(), 1);
        // Should have saved the snapshot file on rebuild
        assert!(snap_path.exists());

        // Second load should use the snapshot
        let loaded = FileIndex::load_mmap(&snap_path).expect("subsequent load must succeed");
        assert_eq!(loaded.len(), 1);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
