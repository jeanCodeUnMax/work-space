//! USN Journal types and low-level IOCTL operations.
//!
//! This module provides the raw types and functions for interacting with the NTFS
//! Update Sequence Number (USN) Journal via Windows IOCTL calls.

use std::mem;
use std::ptr;

use windows_sys::Win32::Foundation::{BOOL, FALSE, GetLastError, HANDLE};
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Ioctl::{
    FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL,
};

// Type aliases for void pointers - they're just *mut c_void
pub type LPVOID = *mut std::ffi::c_void;
pub type LPDWORD = *mut u32;

use crate::error::UsnError;

/// USN Journal data structure (V2) returned by FSCTL_QUERY_USN_JOURNAL.
/// 
/// See: <https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_journal_data_v2>
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct USN_JOURNAL_DATA_V2 {
    /// USN at which the journal was created
    pub UsnJournalID: i64,
    /// First USN in the journal
    pub FirstUsn: i64,
    /// Next USN to be assigned
    pub NextUsn: i64,
    /// Lowest USN in the journal that contains valid data
    pub LowestValidUsn: i64,
    /// Highest USN currently in the journal
    pub MaxUsn: i64,
    /// Maximum size of the journal in bytes
    pub MaximumSize: i64,
    /// Bytes by which the journal grows when it needs more space
    pub AllocationDelta: i64,
    /// Size of each journal record (typically 0, meaning default)
    pub MinFileRecordSize: i32,
}

impl USN_JOURNAL_DATA_V2 {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }

    pub fn new() -> Self {
        Self {
            UsnJournalID: 0,
            FirstUsn: 0,
            NextUsn: 0,
            LowestValidUsn: 0,
            MaxUsn: 0,
            MaximumSize: 0,
            AllocationDelta: 0,
            MinFileRecordSize: 0,
        }
    }
}

/// USN Journal data structure (V4) - Vista and later.
/// 
/// See: <https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_journal_data_v4>
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct USN_JOURNAL_DATA_V4 {
    pub UsnJournalID: i64,
    pub FirstUsn: i64,
    pub NextUsn: i64,
    pub LowestValidUsn: i64,
    pub MaxUsn: i64,
    pub MaximumSize: i64,
    pub AllocationDelta: i64,
    pub MinFileRecordSize: i32,
    /// When TRUE, the journal can grow without size limit
    pub NoMaximumSize: BOOL,
    /// Minimum size the journal will be trimmed to
    pub TrimThreshold: i64,
    /// Reserved / Flags
    pub Flags: u32,
}

impl USN_JOURNAL_DATA_V4 {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }
}

/// Parameters for FSCTL_READ_USN_JOURNAL.
/// 
/// See: <https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-read_usn_journal_data_v1>
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct READ_USN_JOURNAL_DATA_V1 {
    /// Starting USN to read from
    pub StartUsn: i64,
    /// Bitmask of USN_REASON flags to filter
    pub ReasonMask: u32,
    /// Return only records that have been closed
    pub ReturnOnlyOnClose: u32,
    /// Timeout in seconds * 10^7 (DWORDLONG per Win32 ABI, 0 = non-blocking)
    pub Timeout: u64,
    /// Minimum number of bytes to wait for before returning (DWORDLONG per Win32 ABI)
    pub BytesToWaitFor: u64,
    /// Journal ID to read from (updated by the call)
    pub UsnJournalID: i64,
}

impl READ_USN_JOURNAL_DATA_V1 {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }

    pub fn new(start_usn: i64, journal_id: i64) -> Self {
        Self {
            StartUsn: start_usn,
            ReasonMask: 0xFFFF_FFFF, // All reasons
            ReturnOnlyOnClose: 0,
            Timeout: 0, // Non-blocking
            BytesToWaitFor: 0,
            UsnJournalID: journal_id,
        }
    }
}

pub type USN_READ_JOURNAL_DATA_V1 = READ_USN_JOURNAL_DATA_V1;

/// USN Reason flags for filtering journal records.
/// 
/// See: <https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ne-winioctl-fsctl_usn_reason>
#[allow(dead_code)]
#[allow(non_upper_case_globals)]
pub mod usn_reason {
    // Canonical USN_REASON_* values from winioctl.h — a previous revision of
    // this table used shifted/bogus values, which misdecoded every real record
    // (FILE_CREATE=0x100 landed on FILE_ADD_LINK, FILE_DELETE=0x200 on
    // HARD_LINK_CHANGE, DATA_EXTEND=0x02 on FILE_DELETE, etc.).
    /// Data was overwritten in the file.
    pub const DATA_OVERWRITE: u32 = 0x0000_0001;
    /// The file or directory was extended.
    pub const DATA_EXTEND: u32 = 0x0000_0002;
    /// Data was truncated from the file.
    pub const DATA_TRUNCATION: u32 = 0x0000_0004;
    /// Named data stream was overwritten.
    pub const NAMED_DATA_OVERWRITE: u32 = 0x0000_0010;
    /// Named data stream was extended.
    pub const NAMED_DATA_EXTEND: u32 = 0x0000_0020;
    /// Named data stream was truncated.
    pub const NAMED_DATA_TRUNCATION: u32 = 0x0000_0040;
    /// The file or directory was created.
    pub const FILE_CREATE: u32 = 0x0000_0100;
    /// The file or directory was deleted.
    pub const FILE_DELETE: u32 = 0x0000_0200;
    /// Extended attributes were changed.
    pub const EA_CHANGE: u32 = 0x0000_0400;
    /// One or more security descriptors were changed.
    pub const SECURITY_CHANGE: u32 = 0x0000_0800;
    /// The file or directory was renamed; the USN record carries the old name.
    pub const RENAME_OLD_NAME: u32 = 0x0000_1000;
    /// The file or directory was renamed; the USN record carries the new name.
    pub const RENAME_NEW_NAME: u32 = 0x0000_2000;
    /// The index root was changed.
    pub const INDEXABLE_CHANGE: u32 = 0x0000_4000;
    /// A change to the file or directory that is not a data change.
    pub const BASIC_INFO_CHANGE: u32 = 0x0000_8000;
    /// One or more hard links were added to the file.
    pub const HARD_LINK_CHANGE: u32 = 0x0001_0000;
    /// The file or directory was compressed.
    pub const COMPRESSION_CHANGE: u32 = 0x0002_0000;
    /// The file or directory encryption was changed.
    pub const ENCRYPTION_CHANGE: u32 = 0x0004_0000;
    /// The object ID was changed.
    pub const OBJECT_ID_CHANGE: u32 = 0x0008_0000;
    /// The reparse point was changed or a reparse point was added.
    pub const REPARSE_POINT_CHANGE: u32 = 0x0010_0000;
    /// A new stream was added or removed.
    pub const STREAM_CHANGE: u32 = 0x0020_0000;
    /// Change made within a transacted operation.
    pub const TRANSACTED_CHANGE: u32 = 0x0040_0000;
    /// Integrity (checksum) data was changed.
    pub const INTEGRITY_CHANGE: u32 = 0x0080_0000;
    /// The file or directory was closed.
    pub const FILE_CLOSE: u32 = 0x8000_0000;

    /// Default mask for file index updates: create, delete, rename, basic info, data changes, close
    pub const INDEX_DEFAULT_MASK: u32 = FILE_CREATE
        | FILE_DELETE
        | RENAME_NEW_NAME
        | RENAME_OLD_NAME
        | BASIC_INFO_CHANGE
        | DATA_OVERWRITE
        | DATA_EXTEND
        | DATA_TRUNCATION
        | FILE_CLOSE;

    /// Full mask (all reasons)
    pub const FILE_ALL_REASONS: u32 = 0xFFFF_FFFF;
}

/// USN Record common header (same for V2, V3, V4).
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsnRecordHeader {
    /// Size of this record in bytes
    pub record_length: u32,
    /// Major version of the record format
    pub major_version: u16,
    /// Minor version of the record format
    pub minor_version: u16,
}

impl UsnRecordHeader {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }
}

/// USN Record version 2 (Windows XP SP2+).
/// 
/// See: <https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v2>
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct USN_RECORD_V2 {
    pub header: UsnRecordHeader,
    /// File Reference Number of the file
    pub FileReferenceNumber: u64,
    /// File Reference Number of the parent directory
    pub ParentFileReferenceNumber: u64,
    /// USN of this journal entry
    pub Usn: i64,
    /// When this entry was added to the journal (FILETIME)
    pub TimeStamp: i64,
    /// Bitmask of USN_REASON flags
    pub Reason: u32,
    /// Source information (typically 0)
    pub SourceInfo: u32,
    /// Security descriptor ID
    pub SecurityId: u32,
    /// File attributes
    pub FileAttributes: u32,
    /// Length of the file name in bytes
    pub FileNameLength: u16,
    /// Byte offset of the file name from the beginning of this record
    /// The file name follows immediately after this structure (UTF-16, not null-terminated)
    pub FileNameOffset: u16,
}

impl USN_RECORD_V2 {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }

    /// Returns the total size of the record including the file name.
    pub fn total_size(&self) -> usize {
        self.header.record_length as usize
    }

    /// Extracts the file name from the record as a UTF-16 string.
    /// 
    /// # Safety
    /// The buffer must be at least `self.total_size()` bytes and start at the
    /// same address as `self`.
    pub unsafe fn file_name(&self, buffer: &[u8]) -> Option<String> {
        let name_offset = self.FileNameOffset as usize;
        let name_length = self.FileNameLength as usize;

        if name_offset + name_length > buffer.len() {
            return None;
        }

        let name_bytes = &buffer[name_offset..name_offset + name_length];
        let wide: Vec<u16> = name_bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();

        String::from_utf16(&wide).ok()
    }
}

/// USN Record version 4 (Windows 8.1+).
/// 
/// Extends V2 with additional file information.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct USN_RECORD_V4 {
    pub header: UsnRecordHeader,
    pub FileReferenceNumber: u64,
    pub ParentFileReferenceNumber: u64,
    pub Usn: i64,
    pub TimeStamp: i64,
    pub Reason: u32,
    pub SourceInfo: u32,
    pub SecurityId: u32,
    pub FileAttributes: u32,
    pub FileNameLength: u16,
    pub FileNameOffset: u16,
    /// Additional information (V4 specific)
    pub ExtendedFileInfo: u64,
}

impl USN_RECORD_V4 {
    pub const fn size_of() -> usize {
        mem::size_of::<Self>()
    }

    pub fn total_size(&self) -> usize {
        self.header.record_length as usize
    }

    pub unsafe fn file_name(&self, buffer: &[u8]) -> Option<String> {
        let name_offset = self.FileNameOffset as usize;
        let name_length = self.FileNameLength as usize;

        if name_offset + name_length > buffer.len() {
            return None;
        }

        let name_bytes = &buffer[name_offset..name_offset + name_length];
        let wide: Vec<u16> = name_bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();

        String::from_utf16(&wide).ok()
    }
}

/// High-level USN record that can be either V2 or V4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsnRecord {
    V2(USN_RECORD_V2),
    V4(USN_RECORD_V4),
}

impl UsnRecord {
    pub fn file_reference_number(&self) -> u64 {
        match self {
            UsnRecord::V2(r) => r.FileReferenceNumber,
            UsnRecord::V4(r) => r.FileReferenceNumber,
        }
    }

    pub fn parent_file_reference_number(&self) -> u64 {
        match self {
            UsnRecord::V2(r) => r.ParentFileReferenceNumber,
            UsnRecord::V4(r) => r.ParentFileReferenceNumber,
        }
    }

    pub fn usn(&self) -> i64 {
        match self {
            UsnRecord::V2(r) => r.Usn,
            UsnRecord::V4(r) => r.Usn,
        }
    }

    pub fn timestamp(&self) -> i64 {
        match self {
            UsnRecord::V2(r) => r.TimeStamp,
            UsnRecord::V4(r) => r.TimeStamp,
        }
    }

    pub fn reason(&self) -> u32 {
        match self {
            UsnRecord::V2(r) => r.Reason,
            UsnRecord::V4(r) => r.Reason,
        }
    }

    pub fn file_attributes(&self) -> u32 {
        match self {
            UsnRecord::V2(r) => r.FileAttributes,
            UsnRecord::V4(r) => r.FileAttributes,
        }
    }

    /// Returns the total size of the record including the file name.
    pub fn total_size(&self) -> usize {
        match self {
            UsnRecord::V2(r) => r.total_size(),
            UsnRecord::V4(r) => r.total_size(),
        }
    }

    /// Extracts the file name from the record.
    /// 
    /// # Safety
    /// The buffer must be at least `self.total_size()` bytes.
    pub unsafe fn file_name(&self, buffer: &[u8]) -> Option<String> {
        match self {
            UsnRecord::V2(r) => r.file_name(buffer),
            UsnRecord::V4(r) => r.file_name(buffer),
        }
    }
}

/// Simplified USN journal data structure for our use.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsnJournalData {
    /// Unique identifier for this journal instance
    pub journal_id: i64,
    /// First USN in the current journal
    pub first_usn: i64,
    /// Next USN to be assigned
    pub next_usn: i64,
    /// Lowest valid USN in the journal
    pub lowest_valid_usn: i64,
    /// Maximum size of the journal in bytes
    pub max_size: i64,
    /// Current maximum USN in the journal
    pub current_max_usn: i64,
}

impl From<USN_JOURNAL_DATA_V2> for UsnJournalData {
    fn from(data: USN_JOURNAL_DATA_V2) -> Self {
        Self {
            journal_id: data.UsnJournalID,
            first_usn: data.FirstUsn,
            next_usn: data.NextUsn,
            lowest_valid_usn: data.LowestValidUsn,
            max_size: data.MaximumSize,
            current_max_usn: data.MaxUsn,
        }
    }
}

impl From<USN_JOURNAL_DATA_V4> for UsnJournalData {
    fn from(data: USN_JOURNAL_DATA_V4) -> Self {
        Self {
            journal_id: data.UsnJournalID,
            first_usn: data.FirstUsn,
            next_usn: data.NextUsn,
            lowest_valid_usn: data.LowestValidUsn,
            max_size: data.MaximumSize,
            current_max_usn: data.MaxUsn,
        }
    }
}

/// Parameters for reading the USN journal.
#[derive(Debug, Clone)]
pub struct UsnReadData {
    pub start_usn: i64,
    pub reason_mask: u32,
    pub timeout: u32,
    pub bytes_to_wait_for: u32,
}

impl Default for UsnReadData {
    fn default() -> Self {
        Self {
            start_usn: 0,
            reason_mask: usn_reason::INDEX_DEFAULT_MASK,
            timeout: 0,
            bytes_to_wait_for: 0,
        }
    }
}

/// Queries the USN journal metadata for a volume.
/// 
/// # Arguments
/// * `handle` - Handle to the volume (opened with GENERIC_READ)
/// 
/// # Returns
/// `UsnJournalData` containing journal metadata, or error
/// 
/// # Safety
/// The handle must be valid and have appropriate access rights.
pub unsafe fn query_usn_journal(handle: HANDLE) -> Result<UsnJournalData, UsnError> {
    let mut journal_data: USN_JOURNAL_DATA_V2 = USN_JOURNAL_DATA_V2::new();
    let mut bytes_returned: u32 = 0;

    let status = DeviceIoControl(
        handle,
        FSCTL_QUERY_USN_JOURNAL,
        ptr::null_mut(),
        0,
        &mut journal_data as *mut _ as LPVOID,
        USN_JOURNAL_DATA_V2::size_of() as u32,
        &mut bytes_returned,
        ptr::null_mut(),
    );

    if status == FALSE {
        let err = std::io::Error::last_os_error();
        return Err(UsnError::IoctlError {
            operation: "FSCTL_QUERY_USN_JOURNAL".to_string(),
            source: err,
        });
    }

    Ok(journal_data.into())
}

/// Reads USN journal records starting from a given USN.
/// 
/// # Arguments
/// * `handle` - Handle to the volume
/// * `start_usn` - USN to start reading from
/// * `buffer` - Output buffer for the records
/// 
/// # Returns
/// Tuple of (read_data, bytes_returned) where:
/// - read_data contains the parameters used for the read
/// - bytes_returned is the number of bytes actually read into buffer
/// 
/// # Safety
/// The handle must be valid and buffer must be properly allocated.
pub unsafe fn read_usn_journal(
    handle: HANDLE,
    start_usn: i64,
    journal_id: i64,
    buffer: &mut [u8],
) -> Result<(READ_USN_JOURNAL_DATA_V1, usize), UsnError> {
    let mut read_data = USN_READ_JOURNAL_DATA_V1::new(start_usn, journal_id);
    let mut bytes_returned: u32 = 0;

    let _ = &read_data;

    let status = DeviceIoControl(
        handle,
        FSCTL_READ_USN_JOURNAL,
        &mut read_data as *mut _ as LPVOID,
        USN_READ_JOURNAL_DATA_V1::size_of() as u32,
        buffer.as_mut_ptr() as LPVOID,
        buffer.len() as u32,
        &mut bytes_returned,
        ptr::null_mut(),
    );

    if status == FALSE {
        let err = std::io::Error::last_os_error();
        // ERROR_HANDLE_EOF (38) is normal when there are no more records
        let win_error = windows_sys::Win32::Foundation::GetLastError();
        if win_error == 38 {
            // No more data - return empty result
            return Ok((read_data, 0));
        }
        return Err(UsnError::IoctlError {
            operation: "FSCTL_READ_USN_JOURNAL".to_string(),
            source: err,
        });
    }

    Ok((read_data, bytes_returned as usize))
}

/// Iterates over USN records in a buffer.
/// 
/// # Arguments
/// * `buffer` - Buffer containing raw USN records
/// 
/// # Returns
/// Iterator over parsed USN records
pub fn iter_usn_records(buffer: &[u8]) -> UsnRecordIterator<'_> {
    UsnRecordIterator::new(buffer)
}

/// Iterator over USN records in a buffer.
pub struct UsnRecordIterator<'a> {
    buffer: &'a [u8],
    offset: usize,
}

impl<'a> UsnRecordIterator<'a> {
    fn new(buffer: &'a [u8]) -> Self {
        Self { buffer, offset: 0 }
    }
}

impl<'a> Iterator for UsnRecordIterator<'a> {
    /// Each item is the parsed record paired with its extracted file name
    /// (None when the UTF-16 name can't be decoded). The name is extracted
    /// here — inside the iterator — because `UsnRecord::file_name` requires
    /// a buffer starting at the record itself (`FileNameOffset` is relative
    /// to the record start); callers holding only the batch buffer would
    /// read the wrong bytes for every record past the first.
    type Item = (UsnRecord, Option<String>);

    fn next(&mut self) -> Option<Self::Item> {
        if self.offset >= self.buffer.len() {
            return None;
        }

        // Read record header
        let header_size = UsnRecordHeader::size_of();
        if self.offset + header_size > self.buffer.len() {
            return None;
        }

        let header_bytes = &self.buffer[self.offset..self.offset + header_size];
        let header = unsafe { ptr::read_unaligned(header_bytes.as_ptr() as *const UsnRecordHeader) };

        // Validate record length
        let record_length = header.record_length as usize;
        if record_length < header_size || self.offset + record_length > self.buffer.len() {
            // Corrupted record - skip it
            self.offset += header_size;
            return self.next();
        }

        // Parse based on version
        let record_data = &self.buffer[self.offset..self.offset + record_length];
        let record = if header.major_version >= 4 {
            // V4 record
            let record_v4 = unsafe { ptr::read_unaligned(record_data.as_ptr() as *const USN_RECORD_V4) };
            UsnRecord::V4(record_v4)
        } else {
            // V2 record
            let record_v2 = unsafe { ptr::read_unaligned(record_data.as_ptr() as *const USN_RECORD_V2) };
            UsnRecord::V2(record_v2)
        };

        // SAFETY: `record_data` starts at the record and is at least
        // `total_size()` bytes — the exact contract `file_name` requires.
        let name = unsafe { record.file_name(record_data) };

        self.offset += record_length;
        Some((record, name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_usn_journal_data_v2_size() {
        assert_eq!(USN_JOURNAL_DATA_V2::size_of(), 64);
    }

    #[test]
    fn test_usn_record_v2_size() {
        // header(8) + FileReferenceNumber(8) + ParentFileReferenceNumber(8) + Usn(8) + 
        // TimeStamp(8) + Reason(4) + SourceInfo(4) + SecurityId(4) + 
        // FileAttributes(4) + FileNameLength(2) + FileNameOffset(2) = 64
        assert_eq!(USN_RECORD_V2::size_of(), 64);
    }

    #[test]
    fn test_usn_read_data_v1_size() {
        // StartUsn(8) + ReasonMask(4) + ReturnOnlyOnClose(4) + Timeout(8) + BytesToWaitFor(8) + UsnJournalID(8) = 40
        // Timeout/BytesToWaitFor are DWORDLONG in the Win32 ABI — u32 fields
        // here previously produced a 32-byte buffer rejected with error 1784.
        assert_eq!(USN_READ_JOURNAL_DATA_V1::size_of(), 40);
    }

    #[test]
    fn test_reason_mask_default() {
        let mask = usn_reason::INDEX_DEFAULT_MASK;
        // Should include all important reasons for file indexing
        assert!(mask & usn_reason::FILE_CREATE != 0);
        assert!(mask & usn_reason::FILE_DELETE != 0);
        assert!(mask & usn_reason::RENAME_NEW_NAME != 0);
        assert!(mask & usn_reason::RENAME_OLD_NAME != 0);
        assert!(mask & usn_reason::BASIC_INFO_CHANGE != 0);
        assert!(mask & usn_reason::DATA_OVERWRITE != 0);
        assert!(mask & usn_reason::FILE_CLOSE != 0);
    }
}
