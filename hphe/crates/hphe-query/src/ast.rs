//! Abstract Syntax Tree for Everything-like query syntax.
//!
//! This module defines the AST nodes for parsing Everything query syntax.
//! The grammar supports:
//! - Terms (plain text)
//! - Property filters: path:, ext:, size:, dm:, dc:, da:, attrib:, regex:, case:, whole:, file:, folder:, parents:, dupe:
//! - Logical operators: AND (&), OR (|), NOT (!)
//! - Grouping with parentheses
//! - Quoted strings
//! - Wildcards: *, ?

use std::fmt;

/// A parsed query is a single expression (possibly with implicit AND chains).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    /// The root expression of the query
    pub expr: Expr,
    /// Original query string (for debugging/explain)
    pub original: String,
}

impl Query {
    pub fn new(expr: Expr, original: String) -> Self {
        Self { expr, original }
    }
}

impl fmt::Display for Query {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.expr)
    }
}

/// Expression types in the AST.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    /// A single term (word or phrase)
    Term(Term),
    
    /// Property filter: name:value or name:>value, etc.
    Property(PropertyFilter),
    
    /// Logical NOT
    Not(Box<Expr>),
    
    /// Logical AND (explicit or implicit)
    And(Vec<Expr>),
    
    /// Logical OR
    Or(Vec<Expr>),
    
    /// Grouped expression (parentheses)
    Group(Box<Expr>),
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Expr::Term(t) => write!(f, "{}", t),
            Expr::Property(p) => write!(f, "{}", p),
            Expr::Not(e) => write!(f, "!({})", e),
            Expr::And(exprs) => {
                let s: Vec<String> = exprs.iter().map(|e| e.to_string()).collect();
                write!(f, "AND({})", s.join(", "))
            }
            Expr::Or(exprs) => {
                let s: Vec<String> = exprs.iter().map(|e| e.to_string()).collect();
                write!(f, "OR({})", s.join(", "))
            }
            Expr::Group(e) => write!(f, "({})", e),
        }
    }
}

/// A term can be a plain word, a quoted string, or a wildcard pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    /// The raw text of the term
    pub text: String,
    /// Whether this term contains wildcards
    pub has_wildcards: bool,
    /// Whether this is a quoted phrase
    pub is_quoted: bool,
    /// Whether this should be treated as a regex pattern
    pub is_regex: bool,
}

impl Term {
    pub fn new(text: String) -> Self {
        let has_wildcards = text.contains('*') || text.contains('?');
        Self {
            text,
            has_wildcards,
            is_quoted: false,
            is_regex: false,
        }
    }
    
    pub fn quoted(text: String) -> Self {
        let has_wildcards = text.contains('*') || text.contains('?');
        Self {
            text,
            has_wildcards,
            is_quoted: true,
            is_regex: false,
        }
    }
    
    pub fn regex(pattern: String) -> Self {
        Self {
            text: pattern,
            has_wildcards: false,
            is_quoted: false,
            is_regex: true,
        }
    }
}

impl fmt::Display for Term {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_quoted {
            write!(f, "\"{}\"", self.text)
        } else if self.is_regex {
            write!(f, "regex:{}", self.text)
        } else {
            write!(f, "{}", self.text)
        }
    }
}

/// Property filter types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropertyFilter {
    /// Path property: path:C:\Windows
    Path(PathFilter),
    /// Extension property: ext:pdf or ext:pdf;docx;txt
    Ext(ExtFilter),
    /// Size property: size:>1mb or size:1kb..10mb
    Size(SizeFilter),
    /// Modified date: dm:>2024-01-01 or dm:7 (days)
    DateModified(DateFilter),
    /// Created date: dc:>2024-01-01
    DateCreated(DateFilter),
    /// Accessed date: da:>2024-01-01
    DateAccessed(DateFilter),
    /// Attributes: attrib:H or attrib:HSH or attrib:A
    Attrib(AttribFilter),
    /// Regex match: regex:^test
    Regex(RegexFilter),
    /// Case sensitive: case:yes or case:no
    CaseSensitive(bool),
    /// Whole words only: whole:yes or whole:no
    WholeWords(bool),
    /// File or directory: file: or folder:
    FileType(FileTypeFilter),
    /// Parents: parents:2 (exactly 2 levels up)
    Parents(usize),
    /// Duplicate files: dupe:
    Dupe,
    /// Start with: startwith:prefix
    StartWith(String),
    /// End with: endwith:suffix
    EndWith(String),
}

impl fmt::Display for PropertyFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PropertyFilter::Path(p) => write!(f, "path:{}", p.pattern),
            PropertyFilter::Ext(e) => write!(f, "ext:{}", e.extensions.join(";")),
            PropertyFilter::Size(s) => write!(f, "size:{}", s),
            PropertyFilter::DateModified(d) => write!(f, "dm:{}", d),
            PropertyFilter::DateCreated(d) => write!(f, "dc:{}", d),
            PropertyFilter::DateAccessed(d) => write!(f, "da:{}", d),
            PropertyFilter::Attrib(a) => write!(f, "attrib:{}", a),
            PropertyFilter::Regex(r) => write!(f, "regex:{}", r.pattern),
            PropertyFilter::CaseSensitive(s) => write!(f, "case:{}", if *s { "yes" } else { "no" }),
            PropertyFilter::WholeWords(s) => write!(f, "whole:{}", if *s { "yes" } else { "no" }),
            PropertyFilter::FileType(ft) => match ft {
                FileTypeFilter::File => write!(f, "file:"),
                FileTypeFilter::Folder => write!(f, "folder:"),
            },
            PropertyFilter::Parents(n) => write!(f, "parents:{}", n),
            PropertyFilter::Dupe => write!(f, "dupe:"),
            PropertyFilter::StartWith(s) => write!(f, "startwith:{}", s),
            PropertyFilter::EndWith(s) => write!(f, "endwith:{}", s),
        }
    }
}

/// Path filter for matchpath: or path: properties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathFilter {
    /// The path pattern to match
    pub pattern: String,
    /// Whether to match the full path
    pub is_matchpath: bool,
}

/// Extension filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtFilter {
    /// List of extensions to match (without dot, lowercase)
    pub extensions: Vec<String>,
}

/// Size filter with various operators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizeFilter {
    /// Size value in bytes
    pub size_bytes: Option<u64>,
    /// Minimum size in bytes
    pub min_bytes: Option<u64>,
    /// Maximum size in bytes
    pub max_bytes: Option<u64>,
    /// Whether to use equal comparison
    pub is_equal: bool,
}

impl SizeFilter {
    pub fn new_equal(bytes: u64) -> Self {
        Self {
            size_bytes: Some(bytes),
            min_bytes: None,
            max_bytes: None,
            is_equal: true,
        }
    }
    
    pub fn new_range(min_bytes: u64, max_bytes: u64) -> Self {
        Self {
            size_bytes: None,
            min_bytes: Some(min_bytes),
            max_bytes: Some(max_bytes),
            is_equal: false,
        }
    }
    
    pub fn new_min(min_bytes: u64) -> Self {
        Self {
            size_bytes: None,
            min_bytes: Some(min_bytes),
            max_bytes: None,
            is_equal: false,
        }
    }
    
    pub fn new_max(max_bytes: u64) -> Self {
        Self {
            size_bytes: None,
            min_bytes: None,
            max_bytes: Some(max_bytes),
            is_equal: false,
        }
    }
}

impl fmt::Display for SizeFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(size) = self.size_bytes {
            if self.is_equal {
                write!(f, "={}", size)
            } else {
                write!(f, ">={}", size)
            }
        } else if let Some(min) = self.min_bytes {
            if let Some(max) = self.max_bytes {
                write!(f, "{}..{}", min, max)
            } else {
                write!(f, ">{}", min)
            }
        } else if let Some(max) = self.max_bytes {
            write!(f, "<{}", max)
        } else {
            write!(f, "?")
        }
    }
}

/// Date filter for dm:, dc:, da: properties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DateFilter {
    /// Unix timestamp in seconds (for exact dates)
    pub timestamp: Option<i64>,
    /// Number of days relative to today
    pub days: Option<i64>,
    /// Date string (e.g., "2024-01-01")
    pub date_str: Option<String>,
    /// Range: min timestamp
    pub min_timestamp: Option<i64>,
    /// Range: max timestamp
    pub max_timestamp: Option<i64>,
    /// Relative dates: today, yesterday, last7days, etc.
    pub relative: Option<RelativeDate>,
}

/// Relative date specifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelativeDate {
    Today,
    Yesterday,
    LastDays(u32),
    ThisWeek,
    LastWeek,
    ThisMonth,
    LastMonth,
    ThisYear,
    LastYear,
}

impl fmt::Display for DateFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(ref rel) = self.relative {
            match rel {
                RelativeDate::Today => write!(f, "today"),
                RelativeDate::Yesterday => write!(f, "yesterday"),
                RelativeDate::LastDays(n) => write!(f, "{}d", n),
                RelativeDate::ThisWeek => write!(f, "week"),
                RelativeDate::LastWeek => write!(f, "lastweek"),
                RelativeDate::ThisMonth => write!(f, "month"),
                RelativeDate::LastMonth => write!(f, "lastmonth"),
                RelativeDate::ThisYear => write!(f, "year"),
                RelativeDate::LastYear => write!(f, "lastyear"),
            }
        } else if let Some(days) = self.days {
            write!(f, "{}d", days)
        } else if let Some(ref date) = self.date_str {
            write!(f, "{}", date)
        } else if let Some(min) = self.min_timestamp {
            if let Some(max) = self.max_timestamp {
                write!(f, "{}..{}", min, max)
            } else {
                write!(f, ">{}", min)
            }
        } else {
            write!(f, "?")
        }
    }
}

/// Attribute filter for attrib: property.
/// Uses Windows FILE_ATTRIBUTE_* flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttribFilter {
    /// Attribute flags to match (bitmask)
    pub flags: u32,
    /// Attribute flag names (for display)
    pub flag_names: String,
}

impl AttribFilter {
    pub const ARCHIVE: u32 = 0x20;
    pub const COMPRESSED: u32 = 0x800;
    pub const DIRECTORY: u32 = 0x10;
    pub const ENCRYPTED: u32 = 0x4000;
    pub const HIDDEN: u32 = 0x2;
    pub const NORMAL: u32 = 0x80;
    pub const READONLY: u32 = 0x1;
    pub const SYSTEM: u32 = 0x4;
    pub const TEMPORARY: u32 = 0x100;
}

impl fmt::Display for AttribFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.flag_names)
    }
}

/// Regex filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegexFilter {
    /// The regex pattern
    pub pattern: String,
    /// Whether case-sensitive
    pub case_sensitive: bool,
}

/// File type filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTypeFilter {
    File,
    Folder,
}

/// Helper to parse size strings (e.g., "1mb", "1.5gb", "100kb").
pub fn parse_size_size(s: &str) -> Result<u64, String> {
    let s = s.trim().to_lowercase();
    
    if s.ends_with("kb") {
        let num: f64 = s[..s.len()-2].parse().map_err(|_| "Invalid number")?;
        Ok((num * 1024.0) as u64)
    } else if s.ends_with("mb") {
        let num: f64 = s[..s.len()-2].parse().map_err(|_| "Invalid number")?;
        Ok((num * 1024.0 * 1024.0) as u64)
    } else if s.ends_with("gb") {
        let num: f64 = s[..s.len()-2].parse().map_err(|_| "Invalid number")?;
        Ok((num * 1024.0 * 1024.0 * 1024.0) as u64)
    } else if s.ends_with("tb") {
        let num: f64 = s[..s.len()-2].parse().map_err(|_| "Invalid number")?;
        Ok((num * 1024.0 * 1024.0 * 1024.0 * 1024.0) as u64)
    } else {
        s.parse::<u64>().map_err(|_| "Invalid size number".to_string())
    }
}

/// Helper to parse date strings.
pub fn parse_date_string(s: &str) -> Result<i64, String> {
    // Try parsing as ISO date: YYYY-MM-DD or YYYY/MM/DD
    // For simplicity, we'll just parse basic formats
    // Real implementation would use chrono or similar
    
    // Check for relative dates
    match s.to_lowercase().as_str() {
        "today" => {
            use std::time::{SystemTime, UNIX_EPOCH};
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            Ok(now.as_secs() as i64 / 86400 * 86400) // Start of today
        }
        "yesterday" => {
            use std::time::{SystemTime, UNIX_EPOCH};
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default();
            Ok((now.as_secs() as i64 / 86400 - 1) * 86400)
        }
        _ => {
            // Try parsing as YYYY-MM-DD
            let parts: Vec<&str> = s.split('-').collect();
            if parts.len() == 3 {
                let year: i32 = parts[0].parse().map_err(|_| "Invalid year")?;
                let month: u32 = parts[1].parse().map_err(|_| "Invalid month")?;
                let day: u32 = parts[2].parse().map_err(|_| "Invalid day")?;
                
                // Simple date calculation (not accounting for leap years, etc.)
                // This is a placeholder - real implementation would use chrono
                let month_i32 = month as i32;
                let day_i32 = day as i32;
                let total_days = (year - 1970) * 365 + (month_i32 - 1) * 30 + (day_i32 - 1);
                Ok(total_days as i64 * 86400)
            } else {
                // Try parsing as number of days
                s.parse::<i64>().map_err(|_| "Invalid date format".to_string())
            }
        }
    }
}

/// Parse attribute flag names into bitmask.
pub fn parse_attrib_flags(s: &str) -> Result<u32, String> {
    let mut flags = 0u32;
    
    for c in s.to_uppercase().chars() {
        match c {
            'A' => flags |= AttribFilter::ARCHIVE,
            'C' => flags |= AttribFilter::COMPRESSED,
            'D' => flags |= AttribFilter::DIRECTORY,
            'E' => flags |= AttribFilter::ENCRYPTED,
            'H' => flags |= AttribFilter::HIDDEN,
            'I' => {} // Indexed (not standard)
            'N' => flags |= AttribFilter::NORMAL,
            'O' => {} // Offline
            'R' => flags |= AttribFilter::READONLY,
            'S' => flags |= AttribFilter::SYSTEM,
            'T' => flags |= AttribFilter::TEMPORARY,
            _ => return Err(format!("Unknown attribute flag: {}", c)),
        }
    }
    
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_size() {
        assert_eq!(parse_size_size("1024").unwrap(), 1024);
        assert_eq!(parse_size_size("1kb").unwrap(), 1024);
        assert_eq!(parse_size_size("1KB").unwrap(), 1024);
        assert_eq!(parse_size_size("1mb").unwrap(), 1024 * 1024);
        assert_eq!(parse_size_size("1.5mb").unwrap(), (1.5 * 1024.0 * 1024.0) as u64);
        assert_eq!(parse_size_size("1gb").unwrap(), 1024 * 1024 * 1024);
    }
    
    #[test]
    fn test_parse_attrib() {
        assert_eq!(parse_attrib_flags("H").unwrap(), AttribFilter::HIDDEN);
        assert_eq!(parse_attrib_flags("HS").unwrap(), AttribFilter::HIDDEN | AttribFilter::SYSTEM);
        assert_eq!(parse_attrib_flags("RASH").unwrap(), 
                   AttribFilter::READONLY | AttribFilter::ARCHIVE | AttribFilter::SYSTEM | AttribFilter::HIDDEN);
    }
}
