//! Raw Windows NTFS volume access abstraction.

use std::fmt;
use std::io;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, HANDLE, INVALID_HANDLE_VALUE,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, SetFilePointerEx, FILE_ATTRIBUTE_NORMAL, FILE_BEGIN,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;

/// Trait for reading arbitrary byte slices at specific disk offsets.
pub trait BlockReader {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<()>;
}

impl<T: AsRef<[u8]>> BlockReader for io::Cursor<T> {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let slice = self.get_ref().as_ref();
        let start = offset as usize;
        let end = start + buf.len();
        if end > slice.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Offset out of bounds in memory reader",
            ));
        }
        buf.copy_from_slice(&slice[start..end]);
        Ok(())
    }
}

#[derive(Debug)]
pub enum VolumeError {
    ElevationRequired { drive: String },
    Io(io::Error),
    InvalidDriveName(String),
}

impl fmt::Display for VolumeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ElevationRequired { drive } => write!(
                f,
                "Access denied opening raw volume \\\\.\\{drive}. Administrator privileges are required."
            ),
            Self::Io(e) => write!(f, "I/O error opening volume: {e}"),
            Self::InvalidDriveName(d) => write!(f, "Invalid drive name format: {d}"),
        }
    }
}

impl std::error::Error for VolumeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for VolumeError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Encapsulates a raw Windows volume handle (e.g. \\.\C:).
pub struct Volume {
    #[cfg(windows)]
    handle: HANDLE,
    drive_letter: String,
}

impl Volume {
    /// Opens a raw volume by drive letter (e.g. "C" or "C:").
    pub fn open(drive: &str) -> Result<Self, VolumeError> {
        let clean_drive = drive.trim_end_matches([':', '\\', '/']);
        if clean_drive.len() != 1 || !clean_drive.chars().next().unwrap().is_ascii_alphabetic() {
            return Err(VolumeError::InvalidDriveName(drive.to_string()));
        }

        let drive_letter = clean_drive.to_uppercase();
        let volume_path = format!(r"\\.\{}:", drive_letter);

        #[cfg(windows)]
        {
            let path_wide: Vec<u16> = volume_path
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            // SAFETY: Calling CreateFileW with properly null-terminated wide string.
            // Opening raw volumes requires GENERIC_READ and shared access flags.
            let handle = unsafe {
                CreateFileW(
                    path_wide.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };

            if handle == INVALID_HANDLE_VALUE {
                let err_code = unsafe { GetLastError() };
                if err_code == ERROR_ACCESS_DENIED {
                    return Err(VolumeError::ElevationRequired {
                        drive: drive_letter,
                    });
                }
                return Err(VolumeError::Io(io::Error::from_raw_os_error(err_code as i32)));
            }

            Ok(Self {
                handle,
                drive_letter,
            })
        }

        #[cfg(not(windows))]
        {
            Err(VolumeError::Io(io::Error::new(
                io::ErrorKind::Unsupported,
                "Raw volume access is only supported on Windows",
            )))
        }
    }

    pub fn drive_letter(&self) -> &str {
        &self.drive_letter
    }
}

impl BlockReader for Volume {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        #[cfg(windows)]
        {
            let mut new_pos: i64 = 0;
            // SAFETY: SetFilePointerEx moves file pointer to absolute offset.
            let res = unsafe {
                SetFilePointerEx(self.handle, offset as i64, &mut new_pos, FILE_BEGIN)
            };
            if res == 0 {
                return Err(io::Error::last_os_error());
            }

            let mut total_read = 0;
            while total_read < buf.len() {
                let chunk_size = std::cmp::min((buf.len() - total_read) as u32, u32::MAX);
                let mut bytes_read: u32 = 0;
                // SAFETY: Reading into valid slice buffer.
                let res = unsafe {
                    ReadFile(
                        self.handle,
                        buf[total_read..].as_mut_ptr() as _,
                        chunk_size,
                        &mut bytes_read,
                        std::ptr::null_mut(),
                    )
                };
                if res == 0 {
                    return Err(io::Error::last_os_error());
                }
                if bytes_read == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Unexpected EOF reading raw volume",
                    ));
                }
                total_read += bytes_read as usize;
            }
            Ok(())
        }

        #[cfg(not(windows))]
        {
            let _ = (offset, buf);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Raw volume access is only supported on Windows",
            ))
        }
    }
}

impl Drop for Volume {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            if self.handle != INVALID_HANDLE_VALUE {
                // SAFETY: Closing valid Windows handle on drop.
                unsafe {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}
