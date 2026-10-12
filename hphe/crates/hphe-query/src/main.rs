//! CLI for hphe-query: Query engine for Everything syntax.
//!
//! Usage:
//!   hphe-query <pattern> [options]
//!
//! Examples:
//!   hphe-query "test"
//!   hphe-query "ext:pdf size:>1mb"
//!   hphe-query "rapport" --bench --count 1000

use std::time::Instant;

use clap::Parser;
use hphe_index::synthetic::generate_synthetic_entries;
use hphe_index::FileIndex;

use hphe_query::{bench_queries, parse, CompiledQuery, EvalOptions};

/// Query engine CLI for Everything-like syntax on SoA FileIndex.
#[derive(Parser, Debug)]
#[command(name = "hphe-query")]
#[command(author = "Hephaistos Engine")]
#[command(version = "0.1.0")]
#[command(about = "Query engine for Everything syntax on SoA FileIndex", long_about = None)]
struct Args {
    /// The query pattern in Everything syntax
    #[arg(value_name = "PATTERN")]
    pattern: String,
    
    /// Number of synthetic entries to generate (default: 10000)
    #[arg(short, long, default_value = "10000")]
    count: usize,
    
    /// Run in benchmark mode
    #[arg(short, long)]
    bench: bool,
    
    /// Number of benchmark iterations
    #[arg(short, long, default_value = "1")]
    iterations: usize,
    
    /// Number of benchmark queries to run
    #[arg(short, long, default_value = "10")]
    queries: usize,
    
    /// Show query explanation
    #[arg(short, long)]
    explain: bool,
    
    /// Limit number of results
    #[arg(short, long)]
    limit: Option<usize>,
    
    /// Offset for results
    #[arg(short, long, default_value = "0")]
    offset: usize,
    
    /// Show statistics
    #[arg(short, long)]
    stats: bool,
    
    /// Verbose output
    #[arg(short, long)]
    verbose: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    
    // Parse the query
    let parse_start = Instant::now();
    let query = match parse(&args.pattern) {
        Ok(q) => q,
        Err(e) => {
            eprintln!("Parse error: {}", e);
            std::process::exit(1);
        }
    };
    let parse_time = parse_start.elapsed();
    
    if args.verbose {
        println!("Query: {}", args.pattern);
        println!("AST: {}", query.expr);
    }
    
    // Compile the query
    let compile_start = Instant::now();
    let compiled = match query.compile() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Compile error: {}", e);
            std::process::exit(1);
        }
    };
    let compile_time = compile_start.elapsed();
    
    if args.explain {
        println!("Explanation: {}", compiled.explain());
    }
    
    if args.verbose {
        println!("Compiled: {}", compiled.explain());
        println!("Parse time: {:?}", parse_time);
        println!("Compile time: {:?}", compile_time);
    }
    
    // Create synthetic index
    let index_start = Instant::now();
    let entries = generate_synthetic_entries(args.count);
    let index = FileIndex::build(entries);
    let index_time = index_start.elapsed();
    
    if args.stats {
        let stats = index.stats();
        println!("Index stats:");
        println!("  Entries: {}", stats.entry_count);
        println!("  Files: {}", stats.file_count);
        println!("  Directories: {}", stats.dir_count);
        println!("  Total size: {} bytes", stats.total_size);
        println!("  Memory usage: {} bytes", stats.memory_usage_bytes);
        println!("  Avg name length: {:.2} chars", stats.avg_name_length);
        println!("  Build time: {} ms", stats.build_time_ms);
        println!("  Index creation time: {:?}", index_time);
    }
    
    if args.bench {
        run_benchmark(&args, &compiled, &index)?;
    } else {
        run_query(&args, &compiled, &index)?;
    }
    
    Ok(())
}

fn run_query(args: &Args, compiled: &CompiledQuery, index: &FileIndex) -> Result<(), Box<dyn std::error::Error>> {
    let eval_options = EvalOptions {
        limit: args.limit,
        offset: args.offset,
    };
    
    let eval_start = Instant::now();
    let results: Vec<usize> = compiled.evaluate_with_options(index, eval_options).collect();
    let eval_time = eval_start.elapsed();
    
    if args.verbose {
        println!("Evaluation time: {:?}", eval_time);
        println!("Found {} results", results.len());
    }
    
    // Display results
    let total_count = compiled.count(index);
    
    if args.verbose {
        println!("Total matches: {}", total_count);
    }
    
    for row in &results {
        let path = index.resolve_path(*row);
        let _name = index.name(*row);
        let size = index.size(*row);
        let is_dir = index.is_dir(*row);
        
        let file_type = if is_dir { "DIR " } else { "    " };
        println!("{}{:12}  {}", file_type, size, path);
    }
    
    if args.verbose {
        println!("\nTotal: {} results (showing {})", total_count, results.len());
    }
    
    Ok(())
}

fn run_benchmark(args: &Args, compiled: &CompiledQuery, index: &FileIndex) -> Result<(), Box<dyn std::error::Error>> {
    println!("Running benchmark...");
    println!("Iterations: {}", args.iterations);
    println!("Queries: {}", args.queries);
    println!();
    
    // Warm up
    let _ = compiled.count(index);
    
    // Create a vector of query strings
    let queries: Vec<&str> = vec![&args.pattern; args.queries];
    
    // Run benchmarks
    let mut results = Vec::new();
    
    for _ in 0..args.iterations {
        let bench_results = bench_queries(&queries, index);
        results.extend(bench_results);
    }
    
    // Aggregate and display results
    println!("Benchmark Results:");
    println!("{:<40} {:>10} {:>12} {:>12} {:>12}", 
             "Query", "Matches", "Parse (us)", "Compile (us)", "Eval (us)");
    println!("{}", "-".repeat(80));
    
    for result in &results {
        println!("{:<40} {:>10} {:>12} {:>12} {:>12}", 
                 truncate(&result.query, 40),
                 result.match_count,
                 result.parse_time_us,
                 result.compile_time_us,
                 result.eval_time_us);
    }
    
    println!("{}", "-".repeat(80));
    
    // Calculate averages
    let total_parse: u64 = results.iter().map(|r| r.parse_time_us).sum();
    let total_compile: u64 = results.iter().map(|r| r.compile_time_us).sum();
    let total_eval: u64 = results.iter().map(|r| r.eval_time_us).sum();
    let total_matches: usize = results.iter().map(|r| r.match_count).sum();
    
    let avg_parse = total_parse as f64 / results.len() as f64;
    let avg_compile = total_compile as f64 / results.len() as f64;
    let avg_eval = total_eval as f64 / results.len() as f64;
    let avg_matches = total_matches as f64 / results.len() as f64;
    
    println!("{:<40} {:>10.1} {:>12.1} {:>12.1} {:>12.1}", 
             "AVERAGE", 
             avg_matches,
             avg_parse,
             avg_compile,
             avg_eval);
    
    println!();
    println!("Latency summary:");
    println!("  Parse: {:.1} us avg", avg_parse);
    println!("  Compile: {:.1} us avg", avg_compile);
    println!("  Evaluate: {:.1} us avg", avg_eval);
    println!("  Total: {:.1} us avg", avg_parse + avg_compile + avg_eval);
    
    Ok(())
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len-3])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_cli_parse() {
        // Just verify the CLI can be constructed
        let args = Args {
            pattern: "test".to_string(),
            count: 1000,
            bench: false,
            iterations: 1,
            queries: 1,
            explain: false,
            limit: None,
            offset: 0,
            stats: false,
            verbose: false,
        };
        
        assert_eq!(args.pattern, "test");
    }
}
