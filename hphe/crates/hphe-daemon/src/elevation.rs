//! Windows administrator elevation verification for hphe-indexd.
//!
//! Direct NTFS raw volume opening (\\.\X:) and USN journal querying
//! require administrator privileges (SE_MANAGE_VOLUME_NAME / admin token).

use std::fmt;

/// Checks if current process has elevated administrator privileges.
#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let success = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            size,
            &mut size,
        );
        CloseHandle(token);
        success != 0 && elevation.TokenIsElevated != 0
    }
}

/// On non-Windows platforms, returns false.
#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// Error returned when administrator elevation is required but not present.
#[derive(Debug, Clone)]
pub struct ElevationRequiredError {
    pub drive: String,
}

impl fmt::Display for ElevationRequiredError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "================================================================================")?;
        writeln!(f, "[ELEVATION REQUISE] Administrator privileges required for hphe-indexd")?;
        writeln!(f, "================================================================================")?;
        writeln!(f, "Le demon hphe-indexd necessite les privileges administrateur pour acceder")?;
        writeln!(f, "directement au volume NTFS (\\\\.\\{}:) et surveiller le journal USN.", self.drive)?;
        writeln!(f)?;
        writeln!(f, "Pour executer le demon avec elevation :")?;
        writeln!(f, "  1. Ouvrez une invite PowerShell en tant qu'Administrateur (Run as Administrator)")?;
        writeln!(f, "  2. Lancez : hphe-indexd.exe --drive {}:", self.drive)?;
        writeln!(f)?;
        writeln!(f, "Ou installez le demon comme service / tache planifiee systeme :")?;
        writeln!(f, "  powershell -ExecutionPolicy Bypass -File scripts\\install.ps1")?;
        writeln!(f)?;
        writeln!(f, "Pour tester ou benchmarker sans elevation :")?;
        writeln!(f, "  hphe-indexd.exe --synthetic --synthetic-count 100000")?;
        writeln!(f, "================================================================================")
    }
}

impl std::error::Error for ElevationRequiredError {}

/// Checks elevation for target drive. Returns Ok(()) if elevated, or ElevationRequiredError.
pub fn check_elevation(drive: &str) -> Result<(), ElevationRequiredError> {
    if is_elevated() {
        Ok(())
    } else {
        Err(ElevationRequiredError {
            drive: drive.trim_end_matches([':', '\\', '/']).to_uppercase(),
        })
    }
}
