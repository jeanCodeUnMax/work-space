//! # hphe-daemon: High-Performance NTFS Indexing Daemon (hphe-indexd)
//!
//! Autonomous, elevated daemon assembling:
//! - Direct NTFS $MFT scanning (`hphe-mft`)
//! - Struct-of-Arrays (SoA) File Index + mmap snapshot persistence (`hphe-index`)
//! - Everything syntax query compilation and evaluation (`hphe-query`)
//! - Continuous USN journal deltas with wrap recovery (`hphe-usn`)
//! - Secure Named Pipe NDJSON IPC server (`hphe-ipc`)
//!
//! ## Windows Service Architecture
//! In Phase 2 (P2), hphe-indexd runs as an elevated background process managed
//! via Windows Task Scheduler (`HIGHEST` privileges at boot).
//!
//! // TODO [P6]: Native Windows Service Control Manager (SCM) integration
//! // via `windows-service` crate (0.8+) for service start/stop/pause handlers,
//! // service status reporting, event log registration, and sc.exe lifecycle.
//! // Reference: Mullvad VPN windows-service architecture documented in T-002 (#309).

pub mod config;
pub mod daemon;
pub mod elevation;
pub mod handler;
pub mod logging;

pub use config::DaemonConfig;
pub use daemon::{DaemonError, HpheDaemon};
pub use elevation::{check_elevation, is_elevated, ElevationRequiredError};
pub use handler::DaemonHandler;
pub use logging::init_logging;

/// Default named pipe name: \\.\pipe\hphe-index
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\hphe-index";
