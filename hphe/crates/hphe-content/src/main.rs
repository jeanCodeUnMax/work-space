//! hphe-content CLI
//!
//! Subcommands:
//! - `index <dir> --index <tantivy_dir> [--ext ...] [--max-size ...]` — walk a
//!   directory tree and index all indexable text files.
//! - `search <tantivy_dir> <query> [--limit N]` — BM25 search with snippets.
//! - `bench <dir> --index <tantivy_dir> --docs N` — indexation throughput +
//!   query latency benchmark over a synthetic corpus.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use hphe_content::{
    ContentIndex, ContentIndexConfig, FileRow, IngestPolicy, IngestState,
};

#[derive(Parser, Debug)]
#[command(name = "hphe-content")]
#[command(about = "Tantivy content index (BM25 + snippets) — Hephaistos P3")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Walk a directory tree and index all indexable text files.
    Index {
        /// Directory to walk.
        dir: PathBuf,
        /// Tantivy index directory.
        #[arg(long)]
        index: PathBuf,
        /// Recreate the index from scratch.
        #[arg(long, default_value_t = false)]
        recreate: bool,
        /// Comma-separated extra extensions to include (e.g. "rs,md").
        #[arg(long)]
        ext: Option<String>,
        /// Max file size in bytes.
        #[arg(long, default_value_t = 2 * 1024 * 1024)]
        max_size: u64,
        /// Optional project tag applied to every indexed doc.
        #[arg(long, default_value = "cli")]
        project: String,
    },

    /// BM25 search with snippets.
    Search {
        /// Tantivy index directory.
        #[arg(long)]
        index: PathBuf,
        /// Query string.
        query: String,
        /// Max results.
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },

    /// Benchmark: build a synthetic corpus, index it, measure throughput.
    Bench {
        /// Directory to create the synthetic corpus in.
        dir: PathBuf,
        /// Tantivy index directory.
        #[arg(long)]
        index: PathBuf,
        /// Number of synthetic documents.
        #[arg(long, default_value_t = 10_000)]
        docs: usize,
        /// Number of search queries to time.
        #[arg(long, default_value_t = 100)]
        queries: usize,
    },
}

fn format_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    if bytes >= MIB {
        format!("{:.2} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.2} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

/// Recursively collects file paths under `root`.
fn walk(root: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.is_file() {
            out.push(p);
        }
    }
}

fn cmd_index(
    dir: &Path,
    index_dir: &Path,
    recreate: bool,
    extra_ext: Option<&str>,
    max_size: u64,
    project: &str,
) -> std::process::ExitCode {
    let mut policy = IngestPolicy::default();
    if let Some(exts) = extra_ext {
        for e in exts.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let e = e.trim_start_matches('.').to_ascii_lowercase();
            if !policy.exts.contains(&e) {
                policy.exts.push(e);
            }
        }
    }
    policy.max_file_size = max_size;

    let idx = if recreate && index_dir.exists() {
        let _ = std::fs::remove_dir_all(index_dir);
        ContentIndex::create(index_dir, ContentIndexConfig::default()).unwrap()
    } else {
        ContentIndex::open_or_create(index_dir, ContentIndexConfig::default()).unwrap()
    };

    let mut files = Vec::new();
    walk(dir, &mut files);
    println!("Walking {} files under {}", files.len(), dir.display());

    let t = Instant::now();
    let mut state = IngestState::new();
    let mut frn_counter = 1u64;
    let mut rows = Vec::new();
    for f in &files {
        let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        let mtime = std::fs::metadata(f)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| 116_444_736_000_000_000u64 + d.as_nanos() as u64 / 100)
            .unwrap_or(0);
        let path = f.to_string_lossy().replace('\\', "/");
        rows.push(FileRow {
            frn: frn_counter,
            path,
            size,
            mtime_filetime: mtime,
            project_tag: project.to_string(),
        });
        frn_counter += 1;
    }

    let touched = idx.ingest_rows(rows, &policy, &mut state).unwrap();
    idx.commit().unwrap();
    let elapsed = t.elapsed().as_secs_f64();

    println!("Indexed {touched} documents in {:.3}s", elapsed);
    println!("Total docs in index: {}", idx.num_docs());
    if elapsed > 0.0 {
        println!("Throughput: {:.1} docs/s", touched as f64 / elapsed);
    }
    ExitCode::SUCCESS
}

fn cmd_search(index_dir: &Path, query: &str, limit: usize) -> std::process::ExitCode {
    let idx = ContentIndex::open(index_dir, ContentIndexConfig::default()).unwrap();
    let hits = idx.search_bm25(query, limit).unwrap();
    println!("{} hits for {:?}", hits.len(), query);
    for h in &hits {
        println!(
            "  [{:.4}] frn={} ext={} size={} {}",
            h.score, h.frn, h.ext, format_bytes(h.size), h.path
        );
        // Strip <b> tags for terminal display.
        let snip = h.snippet_html.replace("<b>", "").replace("</b>", "");
        let snip = snip.split_whitespace().collect::<Vec<_>>().join(" ");
        println!("        {}", snip);
    }
    ExitCode::SUCCESS
}

fn cmd_bench(dir: &Path, index_dir: &Path, docs: usize, queries: usize) -> std::process::ExitCode {
    let _ = std::fs::remove_dir_all(index_dir);
    let idx = ContentIndex::create(index_dir, ContentIndexConfig::default()).unwrap();

    // Build a synthetic corpus of `docs` files in `dir`, then index them.
    let _ = std::fs::create_dir_all(dir);
    const WORDS: &[&str] = &[
        "retry", "policy", "backoff", "exponential", "http", "client",
        "token", "refresh", "session", "cache", "index", "query", "segment",
        "tantivy", "bm25", "score", "snippet", "hphe", "engine", "rust",
    ];

    let t = Instant::now();
    let mut rows = Vec::with_capacity(docs);
    for i in 0..docs {
        // Deterministic pseudo-content.
        let mut content = String::with_capacity(400);
        for j in 0..40 {
            content.push_str(WORDS[(i + j) % WORDS.len()]);
            content.push(' ');
        }
        rows.push(FileRow {
            frn: i as u64 + 1,
            path: format!("synthetic/doc_{i}.txt"),
            size: content.len() as u64,
            mtime_filetime: 1_320_000_000_000_000_000,
            project_tag: "bench".to_string(),
        });
    }
    // upsert directly with in-memory content (no disk round-trip).
    let mut state = IngestState::new();
    // Use ingest_rows path but it reads from disk; instead upsert directly.
    let _ = &mut state;
    let t_index = Instant::now();
    for r in &rows {
        let content = WORDS
            .iter()
            .cycle()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        idx.upsert_row(r, &content).unwrap();
    }
    idx.commit().unwrap();
    let index_elapsed = t_index.elapsed().as_secs_f64();
    let total_elapsed = t.elapsed().as_secs_f64();

    println!("=== Content Index Benchmark (tantivy BM25) ===");
    println!("Documents:        {docs}");
    println!("Index build:      {:.3}s ({:.1} docs/s)", index_elapsed, docs as f64 / index_elapsed.max(1e-9));
    println!("Total (incl corpus gen): {:.3}s", total_elapsed);
    println!("Docs in index:    {}", idx.num_docs());

    // Query latency.
    let t_query = Instant::now();
    let mut total_hits = 0usize;
    for i in 0..queries {
        let q = WORDS[i % WORDS.len()];
        let hits = idx.search_bm25(q, 10).unwrap();
        total_hits += hits.len();
    }
    let query_elapsed = t_query.elapsed().as_secs_f64();
    let avg_us = query_elapsed / queries.max(1) as f64 * 1_000_000.0;
    println!();
    println!("=== Query Benchmark ===");
    println!("Queries:          {queries}");
    println!("Total hits:       {total_hits}");
    println!("Avg query:        {:.1} µs", avg_us);

    ExitCode::SUCCESS
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Commands::Index { dir, index, recreate, ext, max_size, project } => {
            cmd_index(&dir, &index, recreate, ext.as_deref(), max_size, &project)
        }
        Commands::Search { index, query, limit } => cmd_search(&index, &query, limit),
        Commands::Bench { dir, index, docs, queries } => cmd_bench(&dir, &index, docs, queries),
    }
}
