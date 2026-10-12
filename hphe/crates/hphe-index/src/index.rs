//! SoA (Struct-of-Arrays) NTFS File Index.
//!
//! Stores columns:
//! - `name`: concatenated UTF-8 blob + u32 offsets
//! - `name_lower`: concatenated lowercase UTF-8 blob + u32 offsets
//! - `frn`: Vec<u64>
//! - `parent_frn`: Vec<u64>
//! - `size`: Vec<u64>
//! - `created`: Vec<u64> (FILETIME)
//! - `modified`: Vec<u64> (FILETIME)
//! - `accessed`: Vec<u64> (FILETIME)
//! - `flags`: Vec<u32> (dir, in_use, hardlink, file attributes)
//!
//! Sorted by `name_lower` for fast binary search and prefix matching.
//! Fast substring matching via `memchr::memmem` SIMD on `name_lower`.

use std::fmt;
use std::sync::RwLock;
use std::time::Instant;

use hashbrown::HashMap;
use memchr::memmem;
use rayon::prelude::*;

use crate::{EntryFlags, FLAG_DIRECTORY};
use hphe_mft::reader::{MftError, MftReader};
use hphe_mft::record::MftEntry;
use hphe_mft::volume::BlockReader;

/// An individual index entry projected from the SoA rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    pub row: usize,
    pub frn: u64,
    pub parent_frn: u64,
    pub name: String,
    pub name_lower: String,
    pub size: u64,
    pub created: u64,
    pub modified: u64,
    pub accessed: u64,
    pub flags: EntryFlags,
}

/// Statistics about the FileIndex.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileIndexStats {
    pub entry_count: usize,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub memory_usage_bytes: usize,
    pub build_time_ms: u64,
    pub avg_name_length: f64,
}

/// Error types for FileIndex operations.
#[derive(Debug, Clone)]
pub enum IndexError {
    Io(String),
    Mft(String),
    BuildFailed(String),
}

impl fmt::Display for IndexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Mft(e) => write!(f, "MFT read error: {e}"),
            Self::BuildFailed(e) => write!(f, "Index build failed: {e}"),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<MftError> for IndexError {
    fn from(e: MftError) -> Self {
        Self::Mft(e.to_string())
    }
}

/// Result of a find query.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub rows: Vec<usize>,
    pub total_count: usize,
    pub search_time_us: u64,
}

/// Main Struct-of-Arrays (SoA) File Index.
pub struct FileIndex {
    // String blobs (separated by '\0')
    name_blob: Vec<u8>,
    name_offsets: Vec<u32>,

    name_lower_blob: Vec<u8>,
    name_lower_offsets: Vec<u32>,

    // Numerical columns (indexed by row: 0..N)
    frn: Vec<u64>,
    parent_frn: Vec<u64>,
    size: Vec<u64>,
    created: Vec<u64>,
    modified: Vec<u64>,
    accessed: Vec<u64>,
    flags: Vec<u32>,

    // Root drive letter, e.g. 'C'
    drive_letter: char,

    // Fast mapping: FRN -> row index
    frn_to_row: HashMap<u64, u32>,

    // Cached directory full paths: dir_frn -> "C:\Users\Admin"
    dir_cache: RwLock<HashMap<u64, String>>,

    // Overlay for real-time USN delta mutations (deletes, updates)
    overlay: RwLock<IndexOverlay>,

    // Index statistics
    stats: FileIndexStats,
}

/// Dynamic overlay for real-time USN delta mutations applied to the index.
#[derive(Debug, Default, Clone)]
pub struct IndexOverlay {
    pub deleted_frns: hashbrown::HashSet<u64>,
    pub updated_entries: hashbrown::HashMap<u64, IndexEntry>,
}

impl FileIndex {
    /// Creates an empty FileIndex with default drive 'C'.
    pub fn new() -> Self {
        Self::with_drive('C')
    }

    /// Creates an empty FileIndex with a specific drive letter.
    pub fn with_drive(drive: char) -> Self {
        Self {
            name_blob: Vec::new(),
            name_offsets: Vec::new(),
            name_lower_blob: Vec::new(),
            name_lower_offsets: Vec::new(),
            frn: Vec::new(),
            parent_frn: Vec::new(),
            size: Vec::new(),
            created: Vec::new(),
            modified: Vec::new(),
            accessed: Vec::new(),
            flags: Vec::new(),
            drive_letter: drive.to_ascii_uppercase(),
            frn_to_row: HashMap::new(),
            dir_cache: RwLock::new(HashMap::new()),
            overlay: RwLock::new(IndexOverlay::default()),
            stats: FileIndexStats::default(),
        }
    }

    /// Builds a FileIndex from an iterator of `MftEntry` (REQUIS 4).
    pub fn build<I>(entries: I) -> Self
    where
        I: IntoIterator<Item = MftEntry>,
    {
        Self::build_with_drive("C:", entries)
    }

    /// Builds a FileIndex from an iterator of `MftEntry` specifying the volume drive.
    pub fn build_with_drive<I>(drive: &str, entries: I) -> Self
    where
        I: IntoIterator<Item = MftEntry>,
    {
        let start = Instant::now();
        let drive_char = drive
            .chars()
            .find(|c| c.is_ascii_alphabetic())
            .unwrap_or('C')
            .to_ascii_uppercase();

        let raw_entries: Vec<MftEntry> = entries.into_iter().collect();
        let entry_count = raw_entries.len();

        // 1. Parallel lowercase precomputation & pair construction
        let mut items: Vec<(String, MftEntry)> = raw_entries
            .into_par_iter()
            .map(|e| (e.name.to_lowercase(), e))
            .collect();

        // 2. Parallel sort by name_lower (REQUIS 1)
        items.par_sort_unstable_by(|a, b| a.0.cmp(&b.0));

        // 3. Pre-allocate SoA columns
        let mut name_blob = Vec::with_capacity(entry_count * 20);
        let mut name_offsets = Vec::with_capacity(entry_count + 1);
        let mut name_lower_blob = Vec::with_capacity(entry_count * 20);
        let mut name_lower_offsets = Vec::with_capacity(entry_count + 1);

        let mut frn = Vec::with_capacity(entry_count);
        let mut parent_frn = Vec::with_capacity(entry_count);
        let mut size = Vec::with_capacity(entry_count);
        let mut created = Vec::with_capacity(entry_count);
        let mut modified = Vec::with_capacity(entry_count);
        let mut accessed = Vec::with_capacity(entry_count);
        let mut flags = Vec::with_capacity(entry_count);

        let mut frn_to_row = HashMap::with_capacity(entry_count);

        let mut file_count = 0usize;
        let mut dir_count = 0usize;
        let mut total_size = 0u64;
        let mut total_name_len = 0usize;

        // 4. Populate SoA columns in sorted order
        for (row_idx, (name_lower_str, entry)) in items.into_iter().enumerate() {
            let row_u32 = row_idx as u32;

            // Name blob
            let name_bytes = entry.name.as_bytes();
            total_name_len += name_bytes.len();
            name_offsets.push(name_blob.len() as u32);
            name_blob.extend_from_slice(name_bytes);
            name_blob.push(0); // '\0' separator

            // Name lower blob
            let lower_bytes = name_lower_str.as_bytes();
            name_lower_offsets.push(name_lower_blob.len() as u32);
            name_lower_blob.extend_from_slice(lower_bytes);
            name_lower_blob.push(0); // '\0' separator

            // Numeric columns
            frn.push(entry.frn);
            parent_frn.push(entry.parent_frn);
            size.push(entry.size);
            created.push(entry.created);
            modified.push(entry.modified);
            accessed.push(entry.accessed);

            let entry_flags = EntryFlags::new(
                entry.is_dir,
                entry.is_in_use,
                entry.hard_links > 1,
                entry.attributes,
            );
            flags.push(entry_flags.to_u32());

            // Map FRN to row
            frn_to_row.insert(entry.frn, row_u32);

            if entry.is_dir {
                dir_count += 1;
            } else {
                file_count += 1;
                total_size += entry.size;
            }
        }

        // Sentinel offsets
        name_offsets.push(name_blob.len() as u32);
        name_lower_offsets.push(name_lower_blob.len() as u32);

        let build_time_ms = start.elapsed().as_millis() as u64;
        let avg_name_length = if entry_count > 0 {
            total_name_len as f64 / entry_count as f64
        } else {
            0.0
        };

        let mut index = Self {
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
            drive_letter: drive_char,
            frn_to_row,
            dir_cache: RwLock::new(HashMap::new()),
            overlay: RwLock::new(IndexOverlay::default()),
            stats: FileIndexStats {
                entry_count,
                file_count,
                dir_count,
                total_size,
                memory_usage_bytes: 0,
                build_time_ms,
                avg_name_length,
            },
        };

        index.stats.memory_usage_bytes = index.compute_memory_usage();
        index
    }

    /// Streams an MFT volume directly using `MftReader` and builds the index.
    pub fn from_mft_reader<R: BlockReader>(drive: &str, reader: &mut MftReader<R>) -> Result<Self, IndexError> {
        let mut entries = Vec::new();
        reader.scan_records(|entry| {
            entries.push(entry);
        })?;
        Ok(Self::build_with_drive(drive, entries))
    }

    /// Scans a live Windows volume drive (e.g. "C:") and builds the index.
    pub fn open_and_scan(drive: &str) -> Result<Self, IndexError> {
        let mut reader = MftReader::open_volume(drive)?;
        Self::from_mft_reader(drive, &mut reader)
    }

    /// Computes accurate in-memory footprint in bytes.
    pub fn compute_memory_usage(&self) -> usize {
        self.name_blob.capacity()
            + self.name_offsets.capacity() * std::mem::size_of::<u32>()
            + self.name_lower_blob.capacity()
            + self.name_lower_offsets.capacity() * std::mem::size_of::<u32>()
            + self.frn.capacity() * std::mem::size_of::<u64>()
            + self.parent_frn.capacity() * std::mem::size_of::<u64>()
            + self.size.capacity() * std::mem::size_of::<u64>()
            + self.created.capacity() * std::mem::size_of::<u64>()
            + self.modified.capacity() * std::mem::size_of::<u64>()
            + self.accessed.capacity() * std::mem::size_of::<u64>()
            + self.flags.capacity() * std::mem::size_of::<u32>()
            + self.frn_to_row.capacity() * (std::mem::size_of::<u64>() + std::mem::size_of::<u32>() + 1)
            + self.dir_cache.read().map(|c| c.len() * 96).unwrap_or(0)
    }

    /// Total number of entries in the index.
    #[inline]
    pub fn len(&self) -> usize {
        self.frn.len()
    }

    /// Returns whether the index is empty.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.frn.is_empty()
    }

    /// Drive letter associated with this index (e.g. 'C').
    #[inline]
    pub fn drive_letter(&self) -> char {
        self.drive_letter
    }

    /// Retrieves original filename of row.
    #[inline]
    pub fn name(&self, row: usize) -> &str {
        if row >= self.len() {
            return "";
        }
        let start = self.name_offsets[row] as usize;
        let end = (self.name_offsets[row + 1] as usize).saturating_sub(1);
        std::str::from_utf8(&self.name_blob[start..end]).unwrap_or("")
    }

    /// Retrieves lowercase filename of row.
    #[inline]
    pub fn name_lower(&self, row: usize) -> &str {
        if row >= self.len() {
            return "";
        }
        let start = self.name_lower_offsets[row] as usize;
        let end = (self.name_lower_offsets[row + 1] as usize).saturating_sub(1);
        std::str::from_utf8(&self.name_lower_blob[start..end]).unwrap_or("")
    }

    /// Retrieves FRN of row.
    #[inline]
    pub fn frn(&self, row: usize) -> u64 {
        self.frn[row]
    }

    /// Retrieves parent FRN of row.
    #[inline]
    pub fn parent_frn(&self, row: usize) -> u64 {
        self.parent_frn[row]
    }

    /// Retrieves size of row in bytes.
    #[inline]
    pub fn size(&self, row: usize) -> u64 {
        self.size[row]
    }

    /// Retrieves creation timestamp (FILETIME) of row.
    #[inline]
    pub fn created(&self, row: usize) -> u64 {
        self.created[row]
    }

    /// Retrieves modification timestamp (FILETIME) of row.
    #[inline]
    pub fn modified(&self, row: usize) -> u64 {
        self.modified[row]
    }

    /// Retrieves access timestamp (FILETIME) of row.
    #[inline]
    pub fn accessed(&self, row: usize) -> u64 {
        self.accessed[row]
    }

    /// Retrieves raw flags integer of row.
    #[inline]
    pub fn raw_flags(&self, row: usize) -> u32 {
        self.flags[row]
    }

    /// Checks if row is a directory.
    #[inline]
    pub fn is_dir(&self, row: usize) -> bool {
        (self.flags[row] & FLAG_DIRECTORY) != 0
    }

    /// Reconstructs full `IndexEntry` object for row.
    pub fn entry(&self, row: usize) -> Option<IndexEntry> {
        if row >= self.len() {
            return None;
        }
        let frn = self.frn[row];
        if let Ok(overlay) = self.overlay.read() {
            if let Some(updated) = overlay.updated_entries.get(&frn) {
                return Some(updated.clone());
            }
            if overlay.deleted_frns.contains(&frn) {
                let mut e = IndexEntry {
                    row,
                    frn,
                    parent_frn: self.parent_frn[row],
                    name: self.name(row).to_string(),
                    name_lower: self.name_lower(row).to_string(),
                    size: self.size[row],
                    created: self.created[row],
                    modified: self.modified[row],
                    accessed: self.accessed[row],
                    flags: EntryFlags::from_u32(self.flags[row]),
                };
                e.flags.is_in_use = false;
                return Some(e);
            }
        }
        Some(IndexEntry {
            row,
            frn: self.frn[row],
            parent_frn: self.parent_frn[row],
            name: self.name(row).to_string(),
            name_lower: self.name_lower(row).to_string(),
            size: self.size[row],
            created: self.created[row],
            modified: self.modified[row],
            accessed: self.accessed[row],
            flags: EntryFlags::from_u32(self.flags[row]),
        })
    }

    /// Look up row index by FRN.
    #[inline]
    pub fn row_by_frn(&self, frn: u64) -> Option<usize> {
        self.frn_to_row.get(&frn).copied().map(|r| r as usize)
    }

    /// Look up row index by FRN (alias for row_by_frn).
    #[inline]
    pub fn find_entry_by_frn(&self, frn: u64) -> Option<usize> {
        self.row_by_frn(frn)
    }

    /// Checks if a given FRN has been soft-deleted by USN deltas.
    pub fn is_frn_deleted(&self, frn: u64) -> bool {
        self.overlay.read().map(|o| o.deleted_frns.contains(&frn)).unwrap_or(false)
    }

    /// Checks if a row in the SoA index is currently valid and active (in_use and not soft-deleted).
    pub fn is_row_active(&self, row: usize) -> bool {
        if row >= self.len() {
            return false;
        }
        let in_use = (self.flags[row] & crate::FLAG_IN_USE) != 0;
        in_use && !self.is_frn_deleted(self.frn[row])
    }

    /// Marks an entry as deleted by FRN (USN delta application).
    pub fn apply_delete(&self, frn: u64) {
        if let Ok(mut overlay) = self.overlay.write() {
            overlay.deleted_frns.insert(frn);
            overlay.updated_entries.remove(&frn);
        }
        self.clear_path_cache();
    }

    /// Invalidates path caching for a renamed old path (USN delta application).
    pub fn apply_rename_old(&self, _frn: u64) {
        self.clear_path_cache();
    }

    /// Applies create or update delta using a full MftEntry.
    pub fn apply_create_or_update(&self, mft_entry: &hphe_mft::record::MftEntry) {
        let created = hphe_mft::record::MftEntry::filetime_to_unix_secs(mft_entry.created);
        let modified = hphe_mft::record::MftEntry::filetime_to_unix_secs(mft_entry.modified);
        let accessed = hphe_mft::record::MftEntry::filetime_to_unix_secs(mft_entry.accessed);
        let flags = EntryFlags::new(
            mft_entry.is_dir,
            mft_entry.is_in_use,
            false,
            mft_entry.attributes,
        );

        let row = self.row_by_frn(mft_entry.frn).unwrap_or(usize::MAX);
        let index_entry = IndexEntry {
            row,
            frn: mft_entry.frn,
            parent_frn: mft_entry.parent_frn,
            name: mft_entry.name.clone(),
            name_lower: mft_entry.name.to_lowercase(),
            size: mft_entry.size,
            created: created as u64,
            modified: modified as u64,
            accessed: accessed as u64,
            flags,
        };

        if let Ok(mut overlay) = self.overlay.write() {
            overlay.deleted_frns.remove(&mft_entry.frn);
            overlay.updated_entries.insert(mft_entry.frn, index_entry);
        }
        if mft_entry.is_dir {
            self.clear_path_cache();
        }
    }

    /// Adds or updates an entry manually with raw fields.
    pub fn add_entry(
        &self,
        frn: u64,
        parent_frn: u64,
        name: &str,
        size: u64,
        created: i64,
        modified: i64,
        accessed: i64,
        flags: EntryFlags,
    ) {
        let row = self.row_by_frn(frn).unwrap_or(usize::MAX);
        let index_entry = IndexEntry {
            row,
            frn,
            parent_frn,
            name: name.to_string(),
            name_lower: name.to_lowercase(),
            size,
            created: created as u64,
            modified: modified as u64,
            accessed: accessed as u64,
            flags,
        };
        if let Ok(mut overlay) = self.overlay.write() {
            overlay.deleted_frns.remove(&frn);
            overlay.updated_entries.insert(frn, index_entry);
        }
        if flags.is_dir {
            self.clear_path_cache();
        }
    }

    /// Returns the number of entries dynamically deleted by USN deltas.
    pub fn deleted_count(&self) -> usize {
        self.overlay.read().map(|o| o.deleted_frns.len()).unwrap_or(0)
    }

    /// Returns the number of entries dynamically updated by USN deltas.
    pub fn updated_count(&self) -> usize {
        self.overlay.read().map(|o| o.updated_entries.len()).unwrap_or(0)
    }

    // =========================================================================
    // SEARCH & SIMD SCAN (REQUIS 2 & 4)
    // =========================================================================

    /// Finds matching row indices for a substring pattern (REQUIS 4: find(pattern)->iter<row>).
    ///
    /// Case-insensitive substring matching using SIMD `memchr::memmem` on `name_lower`.
    pub fn find<'a>(&'a self, pattern: &str) -> impl Iterator<Item = usize> + 'a {
        let rows = self.find_rows(pattern);
        rows.into_iter()
    }

    /// Finds matching row indices as a `Vec<usize>`.
    pub fn find_rows(&self, pattern: &str) -> Vec<usize> {
        let pattern_lower = pattern.to_lowercase();
        let pattern_bytes = pattern_lower.as_bytes();

        if pattern_bytes.is_empty() || self.is_empty() {
            return Vec::new();
        }

        let finder = memmem::Finder::new(pattern_bytes);
        let blob = &self.name_lower_blob;
        let total_rows = self.len();

        // Sequential scan for small indexes, parallel partition for larger ones
        if total_rows < 50_000 {
            let mut matches = Vec::new();
            let mut cur_row = 0;

            for offset in finder.find_iter(blob) {
                while cur_row + 1 < total_rows
                    && (self.name_lower_offsets[cur_row + 1] as usize) <= offset
                {
                    cur_row += 1;
                }
                if cur_row < total_rows && matches.last() != Some(&cur_row) {
                    matches.push(cur_row);
                }
            }
            matches
        } else {
            let num_threads = rayon::current_num_threads().max(1);
            let chunk_size = (total_rows + num_threads - 1) / num_threads;

            (0..num_threads)
                .into_par_iter()
                .flat_map(|t| {
                    let start_row = t * chunk_size;
                    if start_row >= total_rows {
                        return Vec::new();
                    }
                    let end_row = ((t + 1) * chunk_size).min(total_rows);

                    let start_byte = self.name_lower_offsets[start_row] as usize;
                    let end_byte = self.name_lower_offsets[end_row] as usize;
                    let chunk_blob = &blob[start_byte..end_byte];

                    let mut local_matches = Vec::new();
                    let mut cur_row = start_row;

                    for rel_offset in finder.find_iter(chunk_blob) {
                        let abs_offset = start_byte + rel_offset;
                        while cur_row + 1 < end_row
                            && (self.name_lower_offsets[cur_row + 1] as usize) <= abs_offset
                        {
                            cur_row += 1;
                        }
                        if cur_row < end_row && local_matches.last() != Some(&cur_row) {
                            local_matches.push(cur_row);
                        }
                    }
                    local_matches
                })
                .collect()
        }
    }

    /// Binary search for exact match on `name_lower`.
    pub fn find_exact(&self, name: &str) -> Option<usize> {
        let target = name.to_lowercase();
        let mut low = 0;
        let mut high = self.len();

        while low < high {
            let mid = low + (high - low) / 2;
            let mid_name = self.name_lower(mid);
            match mid_name.cmp(&target) {
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Equal => return Some(mid),
                std::cmp::Ordering::Greater => high = mid,
            }
        }
        None
    }

    /// Prefix search on `name_lower` (e.g. for `startwith:` queries).
    pub fn find_prefix(&self, prefix: &str) -> Vec<usize> {
        let prefix_lower = prefix.to_lowercase();
        let total = self.len();
        if prefix_lower.is_empty() || total == 0 {
            return Vec::new();
        }

        // Binary search to find lower bound of prefix
        let mut low = 0;
        let mut high = total;
        while low < high {
            let mid = low + (high - low) / 2;
            if self.name_lower(mid) < prefix_lower.as_str() {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        let mut matches = Vec::new();
        let mut idx = low;
        while idx < total && self.name_lower(idx).starts_with(&prefix_lower) {
            matches.push(idx);
            idx += 1;
        }
        matches
    }

    // =========================================================================
    // PATH RESOLUTION WITH SEGMENT CACHING (REQUIS 3 & 4)
    // =========================================================================

    /// Resolves full Windows path for given row (REQUIS 4: resolve_path(row)->String).
    ///
    /// Climbs `parent_frn` chain using `frn_to_row` map, leveraging intermediate segment caching.
    pub fn resolve_path(&self, row: usize) -> String {
        if row >= self.len() {
            return String::new();
        }

        let file_name = self.name(row);
        let frn = self.frn[row];
        let parent_frn = self.parent_frn[row];
        let is_dir = self.is_dir(row);

        // Root entry (FRN 5 or self-referential parent)
        if frn == 5 || parent_frn == 0 || parent_frn == frn {
            return format!("{}:\\", self.drive_letter);
        }

        // Check if directory path is already cached for parent
        let parent_dir_path = self.resolve_dir_path(parent_frn);

        let mut full_path = String::with_capacity(parent_dir_path.len() + 1 + file_name.len());
        full_path.push_str(&parent_dir_path);
        if !parent_dir_path.ends_with('\\') {
            full_path.push('\\');
        }
        full_path.push_str(file_name);

        // If this entry itself is a directory, cache it
        if is_dir {
            if let Ok(mut cache) = self.dir_cache.write() {
                cache.insert(frn, full_path.clone());
            }
        }

        full_path
    }

    /// Internal helper: resolves full path for directory parent FRN using segment cache.
    fn resolve_dir_path(&self, dir_frn: u64) -> String {
        // Fast path: cache hit on dir_frn
        if let Ok(cache) = self.dir_cache.read() {
            if let Some(cached) = cache.get(&dir_frn) {
                return cached.clone();
            }
        }

        // Climb parent chain
        let mut chain: Vec<(u64, String)> = Vec::new();
        let mut cur_frn = dir_frn;
        let mut base_prefix = None;
        let mut depth = 0;

        while depth < 256 {
            depth += 1;

            if cur_frn == 0 || cur_frn == 5 {
                base_prefix = Some(format!("{}:\\", self.drive_letter));
                break;
            }

            // Check if ancestor is cached
            if let Ok(cache) = self.dir_cache.read() {
                if let Some(cached) = cache.get(&cur_frn) {
                    base_prefix = Some(cached.clone());
                    break;
                }
            }

            if let Some(&row_idx) = self.frn_to_row.get(&cur_frn) {
                let r = row_idx as usize;
                let dir_name = self.name(r).to_string();
                let next_parent = self.parent_frn[r];
                chain.push((cur_frn, dir_name));

                if next_parent == cur_frn || next_parent == 0 {
                    base_prefix = Some(format!("{}:\\", self.drive_letter));
                    break;
                }
                cur_frn = next_parent;
            } else {
                // Parent not present in index (e.g. volume root)
                base_prefix = Some(format!("{}:\\", self.drive_letter));
                break;
            }
        }

        let mut current_path = base_prefix.unwrap_or_else(|| format!("{}:\\", self.drive_letter));

        // Descend chain and populate dir_cache for all intermediate segments
        if let Ok(mut cache) = self.dir_cache.write() {
            for (frn, segment) in chain.into_iter().rev() {
                if !current_path.ends_with('\\') {
                    current_path.push('\\');
                }
                current_path.push_str(&segment);
                cache.insert(frn, current_path.clone());
            }
        }

        current_path
    }

    /// Clears the directory path cache.
    pub fn clear_path_cache(&self) {
        if let Ok(mut cache) = self.dir_cache.write() {
            cache.clear();
        }
    }

    /// Returns the number of cached directory paths.
    pub fn path_cache_len(&self) -> usize {
        self.dir_cache.read().map(|c| c.len()).unwrap_or(0)
    }

    /// Retrieves index statistics (REQUIS 4).
    #[inline]
    pub fn stats(&self) -> FileIndexStats {
        self.stats.clone()
    }
}

impl Default for FileIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_index_build_and_sorting() {
        let entries = vec![
            make_entry(100, 5, "Zeta.txt", false, 1024),
            make_entry(101, 5, "alpha.txt", false, 2048),
            make_entry(102, 5, "Beta.txt", false, 512),
        ];

        let index = FileIndex::build(entries);

        assert_eq!(index.len(), 3);
        // Sorted by name_lower: alpha.txt < beta.txt < zeta.txt
        assert_eq!(index.name_lower(0), "alpha.txt");
        assert_eq!(index.name(0), "alpha.txt");
        assert_eq!(index.name_lower(1), "beta.txt");
        assert_eq!(index.name(1), "Beta.txt");
        assert_eq!(index.name_lower(2), "zeta.txt");
        assert_eq!(index.name(2), "Zeta.txt");
    }

    #[test]
    fn test_substring_search_simd() {
        let entries = vec![
            make_entry(10, 5, "kernel32.dll", false, 1_000_000),
            make_entry(11, 5, "user32.dll", false, 800_000),
            make_entry(12, 5, "cargo.toml", false, 200),
            make_entry(13, 5, "kernel_base.sys", false, 500_000),
        ];

        let index = FileIndex::build(entries);

        // Substring "kernel" should match kernel32.dll and kernel_base.sys
        let matches: Vec<usize> = index.find("kernel").collect();
        assert_eq!(matches.len(), 2);

        let names: Vec<&str> = matches.iter().map(|&r| index.name(r)).collect();
        assert!(names.contains(&"kernel32.dll"));
        assert!(names.contains(&"kernel_base.sys"));

        // Case insensitivity
        let dll_matches: Vec<usize> = index.find("DLL").collect();
        assert_eq!(dll_matches.len(), 2);
    }

    #[test]
    fn test_prefix_and_exact_search() {
        let entries = vec![
            make_entry(1, 5, "Apple.txt", false, 10),
            make_entry(2, 5, "Application.exe", false, 20),
            make_entry(3, 5, "Banana.txt", false, 30),
        ];

        let index = FileIndex::build(entries);

        // Exact match
        let exact = index.find_exact("application.exe");
        assert!(exact.is_some());
        assert_eq!(index.name(exact.unwrap()), "Application.exe");

        // Prefix match
        let prefixes = index.find_prefix("app");
        assert_eq!(prefixes.len(), 2);
    }

    #[test]
    fn test_path_resolution_with_cache() {
        let entries = vec![
            make_entry(5, 5, "C:", true, 0),
            make_entry(10, 5, "Windows", true, 0),
            make_entry(20, 10, "System32", true, 0),
            make_entry(30, 20, "kernel32.dll", false, 1_000_000),
            make_entry(40, 20, "user32.dll", false, 800_000),
        ];

        let index = FileIndex::build(entries);

        // Resolve kernel32.dll
        let row_kernel = index.find_exact("kernel32.dll").unwrap();
        let path_kernel = index.resolve_path(row_kernel);
        assert_eq!(path_kernel, "C:\\Windows\\System32\\kernel32.dll");

        // System32 and Windows should now be cached
        assert!(index.path_cache_len() >= 2);

        // Resolve user32.dll (should hit cache for System32)
        let row_user = index.find_exact("user32.dll").unwrap();
        let path_user = index.resolve_path(row_user);
        assert_eq!(path_user, "C:\\Windows\\System32\\user32.dll");
    }

    #[test]
    fn test_stats() {
        let entries = vec![
            make_entry(5, 5, "C:", true, 0),
            make_entry(10, 5, "dir1", true, 0),
            make_entry(20, 10, "file1.txt", false, 100),
            make_entry(30, 10, "file2.txt", false, 200),
        ];

        let index = FileIndex::build(entries);
        let stats = index.stats();

        assert_eq!(stats.entry_count, 4);
        assert_eq!(stats.dir_count, 2);
        assert_eq!(stats.file_count, 2);
        assert_eq!(stats.total_size, 300);
        assert!(stats.memory_usage_bytes > 0);
    }
}
