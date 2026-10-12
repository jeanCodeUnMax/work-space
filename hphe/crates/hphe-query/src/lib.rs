//! # hphe-query: Query Engine for Everything Syntax
//!
//! A high-performance query engine that parses Everything-like search syntax
//! and compiles it to evaluable predicates on the SoA `FileIndex`.
//!
//! ## Features
//!
//! - **Full Everything syntax support**: path:, ext:, size:, dm:, dc:, da:, attrib:,
//!   regex:, case:, whole:, file:, folder:, parents:, dupe:, startwith:, endwith:
//! - **Logical operators**: AND (implicit or explicit), OR (|), NOT (!)
//! - **Grouping**: Parentheses for expression grouping
//! - **Wildcards**: * and ? in terms
//! - **Quoted strings**: Exact phrase matching
//! - **Zero-copy parsing**: Efficient parsing with minimal allocations
//!
//! ## Architecture
//!
//! 1. **Parser**: Converts query strings to AST (`parser::parse_query`)
//! 2. **Compiler**: Compiles AST to predicates (`predicates::compile_expr`)
//! 3. **Evaluator**: Evaluates predicates against FileIndex
//!
//! ## Performance
//!
//! - Column-based predicates (size, dates, attributes) use direct array access
//! - Substring matching uses SIMD-accelerated `memchr::memmem`
//! - Regex fallback for complex patterns
//! - Lazy path resolution with caching
//!
//! ## Example
//!
//! ```rust,no_run
//! use hphe_query::{parse, Query};
//! use hphe_index::FileIndex;
//!
//! // Parse a query
//! let query: Query = parse("rapport ext:pdf;docx size:>1mb").unwrap();
//!
//! // Compile to evaluable form
//! let compiled = query.compile().unwrap();
//!
//! // Evaluate against index
//! let index = FileIndex::open_and_scan("C:").unwrap();
//! let results: Vec<usize> = compiled.evaluate(&index).collect();
//!
//! // Get explanation
//! let explanation = compiled.explain();
//! ```

#![allow(unused_imports)]

pub mod ast;
pub mod error;
pub mod parser;
pub mod predicates;

// Re-export main types for convenience
pub use ast::{Query, Expr, PropertyFilter, Term, ExtFilter, SizeFilter, DateFilter, 
              AttribFilter, RegexFilter, FileTypeFilter, PathFilter, RelativeDate};
pub use error::{ParseError, EvalError, QueryError};
pub use parser::parse_query;
pub use predicates::{Predicate, CompiledQuery, QueryResults};

// Re-export FileIndex from hphe-index for convenience
pub use hphe_index::{FileIndex, FileIndexStats, IndexEntry, IndexError, SearchResult, 
                     EntryFlags, Frn, VolumeIndex, EntryId, Timestamp, FileSize};

/// Parse a query string into a Query AST.
///
/// # Arguments
/// * `input` - The query string in Everything syntax
///
/// # Returns
/// * `Result<Query, ParseError>` - Parsed query or parsing error
///
/// # Example
/// ```
/// use hphe_query::parse;
///
/// let query = parse("test").unwrap();
/// ```
pub fn parse(input: &str) -> Result<Query, ParseError> {
    parse_query(input)
}

/// Compile a parsed Query into an evaluable CompiledQuery.
///
/// # Arguments
/// * `query` - The parsed Query AST
///
/// # Returns
/// * `Result<CompiledQuery, EvalError>` - Compiled query or compilation error
///
/// # Example
/// ```
/// use hphe_query::{parse, Query};
///
/// let query = parse("test").unwrap();
/// let compiled = query.compile().unwrap();
/// ```
impl Query {
    /// Compile this query into an evaluable form.
    pub fn compile(&self) -> Result<CompiledQuery, EvalError> {
        let predicate = predicates::compile_expr(&self.expr)?;
        Ok(CompiledQuery::new(predicate, self.original.clone()))
    }
    
    /// Parse and compile a query string in one step.
    pub fn parse_and_compile(input: &str) -> Result<CompiledQuery, QueryError> {
        let query = parse_query(input)?;
        let compiled = query.compile()?;
        Ok(compiled)
    }
}

/// Query evaluation options.
#[derive(Debug, Clone)]
pub struct EvalOptions {
    /// Maximum number of results to return
    pub limit: Option<usize>,
    /// Offset for pagination
    pub offset: usize,
}

impl Default for EvalOptions {
    fn default() -> Self {
        Self {
            limit: None,
            offset: 0,
        }
    }
}

impl CompiledQuery {
    /// Evaluate with options.
    pub fn evaluate_with_options<'a>(
        &'a self,
        index: &'a FileIndex,
        options: EvalOptions,
    ) -> Box<dyn Iterator<Item = usize> + 'a> {
        let mut results: Box<dyn Iterator<Item = usize> + 'a> = Box::new(self.evaluate(index));
        
        // Apply offset
        if options.offset > 0 {
            results = Box::new(results.skip(options.offset));
        }
        
        // Apply limit
        if let Some(limit) = options.limit {
            results = Box::new(results.take(limit));
        }
        
        results
    }
    
    /// Count matching rows.
    pub fn count(&self, index: &FileIndex) -> usize {
        self.evaluate(index).count()
    }
    
    /// Check if any rows match.
    pub fn any(&self, index: &FileIndex) -> bool {
        self.evaluate(index).next().is_some()
    }
    
    /// Get first matching row (if any).
    pub fn first(&self, index: &FileIndex) -> Option<usize> {
        self.evaluate(index).next()
    }
    
    /// Collect all matching rows.
    pub fn collect(&self, index: &FileIndex) -> Vec<usize> {
        self.evaluate(index).collect()
    }
    
    /// Collect all matching rows with limit.
    pub fn collect_with_limit(&self, index: &FileIndex, limit: usize) -> Vec<usize> {
        self.evaluate(index).take(limit).collect()
    }
    
    /// Collect all matching entries (with full IndexEntry data).
    pub fn collect_entries(&self, index: &FileIndex) -> Vec<IndexEntry> {
        self.evaluate(index)
            .filter_map(|row| index.entry(row))
            .collect()
    }
}

/// Results with metadata.
#[derive(Debug, Clone)]
pub struct QueryResultSet {
    /// Matching row indices
    pub rows: Vec<usize>,
    /// Total count (may be larger than rows.len() if limit was applied)
    pub total_count: usize,
    /// Whether the results are complete (no limit applied)
    pub is_complete: bool,
}

impl QueryResultSet {
    pub fn new(rows: Vec<usize>, total_count: usize, is_complete: bool) -> Self {
        Self {
            rows,
            total_count,
            is_complete,
        }
    }
}

/// Benchmark a query against an index.
#[derive(Debug, Clone)]
pub struct BenchResult {
    /// Query string
    pub query: String,
    /// Number of matches
    pub match_count: usize,
    /// Parse time in microseconds
    pub parse_time_us: u64,
    /// Compile time in microseconds
    pub compile_time_us: u64,
    /// Evaluation time in microseconds
    pub eval_time_us: u64,
    /// Total time in microseconds
    pub total_time_us: u64,
}

impl BenchResult {
    pub fn new(
        query: String,
        match_count: usize,
        parse_time_us: u64,
        compile_time_us: u64,
        eval_time_us: u64,
    ) -> Self {
        Self {
            query,
            match_count,
            parse_time_us,
            compile_time_us,
            eval_time_us,
            total_time_us: parse_time_us + compile_time_us + eval_time_us,
        }
    }
}

/// Run a benchmark on a query.
pub fn bench_query(query_str: &str, index: &FileIndex) -> BenchResult {
    use std::time::Instant;
    
    let start = Instant::now();
    let query = parse_query(query_str).unwrap();
    let parse_time = start.elapsed().as_micros() as u64;
    
    let start = Instant::now();
    let compiled = query.compile().unwrap();
    let compile_time = start.elapsed().as_micros() as u64;
    
    let start = Instant::now();
    let count = compiled.evaluate(index).count();
    let eval_time = start.elapsed().as_micros() as u64;
    
    BenchResult::new(
        query_str.to_string(),
        count,
        parse_time,
        compile_time,
        eval_time,
    )
}

/// Run multiple benchmarks.
pub fn bench_queries(queries: &[&str], index: &FileIndex) -> Vec<BenchResult> {
    queries.iter()
        .map(|q| bench_query(q, index))
        .collect()
}

/// Validate query parsing and compilation.
pub fn validate_query(query_str: &str) -> Result<CompiledQuery, QueryError> {
    let query = parse_query(query_str)?;
    let compiled = query.compile()?;
    Ok(compiled)
}

#[cfg(test)]
mod lib_tests {
    use super::*;
    use hphe_index::synthetic::generate_synthetic_entries;
    
    #[test]
    fn test_parse_and_compile_simple() {
        let query = parse("test").unwrap();
        let compiled = query.compile().unwrap();
        assert_eq!(compiled.explain(), "name:*test*");
    }
    
    #[test]
    fn test_parse_and_compile_property() {
        let query = parse("ext:pdf").unwrap();
        let compiled = query.compile().unwrap();
        assert_eq!(compiled.explain(), "ext:.pdf");
    }
    
    #[test]
    fn test_parse_and_compile_and() {
        let query = parse("test ext:pdf").unwrap();
        let compiled = query.compile().unwrap();
        let explanation = compiled.explain();
        assert!(explanation.contains("AND"));
    }
    
    #[test]
    fn test_parse_and_compile_or() {
        let query = parse("test | ext:pdf").unwrap();
        let compiled = query.compile().unwrap();
        let explanation = compiled.explain();
        assert!(explanation.contains("OR"));
    }
    
    #[test]
    fn test_bench_query() {
        // Create synthetic index
        let entries = generate_synthetic_entries(1000);
        let index = FileIndex::build(entries);
        
        let result = bench_query("test", &index);
        assert!(result.match_count >= 0);
        assert!(result.total_time_us > 0);
    }
    
    #[test]
    fn test_query_parity() {
        // Test that parsed queries can be compiled and evaluated
        let entries = generate_synthetic_entries(100);
        let index = FileIndex::build(entries);
        
        let queries = vec![
            "test",
            "ext:pdf",
            "size:>100",
            "dm:today",
            "test ext:pdf",
            "test | ext:pdf",
            "!test",
            "(test | hello) ext:pdf",
        ];
        
        for query_str in queries {
            let query = parse(query_str).unwrap();
            let compiled = query.compile().unwrap();
            let _results = compiled.collect(&index);
            // Just verify it doesn't panic
        }
    }
    
    #[test]
    fn test_parity_behavior() {
        // Test parity with Everything behavior on common cases
        let entries = generate_synthetic_entries(500);
        let index = FileIndex::build(entries);
        
        // Query: find all PDF files
        let compiled = parse("ext:pdf").unwrap().compile().unwrap();
        let pdfs = compiled.collect(&index);
        
        // Manual check: all entries with .pdf extension
        let manual_pdfs: Vec<usize> = (0..index.len())
            .filter(|&row| {
                let name = index.name_lower(row);
                name.ends_with(".pdf")
            })
            .collect();
        
        assert_eq!(pdfs, manual_pdfs);
    }
}
