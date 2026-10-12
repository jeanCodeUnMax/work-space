//! CLI for hphe-usn: NTFS USN Journal Watcher
//!
//! This binary provides command-line tools for testing and benchmarking the USN journal watcher.
//!
//! ## Usage
//!
//! ```bash
//! # Query USN journal metadata for a volume
//! hphe-usn query C:
//!
//! # Start watching a volume (requires elevation)
//! hphe-usn watch C: --checkpoint-dir ./checkpoints
//!
//! # Benchmark USN reading performance
//! hphe-usn bench C: --iterations 100
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::{Parser, Subcommand, ValueEnum};
use tracing::{error, info, Level};
use tracing_subscriber::{fmt, EnvFilter};

use hphe_index::FileIndex;
use hphe_usn::{
    CheckpointStore, UsnConfig, UsnError, UsnWatcher, DEFAULT_POLL_INTERVAL_MS,
};

/// hphe-usn: NTFS USN Journal Watcher CLI
#[derive(Debug, Parser)]
#[command(name = "hphe-usn")]
#[command(author = "Hephaistos Team")]
#[command(version = "0.1.0")]
#[command(about = "Continuous USN journal monitoring for NTFS volumes", long_about = None)]
struct Cli {
    /// Enable verbose logging
    #[arg(short, long, default_value = "info")]
    #[arg(value_enum)]
    log_level: LogLevel,

    /// Subcommand to execute
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl From<LogLevel> for Level {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Error => Level::ERROR,
            LogLevel::Warn => Level::WARN,
            LogLevel::Info => Level::INFO,
            LogLevel::Debug => Level::DEBUG,
            LogLevel::Trace => Level::TRACE,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Query USN journal metadata for a volume
    Query {
        /// Drive letter to query (e.g., C, D)
        #[arg(value_name = "DRIVE")]
        drive: String,

        /// JSON output format
        #[arg(short, long)]
        json: bool,
    },

    /// Watch a volume for USN changes and apply to index
    Watch {
        /// Drive letter to watch (e.g., C, D)
        #[arg(value_name = "DRIVE")]
        drive: String,

        /// Directory for checkpoint files
        #[arg(short, long, value_name = "DIR")]
        checkpoint_dir: PathBuf,

        /// Poll interval in milliseconds
        #[arg(short, long, default_value_t = DEFAULT_POLL_INTERVAL_MS)]
        interval: u64,

        /// Number of poll iterations (0 = infinite)
        #[arg(short, long, default_value_t = 0)]
        iterations: u64,

        /// Use synthetic data instead of actual volume (no elevation required)
        #[arg(long)]
        synthetic: bool,
    },

    /// Run a benchmark of USN journal reading
    Bench {
        /// Drive letter to benchmark (e.g., C, D)
        #[arg(value_name = "DRIVE")]
        drive: String,

        /// Number of benchmark iterations
        #[arg(short, long, default_value_t = 10)]
        iterations: u32,

        /// Number of records to read per iteration
        #[arg(short, long, default_value_t = 1000)]
        records_per_iter: u32,

        /// Output benchmark results in JSON format
        #[arg(short, long)]
        json: bool,

        /// Use synthetic data (no elevation required)
        #[arg(long)]
        synthetic: bool,
    },

    /// Checkpoint management commands
    Checkpoint {
        /// Checkpoint subcommand
        #[command(subcommand)]
        command: CheckpointCommands,
    },
}

#[derive(Debug, Subcommand)]
enum CheckpointCommands {
    /// Save current checkpoint for a drive
    Save {
        /// Drive letter
        #[arg(value_name = "DRIVE")]
        drive: String,

        /// USN to save
        #[arg(short, long)]
        usn: i64,

        /// Journal ID
        #[arg(short, long)]
        journal_id: i64,

        /// First USN
        #[arg(short, long)]
        first_usn: i64,
    },

    /// Load checkpoint for a drive
    Load {
        /// Drive letter
        #[arg(value_name = "DRIVE")]
        drive: String,

        /// Checkpoint directory
        #[arg(short, long)]
        dir: Option<PathBuf>,
    },

    /// List all checkpoints
    List {
        /// Checkpoint directory
        #[arg(short, long)]
        dir: Option<PathBuf>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    // Initialize logging
    let level: Level = cli.log_level.into();
    fmt()
        .with_max_level(level)
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    match &cli.command {
        Commands::Query { drive, json } => {
            cmd_query(drive, *json)?;
        }
        Commands::Watch {
            drive,
            checkpoint_dir,
            interval,
            iterations,
            synthetic,
        } => {
            cmd_watch(drive, checkpoint_dir, *interval, *iterations, *synthetic)?;
        }
        Commands::Bench {
            drive,
            iterations,
            records_per_iter,
            json,
            synthetic,
        } => {
            cmd_bench(drive, *iterations, *records_per_iter, *json, *synthetic)?;
        }
        Commands::Checkpoint { command } => {
            cmd_checkpoint(command)?;
        }
    }

    Ok(())
}

fn cmd_query(drive: &str, json: bool) -> Result<(), UsnError> {
    use hphe_usn::journal::{query_usn_journal, UsnJournalData};
    use hphe_usn::Volume;

    info!("Querying USN journal for drive {}", drive);

    // Open volume
    let volume = Volume::open(drive)?;
    let handle = volume.volume_handle().ok_or(UsnError::ElevationRequired {
        drive: drive.to_string(),
    })?;

    // Query journal
    let journal_data: UsnJournalData = unsafe { query_usn_journal(handle)? }.into();

    if json {
        let json = serde_json::to_string_pretty(&journal_data)
            .map_err(|e| UsnError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        println!("{}", json);
    } else {
        println!("USN Journal Metadata for {}:", drive);
        println!("  Journal ID:        {}", journal_data.journal_id);
        println!("  First USN:        {}", journal_data.first_usn);
        println!("  Next USN:         {}", journal_data.next_usn);
        println!("  Lowest Valid USN: {}", journal_data.lowest_valid_usn);
        println!("  Current Max USN:  {}", journal_data.current_max_usn);
        println!("  Maximum Size:     {} bytes", journal_data.max_size);
    }

    Ok(())
}

fn cmd_watch(
    drive: &str,
    checkpoint_dir: &PathBuf,
    interval: u64,
    iterations: u64,
    synthetic: bool,
) -> Result<(), UsnError> {
    info!(
        "Starting USN watcher for {} (interval={}ms, iterations={})",
        drive, interval, iterations
    );

    if synthetic {
        info!("Using synthetic data - no elevation required");
        // Run with synthetic data
        run_synthetic_watch(drive, checkpoint_dir, interval, iterations)?;
    } else {
        // Run with real volume
        run_real_watch(drive, checkpoint_dir, interval, iterations)?;
    }

    Ok(())
}

fn run_synthetic_watch(
    drive: &str,
    checkpoint_dir: &PathBuf,
    interval: u64,
    iterations: u64,
) -> Result<(), UsnError> {
    info!("Running synthetic USN watcher for {}", drive);

    // Create index
    let index = Arc::new(FileIndex::new());

    // Create config
    let mut config = UsnConfig::for_drive(drive);
    config.poll_interval_ms = interval;
    config.checkpoint_dir = Some(checkpoint_dir.display().to_string());

    // Create watcher with memory checkpoint store
    let mut watcher = UsnWatcher::new(drive, index, config)?;

    // Run polling loop
    let mut count = 0;
    loop {
        if iterations > 0 && count >= iterations {
            break;
        }

        match watcher.poll() {
            Ok(_) => {
                info!(
                    "Poll {}: processed {} records, stats: {:?}",
                    count + 1,
                    watcher.stats().records_processed,
                    watcher.stats()
                );
            }
            Err(e) => {
                if count < iterations {
                    error!("Poll {} failed: {}", count + 1, e);
                }
            }
        }

        count += 1;

        if iterations > 0 && count < iterations {
            std::thread::sleep(Duration::from_millis(interval));
        }
    }

    info!("Synthetic watch completed: {} polls", count);

    Ok(())
}

fn run_real_watch(
    drive: &str,
    _checkpoint_dir: &PathBuf,
    _interval: u64,
    _iterations: u64,
) -> Result<(), UsnError> {
    // For real volume access, we need elevation
    // This is a placeholder - in production, this would use the actual watcher
    
    info!("Real volume watching requires administrator privileges");
    info!("Run this command as Administrator or use --synthetic for testing");
    
    // Try to open the volume to verify access
    let _volume = hphe_mft::volume::Volume::open(drive)
        .map_err(|_| UsnError::ElevationRequired {
            drive: drive.to_string(),
        })?;
    
    info!("Volume {} can be opened - watcher would run successfully with elevation", drive);
    
    Ok(())
}

fn cmd_bench(
    drive: &str,
    iterations: u32,
    records_per_iter: u32,
    json: bool,
    synthetic: bool,
) -> Result<(), UsnError> {
    info!(
        "Running benchmark: {} iterations, {} records/iter, synthetic={}",
        iterations, records_per_iter, synthetic
    );

    if synthetic {
        run_synthetic_bench(drive, iterations, records_per_iter, json)?;
    } else {
        info!("Benchmarking real volumes requires administrator privileges");
        info!("Use --synthetic for testing without elevation");
    }

    Ok(())
}

fn run_synthetic_bench(
    drive: &str,
    iterations: u32,
    records_per_iter: u32,
    json: bool,
) -> Result<(), UsnError> {
    use hphe_usn::journal::{USN_RECORD_V2, UsnRecordHeader};

    info!("Running synthetic benchmark for {}", drive);

    let mut total_time = Duration::default();
    let mut total_records = 0;

    for iter in 0..iterations {
        let start = Instant::now();
        
        // Generate synthetic USN records
        let mut buffer = Vec::new();
        
        for i in 0..records_per_iter {
            let frn = (iter as u64) * (records_per_iter as u64) + (i as u64);
            let parent_frn = 5; // Root directory
            let usn = (iter as i64) * (records_per_iter as i64) + (i as i64);
            let timestamp = (iter as i64) * 1000 + (i as i64);
            let reason = 0x00000001; // FILE_CREATE
            let name = format!("file_{}_{}.txt", iter, i);
            
            // Create a synthetic USN_RECORD_V2
            let name_bytes = name.encode_utf16().collect::<Vec<_>>();
            let name_len = (name_bytes.len() * 2) as u16;
            let record_len = USN_RECORD_V2::size_of() + name_len as usize;
            
            let mut record_buf = vec![0u8; record_len];
            
            let header = UsnRecordHeader {
                record_length: record_len as u32,
                major_version: 2,
                minor_version: 0,
            };
            
            // Write main record
            let record = USN_RECORD_V2 {
                header,
                FileReferenceNumber: frn,
                ParentFileReferenceNumber: parent_frn,
                Usn: usn,
                TimeStamp: timestamp,
                Reason: reason,
                SourceInfo: 0,
                SecurityId: 0,
                FileAttributes: 0x20, // FILE_ATTRIBUTE_ARCHIVE
                FileNameLength: name_len,
                FileNameOffset: USN_RECORD_V2::size_of() as u16,
            };
            
            let record_ptr = record_buf.as_mut_ptr();
            unsafe {
                std::ptr::copy_nonoverlapping(
                    &record as *const _ as *const u8,
                    record_ptr,
                    USN_RECORD_V2::size_of()
                );
            }
            
            // Write name
            for (j, &ch) in name_bytes.iter().enumerate() {
                let offset = USN_RECORD_V2::size_of() + j * 2;
                record_buf[offset..offset + 2].copy_from_slice(&ch.to_le_bytes());
            }
            
            buffer.extend(record_buf);
        }
        
        // "Process" the records (in a real benchmark, we'd parse them)
        let record_count = hphe_usn::journal::iter_usn_records(&buffer).count();
        total_records += record_count;
        
        let elapsed = start.elapsed();
        total_time += elapsed;
        
        if !json {
            println!(
                "Iteration {}: {} records in {:?} ({:.2} records/sec)",
                iter + 1,
                record_count,
                elapsed,
                record_count as f64 / elapsed.as_secs_f64()
            );
        }
    }

    let avg_records_per_sec = total_records as f64 / total_time.as_secs_f64();

    if json {
        let result = serde_json::json!({
            "drive": drive,
            "iterations": iterations,
            "records_per_iter": records_per_iter,
            "total_records": total_records,
            "total_time_ms": total_time.as_millis(),
            "avg_records_per_sec": avg_records_per_sec,
            "avg_time_per_record_ns": total_time.as_nanos() as f64 / total_records as f64
        });
        println!("{}", result);
    } else {
        println!("\nBenchmark Results:");
        println!("  Total time: {:?}", total_time);
        println!("  Total records: {}", total_records);
        println!("  Average: {:.2} records/sec", avg_records_per_sec);
        println!(
            "  Average per record: {:.2} ns",
            total_time.as_nanos() as f64 / total_records as f64
        );
    }

    Ok(())
}

fn cmd_checkpoint(command: &CheckpointCommands) -> Result<(), UsnError> {
    match command {
        CheckpointCommands::Save {
            drive,
            usn,
            journal_id,
            first_usn,
        } => {
            let dir = std::env::current_dir()?;
            let store = CheckpointStore::new(&dir);
            let checkpoint = hphe_usn::Checkpoint::new(drive, *journal_id, *usn, *first_usn);
            store.save(&checkpoint)?;
            info!("Saved checkpoint for {}: last_usn={}, journal_id={}", drive, usn, journal_id);
        }
        CheckpointCommands::Load { drive, dir } => {
            let current = std::env::current_dir()?;
            let path = dir.as_deref().unwrap_or(&current);
            let store = CheckpointStore::new(path);
            let checkpoint = store.load(drive)?;
            
            match checkpoint {
                Some(cp) => {
                    if dir.is_some() {
                        let json = serde_json::to_string_pretty(&cp)
                            .map_err(|e| UsnError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
                        println!("{}", json);
                    } else {
                        println!("Checkpoint for {}:", drive);
                        println!("  Journal ID: {}", cp.journal_id);
                        println!("  Last USN:   {}", cp.last_usn);
                        println!("  First USN:  {}", cp.first_usn);
                        println!("  Saved at:   {}", cp.saved_at);
                    }
                }
                None => {
                    println!("No checkpoint found for {}", drive);
                }
            }
        }
        CheckpointCommands::List { dir } => {
            let current = std::env::current_dir()?;
            let path = dir.as_deref().unwrap_or(&current);
            let store = CheckpointStore::new(path);
            let checkpoints = store.list()?;
            
            if dir.is_some() {
                let json = serde_json::to_string_pretty(&checkpoints)
                    .map_err(|e| UsnError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
                println!("{}", json);
            } else {
                println!("Checkpoints:");
                for cp in checkpoints {
                    println!(
                        "  {}: last_usn={}, journal_id={}, saved_at={}",
                        cp.drive_letter, cp.last_usn, cp.journal_id, cp.saved_at
                    );
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parsing() {
        // Test that the CLI can be parsed
        let args = vec!["hphe-usn", "query", "C:"];
        let cli: Result<Cli, _> = Cli::try_parse_from(args);
        assert!(cli.is_ok());
    }
}
