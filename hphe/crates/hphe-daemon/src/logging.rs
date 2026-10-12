//! Logging configuration for hphe-indexd daemon.
//!
//! Configures tracing subscriber with dual output:
//! 1. Console (stderr) formatted with levels and timestamps
//! 2. Log file in %ProgramData%\hphe\logs\hphe-indexd.log (daily rolling)

use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Initializes the daemon tracing system.
///
/// Returns a WorkerGuard that must be held alive for non-blocking file logging.
pub fn init_logging(log_dir: &Path) -> Option<WorkerGuard> {
    // Attempt to create log directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(log_dir) {
        eprintln!("[WARN] Unable to create log directory {}: {e}", log_dir.display());
    }

    let default_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,hphe_daemon=debug,hphe_usn=debug,hphe_ipc=debug"));

    // Console layer
    let console_layer = fmt::layer()
        .with_target(false)
        .with_thread_ids(false)
        .compact();

    // File appender layer (non-blocking daily rolling)
    let file_appender = tracing_appender::rolling::daily(log_dir, "hphe-indexd.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_writer(non_blocking);

    // Initialize subscriber with both layers
    let subscriber = tracing_subscriber::registry()
        .with(default_filter)
        .with(console_layer)
        .with(file_layer);

    // Set global default subscriber if not already set (e.g. during multiple test runs)
    if subscriber.try_init().is_ok() {
        Some(guard)
    } else {
        None
    }
}
