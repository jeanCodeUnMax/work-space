//! Core HpheDaemon orchestrator.
//!
//! Orchestrates the boot sequence (snapshot load or MFT scan),
//! live USN delta polling, and concurrent named pipe NDJSON server.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hphe_index::{generate_synthetic_entries, EntryFlags, FileIndex};
use hphe_ipc::protocol::UsnEvent;
use hphe_ipc::server::{NamedPipeServerBuilder, WatchState};
use hphe_usn::{FileDelta, UsnConfig, UsnError, UsnWatcher};
use thiserror::Error;
use tracing::{error, info, warn};

use crate::config::DaemonConfig;
use crate::elevation::{check_elevation, ElevationRequiredError};
use crate::handler::DaemonHandler;

/// Errors produced during daemon initialization and runtime.
#[derive(Debug, Error)]
pub enum DaemonError {
    #[error(transparent)]
    ElevationRequired(#[from] ElevationRequiredError),

    #[error("Index error: {0}")]
    Index(#[from] hphe_index::IndexError),

    #[error("Snapshot error: {0}")]
    Snapshot(#[from] hphe_index::SnapshotError),

    #[error("MFT reader error: {0}")]
    Mft(#[from] hphe_mft::MftError),

    #[error("USN watcher error: {0}")]
    Usn(#[from] hphe_usn::UsnError),

    #[error("IPC server error: {0}")]
    Ipc(#[from] hphe_ipc::error::IpcError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

/// The main Hephaistos indexing daemon.
#[derive(Debug)]
pub struct HpheDaemon {
    config: DaemonConfig,
    index: Arc<FileIndex>,
    last_usn: Arc<AtomicI64>,
    is_running: Arc<AtomicBool>,
}

impl HpheDaemon {
    /// Creates a new daemon instance and performs the complete boot sequence.
    pub fn boot(config: DaemonConfig) -> Result<Self, DaemonError> {
        let _drive_char = config.drive_char();
        let drive_str = config.drive_string();

        info!("Starting Hephaistos daemon (hphe-indexd) for volume {}", drive_str);

        // 1. Verify elevation unless explicitly skipped or running in synthetic mode
        if !config.no_elevation_check && !config.synthetic {
            check_elevation(&drive_str)?;
            info!("Administrator elevation confirmed for volume {}", drive_str);
        }

        let boot_start = Instant::now();

        // 2. Index initialization: synthetic OR snapshot load OR MFT scan
        let index = if config.synthetic {
            info!("Synthetic mode: generating {} entries in-memory...", config.synthetic_count);
            let gen_start = Instant::now();
            let entries = generate_synthetic_entries(config.synthetic_count);
            let idx = FileIndex::build_with_drive(&drive_str, entries);
            info!("Synthetic index built in {:.2?} ({} entries)", gen_start.elapsed(), idx.len());
            idx
        } else {
            let snap_path = config.resolved_snapshot_path();
            let mut loaded_index = None;

            if !config.force_rescan && snap_path.exists() {
                info!("Loading index snapshot from {}...", snap_path.display());
                let snap_start = Instant::now();
                match FileIndex::load_mmap(&snap_path) {
                    Ok(idx) => {
                        info!(
                            "Snapshot loaded via zero-copy mmap in {:.2?} ({} entries, {:.2} MiB RAM)",
                            snap_start.elapsed(),
                            idx.len(),
                            idx.compute_memory_usage() as f64 / (1024.0 * 1024.0)
                        );
                        loaded_index = Some(idx);
                    }
                    Err(e) => {
                        warn!("Snapshot load failed ({e}). Falling back to live MFT scan.");
                    }
                }
            }

            match loaded_index {
                Some(idx) => idx,
                None => {
                    info!("Scanning NTFS volume {} via direct $MFT reader...", drive_str);
                    let scan_start = Instant::now();
                    let idx = FileIndex::open_and_scan(&drive_str)?;
                    info!(
                        "Live MFT scan completed in {:.2?} ({} entries, {:.2} MiB RAM)",
                        scan_start.elapsed(),
                        idx.len(),
                        idx.compute_memory_usage() as f64 / (1024.0 * 1024.0)
                    );

                    // Trigger snapshot persistence in background thread
                    let index_arc = Arc::new(idx);
                    let idx_bg = index_arc.clone();
                    let save_target = snap_path.clone();
                    std::thread::spawn(move || {
                        if let Some(parent) = save_target.parent() {
                            let _ = std::fs::create_dir_all(parent);
                        }
                        info!("Saving index snapshot to {} in background...", save_target.display());
                        let save_start = Instant::now();
                        match idx_bg.save(&save_target) {
                            Ok(()) => info!("Background snapshot saved in {:.2?}", save_start.elapsed()),
                            Err(e) => warn!("Background snapshot save failed: {e}"),
                        }
                    });

                    return Ok(Self {
                        config,
                        index: index_arc,
                        last_usn: Arc::new(AtomicI64::new(0)),
                        is_running: Arc::new(AtomicBool::new(true)),
                    });
                }
            }
        };

        info!("Daemon boot sequence completed in {:.2?}", boot_start.elapsed());

        Ok(Self {
            config,
            index: Arc::new(index),
            last_usn: Arc::new(AtomicI64::new(0)),
            is_running: Arc::new(AtomicBool::new(true)),
        })
    }

    /// Access the loaded in-memory index.
    pub fn index(&self) -> Arc<FileIndex> {
        self.index.clone()
    }

    /// Access daemon configuration.
    pub fn config(&self) -> &DaemonConfig {
        &self.config
    }

    /// Starts the live USN watcher polling loop in a background thread.
    pub fn start_usn_watcher(
        &self,
        watch_state: Arc<WatchState>,
    ) -> std::thread::JoinHandle<()> {
        let drive_char = self.config.drive_char();
        let drive_str = self.config.drive_string();
        let index = self.index.clone();
        let last_usn_atomic = self.last_usn.clone();
        let is_running = self.is_running.clone();
        let poll_interval = Duration::from_millis(self.config.poll_interval_ms);

        let mut usn_config = UsnConfig::for_drive(&drive_char.to_string());
        usn_config.poll_interval_ms = self.config.poll_interval_ms;
        usn_config.backlog_threshold = self.config.backlog_threshold;
        usn_config.checkpoint_dir = Some(
            self.config
                .resolved_checkpoint_dir()
                .to_string_lossy()
                .to_string(),
        );

        let ws = watch_state;

        std::thread::spawn(move || {
            info!("Starting live USN watcher for volume {}", drive_str);

            let callback_index = index.clone();
            let callback_ws = ws.clone();

            let callback = Box::new(move |deltas: &[FileDelta], _stats: &hphe_usn::UsnStats| {
                for delta in deltas {
                    // 1. Live overlay application on FileIndex
                    match delta.delta_type {
                        hphe_usn::DeltaType::Delete => {
                            callback_index.apply_delete(delta.frn);
                        }
                        hphe_usn::DeltaType::RenameOld => {
                            callback_index.apply_rename_old(delta.frn);
                        }
                        hphe_usn::DeltaType::Create
                        | hphe_usn::DeltaType::RenameNew
                        | hphe_usn::DeltaType::BasicInfoChange
                        | hphe_usn::DeltaType::DataOverwrite
                        | hphe_usn::DeltaType::DataExtend
                        | hphe_usn::DeltaType::DataTruncate
                        | hphe_usn::DeltaType::Close => {
                            if let Some(ref name) = delta.name {
                                callback_index.add_entry(
                                    delta.frn,
                                    delta.parent_frn,
                                    name,
                                    0, // Size fetched lazily if needed
                                    delta.timestamp,
                                    delta.timestamp,
                                    delta.timestamp,
                                    EntryFlags::from_u32(delta.attributes),
                                );
                            }
                        }
                    }

                    // 2. Broadcast to IPC watch subscribers
                    let name = delta.name.clone().unwrap_or_default();
                    let is_dir = (delta.attributes & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY) != 0;
                    let path = if let Some(row) = callback_index.row_by_frn(delta.frn) {
                        callback_index.resolve_path(row)
                    } else {
                        format!("{}:\\{}", drive_char, name)
                    };

                    let event = UsnEvent {
                        volume: drive_char,
                        frn: delta.frn,
                        parent_frn: delta.parent_frn,
                        reason: delta.reason,
                        name,
                        path,
                        is_dir,
                        size: None,
                        modified: Some(delta.timestamp as u64),
                    };

                    callback_ws.broadcast(event);
                }
            });

            let mut watcher = match UsnWatcher::with_callback(
                &drive_char.to_string(),
                index.clone(),
                usn_config,
                callback,
            ) {
                Ok(w) => w,
                Err(e) => {
                    warn!("Failed to initialize USN watcher for volume {drive_str}: {e}");
                    return;
                }
            };

            while is_running.load(Ordering::Acquire) {
                match watcher.poll() {
                    Ok(()) => {
                        let current_usn = watcher.next_usn();
                        last_usn_atomic.store(current_usn, Ordering::Release);
                    }
                    Err(UsnError::JournalWrapDetected { old_journal_id, new_journal_id }) => {
                        warn!(
                            "USN journal wrap detected (ID changed from {old_journal_id} to {new_journal_id})! Volume resync required."
                        );
                        // Trigger volume rebuild
                        match FileIndex::open_and_scan(&drive_str) {
                            Ok(new_idx) => {
                                info!("Resynced index after USN wrap ({} entries)", new_idx.len());
                            }
                            Err(e) => error!("Failed to resync index after USN wrap: {e}"),
                        }
                    }
                    Err(UsnError::ElevationRequired { drive }) => {
                        error!("USN watcher access denied for volume {drive}. Terminating watcher loop.");
                        break;
                    }
                    Err(e) => {
                        warn!("USN polling error: {e}");
                    }
                }

                std::thread::sleep(poll_interval);
            }

            info!("USN watcher terminated for volume {}", drive_str);
        })
    }

    /// Runs the daemon: boots, starts background USN watcher, and serves IPC requests.
    pub async fn run(&self) -> Result<(), DaemonError> {
        let drive_char = self.config.drive_char();
        let pipe_name = self.config.pipe_name.clone();

        // 1. Build IPC RequestHandler
        let handler = DaemonHandler::new(
            self.index.clone(),
            self.last_usn.clone(),
            drive_char,
        );

        // 2. Build NamedPipeServer with restrictive DACL
        let mut server = NamedPipeServerBuilder::new()
            .pipe_name(&pipe_name)
            .apply_restrictive_acl(true)
            .build(handler);

        server.start().await?;
        let watch_state = server.state().watch_state.clone();

        // 3. Start live USN polling loop if not in synthetic mode
        let _usn_thread = if !self.config.synthetic {
            Some(self.start_usn_watcher(watch_state))
        } else {
            info!("Synthetic mode: skipping live USN hardware watcher.");
            None
        };

        info!("Daemon is listening on named pipe {} (ready for clients)", pipe_name);

        // 4. Run the named pipe server
        server.run().await?;

        // 5. Signal shutdown
        self.is_running.store(false, Ordering::Release);
        info!("Daemon stopped gracefully.");

        Ok(())
    }
}
