//! hphe-index CLI
//!
//! `hphe-index scan C: --stats` — reads the live $MFT via hphe-mft and builds
//! the SoA index (requires elevation). Without elevation, automatically falls back
//! to synthetic MFT benchmark and documents the admin command.

use clap::{Parser, Subcommand};
use hphe_index::{FileIndex, IndexBuilder, IndexScanner};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(name = "hphe-index")]
#[command(about = "High-performance NTFS file index (SoA + SIMD substring scan)")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Scan a raw NTFS volume and build the index
    Scan {
        /// Target drive letter (e.g. "C:", "C", "D:")
        drive: String,

        /// Print detailed statistics and run query latency benchmark
        #[arg(long, default_value_t = false)]
        stats: bool,

        /// Build from synthetic entries instead of the real volume
        /// (no elevation needed). Value = number of entries.
        #[arg(long, default_value_t = 0)]
        synthetic: usize,

        /// Also run a query benchmark after the build
        #[arg(long, default_value_t = false)]
        bench: bool,
    },

    /// Benchmark build + queries on a synthetic index
    Bench {
        /// Number of synthetic entries (e.g. 1000000 or 16000000)
        #[arg(long, default_value_t = 1_000_000)]
        count: usize,

        /// Number of search queries to run
        #[arg(long, default_value_t = 100)]
        queries: usize,
    },
}

fn format_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;
    if bytes >= GIB {
        format!("{:.2} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.2} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.2} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

fn print_index_stats(index: &FileIndex) {
    let s = index.stats();
    let bpe = if s.entry_count > 0 {
        s.memory_usage_bytes as f64 / s.entry_count as f64
    } else {
        0.0
    };
    println!();
    println!("=== Index Statistics (SoA Layout) ===");
    println!("Entries:          {}", s.entry_count);
    println!("  Files:          {}", s.file_count);
    println!("  Directories:    {}", s.dir_count);
    println!("Total file size:  {}", format_bytes(s.total_size));
    println!("Avg name length:  {:.1} chars", s.avg_name_length);
    println!(
        "Memory usage:     {} ({:.1} B/entry)",
        format_bytes(s.memory_usage_bytes as u64),
        bpe
    );
    println!(
        "Estimated @16M:   {:.2} GiB (Target < 2.0 GiB)",
        bpe * 16_000_000.0 / 1_073_741_824.0
    );
    println!("Build time:       {} ms", s.build_time_ms);
}

/// Deterministic pseudo-random pattern set.
fn bench_patterns(n: usize) -> Vec<String> {
    const KEYWORDS: &[&str] = &[
        "dll", "exe", "sys", "cargo", "main", "config", "test",
        "log", "txt", "temp", "system", "windows", "admin", "debug",
        "release", "kernel", "user", "build", "node", "local",
    ];

    let mut patterns = Vec::with_capacity(n);
    for i in 0..n {
        patterns.push(KEYWORDS[i % KEYWORDS.len()].to_string());
    }
    patterns
}

/// Runs a substring-query benchmark on the index using SIMD memchr.
fn run_bench(index: &FileIndex, queries: usize) {
    let patterns = bench_patterns(queries);
    let mut total_hits = 0usize;
    let mut worst_us = 0u64;

    let wall = Instant::now();
    for p in &patterns {
        let t = Instant::now();
        let hits = index.find(p).count();
        let us = t.elapsed().as_micros() as u64;
        total_hits += hits;
        worst_us = worst_us.max(us);
    }
    let wall_us = wall.elapsed().as_micros() as u64;

    println!();
    println!("=== Query Benchmark (SIMD memchr substring scan) ===");
    println!("Queries:          {}", patterns.len());
    println!("Total hits:       {total_hits}");
    println!("Wall time:        {:.3} ms", wall_us as f64 / 1000.0);
    let avg_us = wall_us as f64 / patterns.len().max(1) as f64;
    println!(
        "Avg query:        {:.1} µs ({:.3} ms)",
        avg_us,
        avg_us / 1000.0
    );
    println!("Worst query:      {:.1} µs", worst_us as f64);
    let throughput = if avg_us > 0.0 {
        (index.len() as f64 / (avg_us / 1_000_000.0)) / 1_000_000.0
    } else {
        0.0
    };
    println!("Throughput:       {:.2} M entries/sec", throughput);
}

/// Path-resolution demo: resolve paths of sample rows.
fn sample_path_demo(index: &FileIndex) {
    let arc = Arc::new(index.stats()); // dummy check
    let _ = arc;
    let n = index.len().min(5);
    if n == 0 {
        return;
    }
    println!();
    println!("=== Sample Resolved Paths (parent_frn chain + segment cache) ===");
    for row in 0..n {
        println!("  [{:3}] {}", row, index.resolve_path(row));
    }
    println!("Cached directories: {}", index.path_cache_len());
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Commands::Scan {
            drive,
            stats,
            synthetic,
            bench,
        } => {
            if synthetic > 0 {
                println!("Building synthetic index ({synthetic} entries)...");
                let t = Instant::now();
                let index = IndexBuilder::from_synthetic(synthetic);
                println!("Built in {:.3} s", t.elapsed().as_secs_f64());
                if stats {
                    print_index_stats(&index);
                    run_bench(&index, 50);
                } else if bench {
                    run_bench(&index, 50);
                }
                sample_path_demo(&index);
                return ExitCode::SUCCESS;
            }

            // Real volume path — requires elevation.
            let drive_label = drive.trim_end_matches([':', '\\', '/']).to_uppercase();
            println!("Opening raw NTFS volume \\\\.\\{drive_label}: ...");

            match IndexScanner::scan(&drive_label) {
                Ok((index, s)) => {
                    println!("Scan+build finished in {:.3} s", s.total_duration_ms as f64 / 1000.0);
                    println!();
                    println!("=== MFT Scan ({}:) ===", s.drive);
                    println!("Records scanned:  {}", s.total_records);
                    println!(
                        "Valid entries:    {} ({:.2}%)",
                        s.valid_entries, s.valid_ratio_pct
                    );
                    println!("Scan duration:    {:.3} s", s.scan_duration.as_secs_f64());
                    println!("Index build:      {} ms", s.build_duration_ms);
                    println!(
                        "Peak working set: {}",
                        format_bytes(s.peak_working_set_bytes as u64)
                    );

                    if stats || bench {
                        print_index_stats(&index);
                        run_bench(&index, 50);
                    }
                    sample_path_demo(&index);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!();
                    eprintln!("================================================================================");
                    eprintln!("[AVERTISSEMENT ELEVATION REQUISE]");
                    eprintln!("L'ouverture du volume brut \\\\.\\{drive_label}: a echoue : {e}");
                    eprintln!();
                    eprintln!("Pour executer le scan reel MFT sur votre disque Windows :");
                    eprintln!("  1. Ouvrez un terminal PowerShell en Administrateur");
                    eprintln!("  2. Executez :");
                    eprintln!("     hphe-index.exe scan {drive_label}: --stats");
                    eprintln!();
                    eprintln!("--> Repli automatique sur bench MFT synthetique (1 000 000 entrees) :");
                    eprintln!("================================================================================");
                    eprintln!();

                    let count = 1_000_000;
                    let t = Instant::now();
                    let index = IndexBuilder::from_synthetic(count);
                    let build_time = t.elapsed();
                    println!("Index synthetique (1M entrees) construit en {:.3} s", build_time.as_secs_f64());

                    print_index_stats(&index);
                    run_bench(&index, 50);
                    sample_path_demo(&index);

                    ExitCode::SUCCESS
                }
            }
        }
        Commands::Bench { count, queries } => {
            println!("Building synthetic index ({count} entries)...");
            let t = Instant::now();
            let index = IndexBuilder::from_synthetic(count);
            println!("Built in {:.3} s", t.elapsed().as_secs_f64());
            print_index_stats(&index);
            run_bench(&index, queries);
            sample_path_demo(&index);
            ExitCode::SUCCESS
        }
    }
}
