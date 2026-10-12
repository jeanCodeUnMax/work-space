//! CLI entry point for hphe-mft scanner.

use clap::{Parser, Subcommand};
use hphe_mft::{MftError, MftReader, VolumeError};
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(name = "hphe-mft")]
#[command(about = "High-performance direct NTFS MFT reader and scanner")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Scan a raw NTFS volume directly via $MFT
    Scan {
        /// Target drive letter (e.g. "C:", "C", "D:")
        drive: String,

        /// Display detailed scan metrics (record count, duration, peak RAM, valid percentage)
        #[arg(long, default_value_t = false)]
        stats: bool,

        /// Maximum number of records to preview
        #[arg(long, default_value_t = 0)]
        preview: usize,
    },
}

fn format_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;
    const TIB: u64 = 1024 * GIB;

    if bytes >= TIB {
        format!("{:.2} TiB", bytes as f64 / TIB as f64)
    } else if bytes >= GIB {
        format!("{:.2} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.2} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.2} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn format_ram(bytes: usize) -> String {
    format_bytes(bytes as u64)
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Commands::Scan { drive, stats, preview } => {
            let clean_drive = drive.trim_end_matches([':', '\\', '/']).to_uppercase();
            println!("Opening raw NTFS volume \\\\.\\{clean_drive}: ...");

            let mut reader = match MftReader::open_volume(&clean_drive) {
                Ok(r) => r,
                Err(MftError::Volume(VolumeError::ElevationRequired { drive: d })) => {
                    eprintln!();
                    eprintln!("[ERROR] Access denied opening raw volume \\\\.\\{d}:");
                    eprintln!("Administrator privileges are required to read raw NTFS volumes directly.");
                    eprintln!();
                    eprintln!("To run this scan with elevated privileges, execute:");
                    eprintln!("  1. Open an elevated PowerShell (Run as Administrator)");
                    eprintln!("  2. Run:");
                    eprintln!("     hphe-mft scan {d}: --stats");
                    eprintln!();
                    eprintln!("Or launch directly via PowerShell Start-Process:");
                    eprintln!("  Start-Process powershell -Verb RunAs -ArgumentList \"-NoExit -Command hphe-mft scan {d}: --stats\"");
                    return ExitCode::from(2);
                }
                Err(e) => {
                    eprintln!("[ERROR] Failed to initialize MFT reader: {e}");
                    return ExitCode::FAILURE;
                }
            };

            let boot = reader.boot_sector();
            println!("NTFS Geometry:");
            println!("  Bytes per sector:   {}", boot.bytes_per_sector);
            println!("  Sectors per cluster: {}", boot.sectors_per_cluster);
            println!("  Cluster size:       {} bytes", boot.cluster_size);
            println!("  File record size:   {} bytes", boot.file_record_size);
            println!("  MFT starting LCN:   {}", boot.mft_lcn);
            println!("  MFT real size:      {}", format_bytes(reader.mft_real_size()));
            println!("  MFT extents count:  {}", reader.mft_extents().len());
            println!("  Estimated records:  {}", reader.estimated_records_count());
            println!();

            println!("Streaming $MFT records...");
            let mut preview_count = 0usize;

            let result = reader.scan_records(|entry| {
                if preview > 0 && preview_count < preview {
                    println!(
                        "  [{}] FRN: 0x{:016X} | Parent: 0x{:016X} | Size: {:>10} | {}",
                        if entry.is_dir { "DIR " } else { "FILE" },
                        entry.frn,
                        entry.parent_frn,
                        entry.size,
                        entry.name
                    );
                    preview_count += 1;
                }
            });

            match result {
                Ok(metrics) => {
                    println!();
                    println!("Scan completed successfully.");
                    if stats || true {
                        let secs = metrics.duration.as_secs_f64();
                        let throughput = if secs > 0.0 {
                            (metrics.total_records as f64 / secs) as u64
                        } else {
                            0
                        };

                        println!();
                        println!("=== MFT Scan Statistics ===");
                        println!("Total records scanned:  {}", metrics.total_records);
                        println!(
                            "Valid entries (in-use): {} ({:.2}%)",
                            metrics.valid_entries, metrics.valid_ratio_pct
                        );
                        println!("  Directories:          {}", metrics.directories_count);
                        println!("  Files:                {}", metrics.files_count);
                        println!("Total payload size:     {}", format_bytes(metrics.total_file_size));
                        println!("Scan duration:          {:.3} s", secs);
                        println!("Throughput:             {} records/s", throughput);
                        println!("Peak Working Set (RAM): {}", format_ram(metrics.peak_working_set_bytes));
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("[ERROR] Scan terminated with error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}
