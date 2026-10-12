//! Predicate compilation and evaluation for query engine.
//!
//! This module compiles the AST into evaluable predicates that can be executed
//! against a FileIndex. The compilation optimizes for column-based operations
//! where possible (size, dates, attributes) and uses SIMD substring search via
//! memchr for name matching.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use crate::ast::*;
use crate::error::EvalError;

/// A predicate that can evaluate whether a row matches.
pub trait Predicate: Send + Sync {
    /// Evaluate the predicate against a row in the index.
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool;
    
    /// Get a description of the predicate for explain() output.
    fn describe(&self) -> String;
}

/// Wrap a predicate in an Arc for thread-safe sharing.
type ArcPredicate = Arc<dyn Predicate>;

/// A compiled query that can be evaluated against an index.
#[derive(Clone)]
pub struct CompiledQuery {
    /// The root predicate
    pub predicate: ArcPredicate,
    /// Original query string
    pub original: String,
}

impl CompiledQuery {
    pub fn new(predicate: ArcPredicate, original: String) -> Self {
        Self { predicate, original }
    }
    
    /// Evaluate the query against an index, returning an iterator over matching rows.
    pub fn evaluate<'a>(&'a self, index: &'a crate::FileIndex) -> impl Iterator<Item = usize> + 'a {
        QueryResults::new(index, self.predicate.clone())
    }
    
    /// Get an explanation of the query.
    pub fn explain(&self) -> String {
        self.predicate.describe()
    }
}

/// Results iterator for query evaluation.
pub struct QueryResults<'a> {
    index: &'a crate::FileIndex,
    predicate: ArcPredicate,
    current_row: usize,
    max_rows: usize,
}

impl<'a> QueryResults<'a> {
    pub fn new(index: &'a crate::FileIndex, predicate: ArcPredicate) -> Self {
        Self {
            index,
            predicate,
            current_row: 0,
            max_rows: index.len(),
        }
    }
    
    /// Collect all matching rows.
    pub fn collect_all(self) -> Vec<usize> {
        self.collect()
    }
    
    /// Count matching rows.
    pub fn count(self) -> usize {
        self.take(usize::MAX).count()
    }
    
    /// Check if any row matches.
    pub fn any(self) -> bool {
        self.take(1).next().is_some()
    }
}

impl<'a> Iterator for QueryResults<'a> {
    type Item = usize;
    
    fn next(&mut self) -> Option<Self::Item> {
        while self.current_row < self.max_rows {
            let row = self.current_row;
            self.current_row += 1;
            
            if self.predicate.evaluate(self.index, row) {
                return Some(row);
            }
        }
        None
    }
    
    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.max_rows - self.current_row;
        (0, Some(remaining))
    }
}

impl<'a> ExactSizeIterator for QueryResults<'a> {}

/// Compile an AST expression into a predicate.
pub fn compile_expr(expr: &Expr) -> Result<ArcPredicate, EvalError> {
    match expr {
        Expr::Term(term) => compile_term(term),
        Expr::Property(prop) => compile_property(prop),
        Expr::Not(expr) => compile_not(expr),
        Expr::And(exprs) => compile_and(exprs),
        Expr::Or(exprs) => compile_or(exprs),
        Expr::Group(expr) => compile_expr(expr),
    }
}

/// Compile a term into a predicate.
fn compile_term(term: &Term) -> Result<ArcPredicate, EvalError> {
    if term.is_regex {
        let regex = Regex::new(&term.text)?;
        Ok(Arc::new(RegexPredicate {
            pattern: regex,
            case_sensitive: false,
        }))
    } else if term.has_wildcards {
        // Convert wildcard to regex
        let regex_pattern = wildcard_to_regex(&term.text);
        let regex = Regex::new(&regex_pattern)?;
        Ok(Arc::new(RegexPredicate {
            pattern: regex,
            case_sensitive: false,
        }))
    } else if term.is_quoted {
        // Exact match predicate
        Ok(Arc::new(ExactNamePredicate {
            name: term.text.clone(),
        }))
    } else {
        // Substring match predicate (SIMD-accelerated via name_lower)
        Ok(Arc::new(SubstringPredicate {
            pattern: term.text.clone(),
        }))
    }
}

/// Compile a property filter into a predicate.
fn compile_property(prop: &PropertyFilter) -> Result<ArcPredicate, EvalError> {
    match prop {
        PropertyFilter::Path(p) => {
            if p.is_matchpath {
                Ok(Arc::new(MatchPathPredicate {
                    pattern: p.pattern.clone(),
                }))
            } else {
                Ok(Arc::new(PathPredicate {
                    pattern: p.pattern.clone(),
                }))
            }
        }
        PropertyFilter::Ext(e) => {
            let exts: Vec<String> = e.extensions.iter()
                .map(|ext| format!(".{}", ext))
                .collect();
            Ok(Arc::new(ExtensionPredicate { exts }))
        }
        PropertyFilter::Size(s) => Ok(Arc::new(SizePredicate {
            min_bytes: s.min_bytes,
            max_bytes: s.max_bytes,
            equal_bytes: s.size_bytes,
        })),
        PropertyFilter::DateModified(d) => compile_date_predicate(d, DateType::Modified),
        PropertyFilter::DateCreated(d) => compile_date_predicate(d, DateType::Created),
        PropertyFilter::DateAccessed(d) => compile_date_predicate(d, DateType::Accessed),
        PropertyFilter::Attrib(a) => Ok(Arc::new(AttribPredicate {
            flags: a.flags,
        })),
        PropertyFilter::Regex(r) => {
            let regex = Regex::new(&r.pattern)?;
            Ok(Arc::new(RegexPredicate {
                pattern: regex,
                case_sensitive: r.case_sensitive,
            }))
        }
        PropertyFilter::CaseSensitive(_) => {
            // Case sensitivity is handled at the predicate level
            Ok(Arc::new(NoopPredicate))
        }
        PropertyFilter::WholeWords(_) => {
            // Whole words matching - not yet implemented
            Ok(Arc::new(NoopPredicate))
        }
        PropertyFilter::FileType(ft) => Ok(Arc::new(FileTypePredicate {
            is_dir: matches!(ft, FileTypeFilter::Folder),
        })),
        PropertyFilter::Parents(n) => Ok(Arc::new(ParentsPredicate { depth: *n })),
        PropertyFilter::Dupe => Ok(Arc::new(DupePredicate)),
        PropertyFilter::StartWith(prefix) => Ok(Arc::new(StartWithPredicate {
            prefix: prefix.clone(),
        })),
        PropertyFilter::EndWith(suffix) => Ok(Arc::new(EndWithPredicate {
            suffix: suffix.clone(),
        })),
    }
}

/// Date types for date predicates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DateType {
    Modified,
    Created,
    Accessed,
}

/// Compile a date filter into a predicate.
fn compile_date_predicate(d: &DateFilter, date_type: DateType) -> Result<ArcPredicate, EvalError> {
    // Calculate timestamp bounds based on the date filter
    let (min_ts, max_ts) = calculate_date_bounds(d)?;
    
    Ok(Arc::new(DatePredicate {
        date_type,
        min_timestamp: min_ts,
        max_timestamp: max_ts,
    }))
}

/// Calculate timestamp bounds from a date filter.
fn calculate_date_bounds(d: &DateFilter) -> Result<(Option<i64>, Option<i64>), EvalError> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let now_secs = now.as_secs() as i64;
    let today_start = (now_secs / 86400) * 86400;
    let yesterday_start = today_start - 86400;
    
    if let Some(rel) = &d.relative {
        match rel {
            RelativeDate::Today => Ok((Some(today_start), Some(today_start + 86400))),
            RelativeDate::Yesterday => Ok((Some(yesterday_start), Some(yesterday_start + 86400))),
            RelativeDate::LastDays(n) => {
                let start = today_start - (*n as i64) * 86400;
                Ok((Some(start), Some(today_start)))
            }
            RelativeDate::ThisWeek => {
                // Simple: Monday to Sunday of current week
                let day_of_week = (today_start / 86400) % 7;
                let monday = today_start - (day_of_week * 86400);
                let sunday = monday + 7 * 86400;
                Ok((Some(monday), Some(sunday)))
            }
            RelativeDate::LastWeek => {
                let day_of_week = (today_start / 86400) % 7;
                let monday = today_start - (day_of_week * 86400) - 7 * 86400;
                let sunday = monday + 7 * 86400;
                Ok((Some(monday), Some(sunday)))
            }
            RelativeDate::ThisMonth => {
                // First to last day of current month
                let current_day = (today_start / 86400) % 30; // Approximate
                let month_start = today_start - (current_day * 86400);
                Ok((Some(month_start), Some(month_start + 30 * 86400)))
            }
            RelativeDate::LastMonth => {
                let current_day = (today_start / 86400) % 30;
                let last_month_start = today_start - (current_day * 86400) - 30 * 86400;
                Ok((Some(last_month_start), Some(last_month_start + 30 * 86400)))
            }
            RelativeDate::ThisYear => {
                let current_day = (today_start / 86400) % 365;
                let year_start = today_start - (current_day * 86400);
                Ok((Some(year_start), Some(year_start + 365 * 86400)))
            }
            RelativeDate::LastYear => {
                let current_day = (today_start / 86400) % 365;
                let last_year_start = today_start - (current_day * 86400) - 365 * 86400;
                Ok((Some(last_year_start), Some(last_year_start + 365 * 86400)))
            }
        }
    } else if let Some(days) = d.days {
        let start = today_start - (days * 86400);
        Ok((Some(start), Some(today_start)))
    } else if let (Some(min), Some(max)) = (d.min_timestamp, d.max_timestamp) {
        Ok((Some(min), Some(max)))
    } else if let Some(ts) = d.timestamp {
        Ok((Some(ts), Some(ts + 86400)))
    } else {
        Ok((None, None))
    }
}

/// Compile NOT expression.
fn compile_not(expr: &Expr) -> Result<ArcPredicate, EvalError> {
    let inner = compile_expr(expr)?;
    Ok(Arc::new(NotPredicate {
        inner,
    }))
}

/// Compile AND expression.
fn compile_and(exprs: &[Expr]) -> Result<ArcPredicate, EvalError> {
    if exprs.len() == 1 {
        return compile_expr(&exprs[0]);
    }
    
    let predicates: Result<Vec<ArcPredicate>, EvalError> = exprs
        .iter()
        .map(compile_expr)
        .collect();
    
    let predicates = predicates?;
    
    Ok(Arc::new(AndPredicate {
        predicates,
    }))
}

/// Compile OR expression.
fn compile_or(exprs: &[Expr]) -> Result<ArcPredicate, EvalError> {
    if exprs.len() == 1 {
        return compile_expr(&exprs[0]);
    }
    
    let predicates: Result<Vec<ArcPredicate>, EvalError> = exprs
        .iter()
        .map(compile_expr)
        .collect();
    
    let predicates = predicates?;
    
    Ok(Arc::new(OrPredicate {
        predicates,
    }))
}

/// Convert wildcard pattern to regex.
fn wildcard_to_regex(pattern: &str) -> String {
    let mut regex = String::new();
    regex.push('^');
    
    for c in pattern.chars() {
        match c {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            '.' => regex.push_str("\\."),
            '$' => regex.push_str("\\$"),
            '^' => regex.push_str("\\^"),
            '\\' => regex.push_str("\\\\"),
            '+' => regex.push_str("\\+"),
            '(' => regex.push_str("\\("),
            ')' => regex.push_str("\\)"),
            '[' => regex.push_str("\\["),
            ']' => regex.push_str("\\]"),
            '{' => regex.push_str("\\{"),
            '}' => regex.push_str("\\}"),
            '|' => regex.push_str("\\|"),
            _ => regex.push(c),
        }
    }
    
    regex.push('$');
    regex
}

// ============================================================================
// Predicate Implementations
// ============================================================================

/// No-op predicate (always matches).
struct NoopPredicate;

impl Predicate for NoopPredicate {
    fn evaluate(&self, _index: &crate::FileIndex, _row: usize) -> bool {
        true
    }
    
    fn describe(&self) -> String {
        "true".to_string()
    }
}

/// Substring match predicate (case-insensitive, uses index's name_lower).
struct SubstringPredicate {
    pattern: String,
}

impl Predicate for SubstringPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let name_lower = index.name_lower(row);
        name_lower.contains(&self.pattern.to_lowercase())
    }
    
    fn describe(&self) -> String {
        format!("name:*{}*", self.pattern)
    }
}

/// Exact name match predicate.
struct ExactNamePredicate {
    name: String,
}

impl Predicate for ExactNamePredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        index.name_lower(row) == self.name.to_lowercase()
    }
    
    fn describe(&self) -> String {
        format!("name={}", self.name)
    }
}

/// Extension match predicate.
struct ExtensionPredicate {
    exts: Vec<String>,
}

impl Predicate for ExtensionPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let name_lower = index.name_lower(row);
        if let Some(dot_pos) = name_lower.rfind('.') {
            let ext = &name_lower[dot_pos..];
            self.exts.iter().any(|e| ext == e.as_str())
        } else {
            false
        }
    }
    
    fn describe(&self) -> String {
        format!("ext:{}", self.exts.join(";"))
    }
}

/// Size range predicate.
struct SizePredicate {
    min_bytes: Option<u64>,
    max_bytes: Option<u64>,
    equal_bytes: Option<u64>,
}

impl Predicate for SizePredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let size = index.size(row);
        
        if let Some(min) = self.min_bytes {
            if size < min {
                return false;
            }
        }
        if let Some(max) = self.max_bytes {
            if size > max {
                return false;
            }
        }
        if let Some(eq) = self.equal_bytes {
            if size != eq {
                return false;
            }
        }
        true
    }
    
    fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(min) = self.min_bytes {
            parts.push(format!(">={}", min));
        }
        if let Some(max) = self.max_bytes {
            parts.push(format!("<={}", max));
        }
        if let Some(eq) = self.equal_bytes {
            parts.push(format!("={}", eq));
        }
        format!("size:{}", parts.join(" "))
    }
}

/// Date range predicate.
struct DatePredicate {
    date_type: DateType,
    min_timestamp: Option<i64>,
    max_timestamp: Option<i64>,
}

impl Predicate for DatePredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        
        let timestamp = match self.date_type {
            DateType::Modified => index.modified(row),
            DateType::Created => index.created(row),
            DateType::Accessed => index.accessed(row),
        };
        
        // Convert FILETIME to Unix timestamp (approximate)
        // FILETIME: 100ns intervals since 1601-01-01
        // Unix: seconds since 1970-01-01
        const FILETIME_EPOCH_DIFF: u64 = 116_444_736_000_000_000;
        let unix_ts = if timestamp >= FILETIME_EPOCH_DIFF {
            ((timestamp - FILETIME_EPOCH_DIFF) / 10_000_000) as i64
        } else {
            0
        };
        
        if let Some(min) = self.min_timestamp {
            if unix_ts < min {
                return false;
            }
        }
        if let Some(max) = self.max_timestamp {
            if unix_ts >= max {
                return false;
            }
        }
        true
    }
    
    fn describe(&self) -> String {
        let date_str = match self.date_type {
            DateType::Modified => "dm",
            DateType::Created => "dc",
            DateType::Accessed => "da",
        };
        
        let mut parts = Vec::new();
        if let Some(min) = self.min_timestamp {
            parts.push(format!(">={}", min));
        }
        if let Some(max) = self.max_timestamp {
            parts.push(format!("<{}", max));
        }
        format!("{}:{}", date_str, parts.join(" "))
    }
}

/// Attribute flags predicate.
struct AttribPredicate {
    flags: u32,
}

impl Predicate for AttribPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let raw_flags = index.raw_flags(row);
        (raw_flags & self.flags) == self.flags
    }
    
    fn describe(&self) -> String {
        format!("attrib:{:x}", self.flags)
    }
}

/// Regex match predicate.
struct RegexPredicate {
    pattern: Regex,
    case_sensitive: bool,
}

impl Predicate for RegexPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let name = index.name(row);
        if self.case_sensitive {
            self.pattern.is_match(name)
        } else {
            self.pattern.is_match(&name.to_lowercase())
        }
    }
    
    fn describe(&self) -> String {
        format!("regex:{}", self.pattern.to_string())
    }
}

/// Path prefix match predicate.
struct PathPredicate {
    pattern: String,
}

impl Predicate for PathPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let path = index.resolve_path(row);
        path.starts_with(&self.pattern)
    }
    
    fn describe(&self) -> String {
        format!("path:{}", self.pattern)
    }
}

/// Match path (full path match) predicate.
struct MatchPathPredicate {
    pattern: String,
}

impl Predicate for MatchPathPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let path = index.resolve_path(row);
        path == self.pattern
    }
    
    fn describe(&self) -> String {
        format!("matchpath:{}", self.pattern)
    }
}

/// File type (file/folder) predicate.
struct FileTypePredicate {
    is_dir: bool,
}

impl Predicate for FileTypePredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        index.is_dir(row) == self.is_dir
    }
    
    fn describe(&self) -> String {
        if self.is_dir {
            "folder:".to_string()
        } else {
            "file:".to_string()
        }
    }
}

/// Parents depth predicate.
struct ParentsPredicate {
    depth: usize,
}

impl Predicate for ParentsPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        // Count the number of parent levels
        let mut count = 0;
        let mut frn = index.parent_frn(row);
        
        while frn != 0 && frn != 5 && count <= self.depth {
            if let Some(next_row) = index.row_by_frn(frn) {
                frn = index.parent_frn(next_row);
                count += 1;
            } else {
                break;
            }
        }
        
        count >= self.depth
    }
    
    fn describe(&self) -> String {
        format!("parents:{}", self.depth)
    }
}

/// Duplicate files predicate (placeholder - would need hardlink detection).
struct DupePredicate;

impl Predicate for DupePredicate {
    fn evaluate(&self, _index: &crate::FileIndex, _row: usize) -> bool {
        // Placeholder - would need to track hardlinks
        false
    }
    
    fn describe(&self) -> String {
        "dupe:".to_string()
    }
}

/// Start with prefix predicate.
struct StartWithPredicate {
    prefix: String,
}

impl Predicate for StartWithPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let name_lower = index.name_lower(row);
        name_lower.starts_with(&self.prefix.to_lowercase())
    }
    
    fn describe(&self) -> String {
        format!("startwith:{}", self.prefix)
    }
}

/// End with suffix predicate.
struct EndWithPredicate {
    suffix: String,
}

impl Predicate for EndWithPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        if row >= index.len() {
            return false;
        }
        let name_lower = index.name_lower(row);
        name_lower.ends_with(&self.suffix.to_lowercase())
    }
    
    fn describe(&self) -> String {
        format!("endwith:{}", self.suffix)
    }
}

/// NOT predicate.
struct NotPredicate {
    inner: ArcPredicate,
}

impl Predicate for NotPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        !self.inner.evaluate(index, row)
    }
    
    fn describe(&self) -> String {
        format!("!({})", self.inner.describe())
    }
}

/// AND predicate.
struct AndPredicate {
    predicates: Vec<ArcPredicate>,
}

impl Predicate for AndPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        // Early exit on first failure
        for pred in &self.predicates {
            if !pred.evaluate(index, row) {
                return false;
            }
        }
        true
    }
    
    fn describe(&self) -> String {
        let parts: Vec<String> = self.predicates.iter()
            .map(|p| p.describe())
            .collect();
        format!("AND({})", parts.join(", "))
    }
}

/// OR predicate.
struct OrPredicate {
    predicates: Vec<ArcPredicate>,
}

impl Predicate for OrPredicate {
    fn evaluate(&self, index: &crate::FileIndex, row: usize) -> bool {
        // Early exit on first success
        for pred in &self.predicates {
            if pred.evaluate(index, row) {
                return true;
            }
        }
        false
    }
    
    fn describe(&self) -> String {
        let parts: Vec<String> = self.predicates.iter()
            .map(|p| p.describe())
            .collect();
        format!("OR({})", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hphe_index::FileIndex;
    use hphe_mft::record::MftEntry;
    
    fn make_entry(frn: u64, parent_frn: u64, name: &str, is_dir: bool, size: u64) -> MftEntry {
        MftEntry {
            frn,
            record_number: frn & 0x0000_FFFF_FFFF_FFFF,
            sequence_number: 1,
            parent_frn,
            parent_record_number: parent_frn & 0x0000_FFFF_FFFF_FFFF,
            name: name.to_string(),
            size,
            allocated_size: size,
            created: 132_000_000_000_000_000,
            modified: 133_000_000_000_000_000,
            accessed: 134_000_000_000_000_000,
            mft_changed: 133_000_000_000_000_000,
            attributes: if is_dir { 0x10 } else { 0x20 },
            is_dir,
            is_in_use: true,
            hard_links: 1,
            base_record_frn: 0,
        }
    }
    
    fn make_index() -> FileIndex {
        let entries = vec![
            make_entry(5, 5, "C:\\", true, 0),
            make_entry(10, 5, "Windows", true, 0),
            make_entry(20, 10, "System32", true, 0),
            make_entry(30, 20, "kernel32.dll", false, 1_000_000),
            make_entry(40, 20, "user32.dll", false, 800_000),
            make_entry(50, 5, "Users", true, 0),
            make_entry(60, 50, "Admin", true, 0),
            make_entry(70, 60, "test.pdf", false, 1024),
            make_entry(80, 60, "report.docx", false, 2048),
            make_entry(90, 60, "data.txt", false, 512),
        ];
        FileIndex::build(entries)
    }

    /// FileIndex is SoA: rows are sorted by name_lower, so row numbers are NOT
    /// insertion order. Resolve a row by its name to keep tests stable.
    fn row_of(index: &FileIndex, name: &str) -> usize {
        let target = name.to_lowercase();
        (0..index.len())
            .find(|&r| index.name_lower(r) == target)
            .unwrap_or_else(|| panic!("row {:?} not found in index", name))
    }
    
    #[test]
    fn test_substring_predicate() {
        let index = make_index();
        let pred: ArcPredicate = Arc::new(SubstringPredicate {
            pattern: "kernel".to_string(),
        });
        
        assert!(pred.evaluate(&index, row_of(&index, "kernel32.dll")));
        assert!(!pred.evaluate(&index, row_of(&index, "user32.dll")));
    }
    
    #[test]
    fn test_extension_predicate() {
        let index = make_index();
        let pred: ArcPredicate = Arc::new(ExtensionPredicate {
            exts: vec![".pdf".to_string(), ".docx".to_string()],
        });
        
        // Find rows with pdf and docx extensions
        let pdf_rows: Vec<usize> = (0..index.len())
            .filter(|&r| pred.evaluate(&index, r))
            .collect();
        
        assert!(pdf_rows.len() >= 2, "Expected at least 2 files with pdf/docx extension, found {}", pdf_rows.len());
    }
    
    #[test]
    fn test_size_predicate() {
        let index = make_index();
        let pred: ArcPredicate = Arc::new(SizePredicate {
            min_bytes: Some(1_000_000),
            max_bytes: None,
            equal_bytes: None,
        });
        
        assert!(pred.evaluate(&index, row_of(&index, "kernel32.dll"))); // 1MB
        assert!(!pred.evaluate(&index, row_of(&index, "user32.dll"))); // 800KB
    }
    
    #[test]
    fn test_and_predicate() {
        let index = make_index();
        let size_pred: ArcPredicate = Arc::new(SizePredicate {
            min_bytes: Some(1_000_000),
            max_bytes: None,
            equal_bytes: None,
        });
        let ext_pred: ArcPredicate = Arc::new(ExtensionPredicate {
            exts: vec![r#".dll"#.to_string()],
        });
        
        let and_pred: ArcPredicate = Arc::new(AndPredicate {
            predicates: vec![size_pred, ext_pred],
        });
        
        assert!(and_pred.evaluate(&index, row_of(&index, "kernel32.dll")));
        assert!(!and_pred.evaluate(&index, row_of(&index, "user32.dll"))); // too small
    }
    
    #[test]
    fn test_not_predicate() {
        let index = make_index();
        let dir_pred: ArcPredicate = Arc::new(FileTypePredicate { is_dir: true });
        let not_dir_pred: ArcPredicate = Arc::new(NotPredicate { inner: dir_pred });
        
        assert!(not_dir_pred.evaluate(&index, row_of(&index, "kernel32.dll"))); // file
        assert!(!not_dir_pred.evaluate(&index, row_of(&index, "C:\\"))); // dir
    }
    
    #[test]
    fn test_or_predicate() {
        let index = make_index();
        let pdf_pred: ArcPredicate = Arc::new(ExtensionPredicate {
            exts: vec![r#".pdf"#.to_string()],
        });
        let docx_pred: ArcPredicate = Arc::new(ExtensionPredicate {
            exts: vec![r#".docx"#.to_string()],
        });
        
        let or_pred: ArcPredicate = Arc::new(OrPredicate {
            predicates: vec![pdf_pred, docx_pred],
        });
        
        assert!(or_pred.evaluate(&index, row_of(&index, "test.pdf")));
        assert!(or_pred.evaluate(&index, row_of(&index, "report.docx")));
        assert!(!or_pred.evaluate(&index, row_of(&index, "data.txt")));
    }
}
