//! Configuration management for hphe-indexd daemon.
//!
//! Supports configuration via CLI arguments and environment variables.

use clap::Parser;
use std::path::PathBuf;

/// High-Performance NTFS Indexing Daemon (Hephaistos Engine)
#[derive(Parser, Debug, Clone)]
#[command(name = "hphe-indexd")]
#[command(about = "High-performance NTFS file indexing and search daemon")]
#[command(version)]
pub struct DaemonConfig {
    /// Target volume drive letter (e.g. 'C', 'C:', 'D')
    #[arg(short = 'd', long = "drive", env = "HPHE_DRIVE", default_value = "C")]
    pub drive: String,

    /// Path to index snapshot file (default: %ProgramData%\hphe\index.snap)
    #[arg(short = 's', long = "snapshot", env = "HPHE_SNAPSHOT_PATH")]
    pub snapshot_path: Option<PathBuf>,

    /// Directory for USN checkpoints (default: %ProgramData%\hphe\checkpoints)
    #[arg(short = 'c', long = "checkpoint-dir", env = "HPHE_CHECKPOINT_DIR")]
    pub checkpoint_dir: Option<PathBuf>,

    /// Directory for logs (default: %ProgramData%\hphe\logs)
    #[arg(short = 'l', long = "log-dir", env = "HPHE_LOG_DIR")]
    pub log_dir: Option<PathBuf>,

    /// Named pipe path or name for IPC (default: \\.\pipe\hphe-index)
    #[arg(short = 'p', long = "pipe", env = "HPHE_PIPE_NAME", default_value = r"\\.\pipe\hphe-index")]
    pub pipe_name: String,

    /// USN journal polling interval in milliseconds
    #[arg(long = "poll-interval", env = "HPHE_POLL_INTERVAL_MS", default_value_t = 250)]
    pub poll_interval_ms: u64,

    /// Backlog threshold in bytes before triggering full index resync (default: 256 MiB)
    #[arg(long = "backlog-threshold", env = "HPHE_BACKLOG_THRESHOLD", default_value_t = 268_435_456)]
    pub backlog_threshold: u64,

    /// Force full MFT scan even if a valid snapshot is present
    #[arg(long = "force-rescan", env = "HPHE_FORCE_RESCAN", default_value_t = false)]
    pub force_rescan: bool,

    /// Run with synthetic index in-memory (no elevation required, useful for benchmark/test)
    #[arg(long = "synthetic", env = "HPHE_SYNTHETIC", default_value_t = false)]
    pub synthetic: bool,

    /// Number of synthetic entries to generate when --synthetic is set
    #[arg(long = "synthetic-count", default_value_t = 100_000)]
    pub synthetic_count: usize,

    /// Skip administrator elevation check (for testing and automation)
    #[arg(long = "no-elevation-check", env = "HPHE_NO_ELEVATION_CHECK", default_value_t = false)]
    pub no_elevation_check: bool,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            drive: "C".to_string(),
            snapshot_path: None,
            checkpoint_dir: None,
            log_dir: None,
            pipe_name: r"\\.\pipe\hphe-index".to_string(),
            poll_interval_ms: 250,
            backlog_threshold: 268_435_456,
            force_rescan: false,
            synthetic: false,
            synthetic_count: 100_000,
            no_elevation_check: false,
        }
    }
}

impl DaemonConfig {
    /// Returns the cleaned uppercase single drive character.
    pub fn drive_char(&self) -> char {
        self.drive
            .trim_end_matches([':', '\\', '/'])
            .chars()
            .next()
            .unwrap_or('C')
            .to_ascii_uppercase()
    }

    /// Returns the formatted drive string, e.g. "C:".
    pub fn drive_string(&self) -> String {
        format!("{}:", self.drive_char())
    }

    /// Returns the base directory for program data (%ProgramData%\hphe).
    pub fn base_program_data_dir() -> PathBuf {
        if let Ok(prog_data) = std::env::var("ProgramData") {
            PathBuf::from(prog_data).join("hphe")
        } else if let Ok(sys_drive) = std::env::var("SystemDrive") {
            PathBuf::from(format!("{sys_drive}\\ProgramData\\hphe"))
        } else {
            PathBuf::from(r"C:\ProgramData\hphe")
        }
    }

    /// Resolves snapshot path, falling back to %ProgramData%\hphe\index.snap.
    pub fn resolved_snapshot_path(&self) -> PathBuf {
        if let Some(ref path) = self.snapshot_path {
            path.clone()
        } else {
            Self::base_program_data_dir().join("index.snap")
        }
    }

    /// Resolves checkpoint directory, falling back to %ProgramData%\hphe\checkpoints.
    pub fn resolved_checkpoint_dir(&self) -> PathBuf {
        if let Some(ref dir) = self.checkpoint_dir {
            dir.clone()
        } else {
            Self::base_program_data_dir().join("checkpoints")
        }
    }

    /// Resolves log directory, falling back to %ProgramData%\hphe\logs.
    pub fn resolved_log_dir(&self) -> PathBuf {
        if let Some(ref dir) = self.log_dir {
            dir.clone()
        } else {
            Self::base_program_data_dir().join("logs")
        }
    }
}
