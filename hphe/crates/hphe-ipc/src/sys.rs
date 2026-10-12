//! Low-level Windows API wrappers for named pipes
//!
//! Provides direct Windows API bindings for named pipe operations
//! with full ACL control.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows_sys::{
    core::PCSTR,
    Win32::{
        Foundation::{
            CloseHandle, BOOL, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, ERROR_SUCCESS, FALSE, HANDLE,
            INVALID_HANDLE_VALUE, TRUE,
        },
        Security::{
            ACL, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL,
            SECURITY_DESCRIPTOR_REVISION,
        },
        System::{
            IO::OVERLAPPED,
            Pipes::{
                CreateNamedPipeW, ConnectNamedPipe, DisconnectNamedPipe, ReadFile, WriteFile,
                FlushFileBuffers, GetNamedPipeHandleStateW, GetNamedPipeInfo, SetNamedPipeHandleState,
                PIPE_ACCESS_DUPLEX, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND, PIPE_TYPE_MESSAGE,
                PIPE_TYPE_BYTE, PIPE_READMODE_MESSAGE, PIPE_READMODE_BYTE, PIPE_WAIT,
                PIPE_NOWAIT, NMPWAIT_USE_DEFAULT_WAIT, NMPWAIT_WAIT_FOREVER, PIPE_UNLIMITED_INSTANCES,
                PIPE_REJECT_REMOTE_CLIENTS,
            },
            Threading::{
                CreateEventW, SetEvent, ResetEvent, WaitForSingleObject, WAIT_OBJECT_0, INFINITE,
            },
        },
    },
};

use crate::error::{IpcError, IpcResult};

/// Pipe mode for CreateNamedPipe
#[derive(Debug, Clone, Copy)]
pub enum PipeMode {
    /// Message mode (recommended)
    Message,
    /// Byte mode
    Byte,
}

/// Named pipe options
#[derive(Debug, Clone)]
pub struct PipeOptions {
    pub name: String,
    pub mode: PipeMode,
    pub max_instances: u32,
    pub in_buffer_size: u32,
    pub out_buffer_size: u32,
    pub timeout_ms: Option<u32>,
    pub reject_remote: bool,
}

impl Default for PipeOptions {
    fn default() -> Self {
        Self {
            name: r"\\.\pipe\hphe-index".to_string(),
            mode: PipeMode::Message,
            max_instances: PIPE_UNLIMITED_INSTANCES,
            in_buffer_size: 64 * 1024,
            out_buffer_size: 64 * 1024,
            timeout_ms: None,
            reject_remote: true,
        }
    }
}

/// Raw handle wrapper with automatic cleanup
pub struct SafeHandle {
    handle: HANDLE,
    close_on_drop: bool,
}

impl SafeHandle {
    pub fn new(handle: HANDLE) -> Self {
        Self {
            handle,
            close_on_drop: true,
        }
    }

    pub fn new_owned(handle: HANDLE) -> Self {
        Self {
            handle,
            close_on_drop: true,
        }
    }

    pub fn new_borrowed(handle: HANDLE) -> Self {
        Self {
            handle,
            close_on_drop: false,
        }
    }

    pub fn as_raw(&self) -> HANDLE {
        self.handle
    }

    pub fn take(self) -> HANDLE {
        let h = self.handle;
        self.handle = INVALID_HANDLE_VALUE;
        SafeHandle::new_borrowed(h)
    }

    pub fn is_valid(&self) -> bool {
        self.handle != INVALID_HANDLE_VALUE && self.handle != 0
    }
}

impl Drop for SafeHandle {
    fn drop(&mut self) {
        if self.close_on_drop && self.handle != INVALID_HANDLE_VALUE && self.handle != 0 {
            unsafe { CloseHandle(self.handle) };
            self.handle = INVALID_HANDLE_VALUE;
        }
    }
}

impl Clone for SafeHandle {
    fn clone(&self) -> Self {
        // Duplicate the handle
        let mut new_handle = INVALID_HANDLE_VALUE;
        
        let result = unsafe {
            windows_sys::Win32::Foundation::DuplicateHandle(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                self.handle,
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                &mut new_handle,
                0,
                FALSE,
                windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS,
            )
        };
        
        if result == 0 {
            return Self::new(INVALID_HANDLE_VALUE);
        }
        
        Self::new_owned(new_handle)
    }
}

/// Convert a string to a Windows wide string (UTF-16 LE with null terminator)
pub fn to_wide_string(s: &str) -> Vec<u16> {
    let mut wide: Vec<u16> = OsStr::new(s).encode_wide().collect();
    wide.push(0);
    wide
}

/// Create a named pipe server
pub fn create_pipe_server(options: &PipeOptions) -> IpcResult<SafeHandle> {
    let name_wide = to_wide_string(&options.name);
    
    let read_mode = match options.mode {
        PipeMode::Message => PIPE_READMODE_MESSAGE,
        PipeMode::Byte => PIPE_READMODE_BYTE,
    };
    
    let pipe_type = match options.mode {
        PipeMode::Message => PIPE_TYPE_MESSAGE,
        PipeMode::Byte => PIPE_TYPE_BYTE,
    };
    
    let mut flags = PIPE_ACCESS_DUPLEX;
    if options.reject_remote {
        flags |= PIPE_REJECT_REMOTE_CLIENTS;
    }
    
    let handle = unsafe {
        CreateNamedPipeW(
            name_wide.as_ptr(),
            flags,
            read_mode | pipe_type | PIPE_WAIT,
            options.max_instances,
            options.out_buffer_size,
            options.in_buffer_size,
            options.timeout_ms.unwrap_or(NMPWAIT_USE_DEFAULT_WAIT),
            ptr::null(), // Default security attributes
        )
    };
    
    if handle == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        return Err(IpcError::Io(error));
    }
    
    Ok(SafeHandle::new_owned(handle))
}

/// Connect to a named pipe client
pub fn connect_pipe_client(name: &str, timeout_ms: Option<u32>) -> IpcResult<SafeHandle> {
    let name_wide = to_wide_string(name);
    
    let handle = unsafe {
        windows_sys::Win32::Foundation::CreateFileW(
            name_wide.as_ptr(),
            windows_sys::Win32::Storage::FileSystem::GENERIC_READ | windows_sys::Win32::Storage::FileSystem::GENERIC_WRITE,
            0, // No sharing
            ptr::null(), // Default security
            windows_sys::Win32::Foundation::OPEN_EXISTING,
            windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
            ptr::null(), // No template
        )
    };
    
    if handle == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        return Err(IpcError::Io(error));
    }
    
    Ok(SafeHandle::new_owned(handle))
}

/// Wait for a client to connect to a named pipe
pub fn wait_for_client(handle: HANDLE, timeout: Option<Duration>) -> IpcResult<bool> {
    let mut connected = FALSE;
    
    let result = if let Some(timeout) = timeout {
        let timeout_ms = timeout.as_millis().min(u128::MAX as u64) as u32;
        unsafe {
            ConnectNamedPipe(handle, ptr::null_mut())
        }
    } else {
        unsafe {
            ConnectNamedPipe(handle, ptr::null_mut())
        }
    };
    
    if result != 0 {
        // Success
        return Ok(true);
    }
    
    let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    
    if error == ERROR_IO_PENDING {
        // Async connection - wait for it
        // For simplicity, we'll just return that we need to wait
        return Ok(false);
    } else if error == ERROR_PIPE_CONNECTED {
        // Already connected
        return Ok(true);
    } else if error == ERROR_SUCCESS {
        // Success
        return Ok(true);
    }
    
    // Other error
    let io_error = std::io::Error::from_raw_os_error(error as i32);
    Err(IpcError::Io(io_error))
}

/// Disconnect a named pipe
pub fn disconnect_pipe(handle: HANDLE) -> IpcResult<()> {
    let result = unsafe { DisconnectNamedPipe(handle) };
    
    if result != 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        Err(IpcError::Io(error))
    }
}

/// Read from a pipe
pub fn read_pipe(handle: HANDLE, buffer: &mut [u8]) -> IpcResult<usize> {
    let mut bytes_read = 0u32;
    
    let result = unsafe {
        ReadFile(
            handle,
            buffer.as_mut_ptr() as *mut _,
            buffer.len() as u32,
            &mut bytes_read,
            ptr::null_mut(),
        )
    };
    
    if result != 0 {
        Ok(bytes_read as usize)
    } else {
        let error = std::io::Error::last_os_error();
        
        // Check for connection closed
        if error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE as i32)
            || error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED as i32)
        {
            return Ok(0); // Connection closed
        }
        
        Err(IpcError::Io(error))
    }
}

/// Write to a pipe
pub fn write_pipe(handle: HANDLE, buffer: &[u8]) -> IpcResult<usize> {
    let mut bytes_written = 0u32;
    
    let result = unsafe {
        WriteFile(
            handle,
            buffer.as_ptr() as *const _,
            buffer.len() as u32,
            &mut bytes_written,
            ptr::null_mut(),
        )
    };
    
    if result != 0 {
        Ok(bytes_written as usize)
    } else {
        let error = std::io::Error::last_os_error();
        Err(IpcError::Io(error))
    }
}

/// Flush a pipe
pub fn flush_pipe(handle: HANDLE) -> IpcResult<()> {
    let result = unsafe { FlushFileBuffers(handle) };
    
    if result != 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        Err(IpcError::Io(error))
    }
}

/// Check if a pipe is connected
pub fn is_pipe_connected(handle: HANDLE) -> IpcResult<bool> {
    let mut state = 0u32;
    let result = unsafe {
        GetNamedPipeHandleStateW(
            handle,
            &mut state,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
        )
    };
    
    if result != 0 {
        // Check if connected
        let connected = (state & windows_sys::Win32::System::Pipes::PIPE_STATE_CONNECTED) != 0;
        Ok(connected)
    } else {
        let error = std::io::Error::last_os_error();
        Err(IpcError::Io(error))
    }
}

/// Security utilities for Windows ACL
pub mod security {
    use super::*;
    use windows_sys::Win32::Security::{
        ACL, ACCESS_ALLOWED_ACE, ACL_INFORMATION_CLASS, ACL_REVISION, ACL_SIZE_INFORMATION,
        AddAccessAllowedAce, GetAclInformation, InitializeAcl, InitializeSecurityDescriptor,
        IsValidSecurityDescriptor, SetSecurityDescriptorDacl, SECURITY_DESCRIPTOR,
        SECURITY_DESCRIPTOR_REVISION, SECURITY_IDENTIFIER,
    };

    /// Well-known SIDs
    pub mod sids {
        // SYSTEM SID: S-1-5-18
        pub const SYSTEM: [u8; 12] = [
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x12, 0x00, 0x00, 0x00,
        ];

        // Local Administrators SID: S-1-5-32-544
        pub const ADMINISTRATORS: [u8; 20] = [
            0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x20, 0x00, 0x00, 0x00,
            0x32, 0x00, 0x02, 0x00, 0x00, 0x01, 0x02, 0x00,
        ];
    }

    /// Create a security descriptor with restrictive DACL
    pub fn create_restrictive_security_descriptor() -> Option<Vec<u8>> {
        unsafe {
            const SD_BUFFER_SIZE: usize = 1024;
            let mut sd_buffer = vec![0u8; SD_BUFFER_SIZE];
            let sd_ptr = sd_buffer.as_mut_ptr() as *mut SECURITY_DESCRIPTOR;

            if InitializeSecurityDescriptor(
                sd_ptr,
                SECURITY_DESCRIPTOR_REVISION as u32,
            ) == 0
            {
                return None;
            }

            // Create ACL
            let acl_size = 1024;
            let mut acl_buffer = vec![0u8; acl_size];
            let acl_ptr = acl_buffer.as_mut_ptr() as *mut ACL;

            if InitializeAcl(acl_ptr, acl_size as u32, ACL_REVISION as u8) == 0 {
                return None;
            }

            // Add SYSTEM SID with full access
            if AddAccessAllowedAce(
                acl_ptr,
                ACL_REVISION as u32,
                windows_sys::Win32::System::Pipes::FILE_ALL_ACCESS,
                &sids::SYSTEM as *const _ as *const SECURITY_IDENTIFIER,
            ) == 0
            {
                return None;
            }

            // Add Administrators SID with full access
            if AddAccessAllowedAce(
                acl_ptr,
                ACL_REVISION as u32,
                windows_sys::Win32::System::Pipes::FILE_ALL_ACCESS,
                &sids::ADMINISTRATORS as *const _ as *const SECURITY_IDENTIFIER,
            ) == 0
            {
                return None;
            }

            // Set DACL
            if SetSecurityDescriptorDacl(
                sd_ptr,
                TRUE,
                acl_ptr,
                FALSE,
            ) == 0
            {
                return None;
            }

            Some(sd_buffer)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_wide_string() {
        let s = "test";
        let wide = to_wide_string(s);
        assert!(wide.ends_with(&[0]));
        assert_eq!(wide.len() % 2, 1); // Includes null terminator
    }

    #[test]
    fn test_pipe_options() {
        let options = PipeOptions::default();
        assert_eq!(options.name, r"\\.\pipe\hphe-index");
        assert!(options.reject_remote);
    }
}
