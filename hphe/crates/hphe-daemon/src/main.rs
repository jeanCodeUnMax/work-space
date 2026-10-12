//! Binary entry point for hphe-indexd daemon.

use clap::Parser;
use hphe_daemon::{check_elevation, init_logging, DaemonConfig, HpheDaemon};
use std::process::ExitCode;
use tracing::{error, info};

#[tokio::main]
async fn main() -> ExitCode {
    let config = DaemonConfig::parse();

    // Initialize logging (console + %ProgramData%\hphe\logs\hphe-indexd.log)
    let _guard = init_logging(&config.resolved_log_dir());

    info!(
        "hphe-indexd v{} starting (volume: {}, pipe: {})",
        env!("CARGO_PKG_VERSION"),
        config.drive_string(),
        config.pipe_name
    );

    // Verify administrator elevation early with clear message
    if !config.no_elevation_check && !config.synthetic {
        if let Err(elevation_err) = check_elevation(&config.drive_string()) {
            eprintln!("{elevation_err}");
            error!("Administrator privileges required. Exiting with code 2.");
            return ExitCode::from(2);
        }
    }

    // Boot daemon (load snapshot or scan MFT)
    let daemon = match HpheDaemon::boot(config) {
        Ok(d) => d,
        Err(e) => {
            error!("Failed to boot daemon: {e}");
            eprintln!("[FATAL] Failed to boot hphe-indexd: {e}");
            return ExitCode::from(1);
        }
    };

    // Run daemon until shutdown signal
    if let Err(e) = daemon.run().await {
        error!("Daemon runtime error: {e}");
        eprintln!("[FATAL] Daemon runtime error: {e}");
        return ExitCode::from(1);
    }

    info!("hphe-indexd terminated successfully");
    ExitCode::SUCCESS
}
