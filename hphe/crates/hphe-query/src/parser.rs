//! Parser for Everything-like query syntax.
//!
//! This module implements a parser for the Everything search syntax.
//! The parser handles:
//! - Terms (plain text, wildcards, quoted strings)
//! - Property filters (path:, ext:, size:, dm:, dc:, da:, etc.)
//! - Logical operators (AND, OR, NOT)
//! - Parentheses for grouping
//!
//! Uses a simple recursive descent approach.

use crate::ast::*;
use crate::error::ParseError;

/// Parse a query string into a Query AST.
pub fn parse_query(input: &str) -> Result<Query, ParseError> {
    if input.trim().is_empty() {
        return Err(ParseError::EmptyQuery);
    }
    let parser = Parser::new(input);
    parser.parse()
}

/// Parser state.
pub struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    pub fn new(input: &'a str) -> Self {
        Self { input, pos: 0 }
    }
    
    pub fn parse(mut self) -> Result<Query, ParseError> {
        let start = self.pos;
        let expr = self.parse_expr()?;
        self.skip_whitespace();
        
        if self.pos < self.input.len() {
            return Err(ParseError::UnexpectedToken(
                self.slice_from(self.pos).to_string()
            ));
        }
        
        Ok(Query::new(expr, self.input[start..].to_string()))
    }
    
    fn parse_expr(&mut self) -> Result<Expr, ParseError> {
        self.parse_or()
    }
    
    /// Peek the next word (alphabetic run) without consuming it.
    fn peek_word(&self) -> Option<String> {
        let mut p = self.pos;
        while let Some(c) = self.input[p..].chars().next() {
            if c.is_whitespace() {
                p += c.len_utf8();
            } else {
                break;
            }
        }
        let start = p;
        while let Some(c) = self.input[p..].chars().next() {
            if c.is_alphabetic() {
                p += c.len_utf8();
            } else {
                break;
            }
        }
        if p == start {
            return None;
        }
        Some(self.input[start..p].to_lowercase())
    }

    /// Consume the literal keyword `kw` (case-insensitive) if it is the next
    /// word. Returns true when consumed.
    fn eat_keyword(&mut self, kw: &str) -> bool {
        let saved = self.pos;
        if self.peek_word().as_deref() == Some(kw) {
            let mut p = self.pos;
            while let Some(c) = self.input[p..].chars().next() {
                if c.is_whitespace() {
                    p += c.len_utf8();
                } else {
                    break;
                }
            }
            while let Some(c) = self.input[p..].chars().next() {
                if c.is_alphabetic() {
                    p += c.len_utf8();
                } else {
                    break;
                }
            }
            self.pos = p;
            true
        } else {
            self.pos = saved;
            false
        }
    }

    fn parse_or(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_and()?;

        loop {
            self.skip_whitespace();
            // Explicit OR: `|` operator or the OR keyword
            let is_or = if self.peek_char() == Some('|') {
                self.advance();
                true
            } else {
                self.eat_keyword("or")
            };
            if is_or {
                let right = self.parse_and()?;
                left = Expr::Or(vec![left, right]);
            } else {
                break;
            }
        }

        Ok(Self::flatten_or(left))
    }

    fn parse_and(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_not()?;

        loop {
            self.skip_whitespace();
            if self.peek_char() == Some(')') || self.is_eof() {
                break;
            }
            // Explicit OR breaks the AND chain
            if self.peek_char() == Some('|') {
                break;
            }
            if self.peek_word().as_deref() == Some("or") {
                break;
            }
            // Explicit AND keyword
            if self.eat_keyword("and") {
                let right = self.parse_not()?;
                left = Expr::And(vec![left, right]);
                continue;
            }
            // Try to parse next expression (implicit AND)
            if let Ok(right) = self.parse_not() {
                left = Expr::And(vec![left, right]);
            } else {
                break;
            }
        }

        Ok(Self::flatten_and(left))
    }
    
    fn parse_not(&mut self) -> Result<Expr, ParseError> {
        self.skip_whitespace();
        
        if self.peek_char() == Some('!') {
            self.advance();
            let expr = self.parse_not()?;
            return Ok(Expr::Not(Box::new(expr)));
        }
        
        if self.peek_char() == Some('(') {
            self.advance();
            let expr = self.parse_expr()?;
            self.skip_whitespace();
            if self.peek_char() != Some(')') {
                return Err(ParseError::UnclosedParen);
            }
            self.advance();
            return Ok(Expr::Group(Box::new(expr)));
        }
        
        // Try property first
        if let Ok(prop) = self.try_parse_property() {
            return Ok(Expr::Property(prop));
        }
        
        // Otherwise parse term
        let term = self.parse_term()?;
        Ok(Expr::Term(term))
    }
    
    fn try_parse_property(&mut self) -> Result<PropertyFilter, ParseError> {
        let saved_pos = self.pos;
        
        let prop_name = match self.parse_identifier() {
            Ok(name) => name,
            Err(_) => return Err(ParseError::UnexpectedEof),
        };
        
        self.skip_whitespace();
        if self.peek_char() != Some(':') {
            self.pos = saved_pos;
            return Err(ParseError::UnexpectedToken(prop_name));
        }
        self.advance();
        
        let value = self.parse_property_value()?;
        self.create_property_filter(&prop_name, &value)
    }
    
    fn parse_identifier(&mut self) -> Result<String, ParseError> {
        let start = self.pos;
        while let Some(c) = self.peek_char() {
            if c.is_alphabetic() || c == '_' {
                self.advance();
            } else {
                break;
            }
        }
        
        if self.pos == start {
            return Err(ParseError::UnexpectedEof);
        }
        
        Ok(self.slice_from(start).to_lowercase())
    }
    
    fn parse_property_value(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        
        if self.peek_char() == Some('"') {
            self.advance();
            let value = self.parse_string()?;
            self.skip_whitespace();
            if self.peek_char() != Some('"') {
                return Err(ParseError::UnclosedQuote);
            }
            self.advance();
            return Ok(value);
        }
        
        let start = self.pos;
        while let Some(c) = self.peek_char() {
            if c.is_whitespace() || c == ')' || c == '|' || c == ';' {
                break;
            }
            self.advance();
        }

        // Multi-value separator (ext:pdf;docx;txt): keep consuming
        // `value;value;...` so the property filter receives the full list.
        // The separator itself is consumed — everything after it belongs to
        // the same property value.
        let mut end = self.pos;
        while self.peek_char() == Some(';') {
            self.advance();
            while let Some(c) = self.peek_char() {
                if c.is_whitespace() || c == ')' || c == '|' || c == ';' {
                    break;
                }
                self.advance();
            }
            end = self.pos;
        }
        self.pos = end;

        // Empty value is OK for some properties (file:, folder:, dupe:)
        if self.pos == start {
            return Ok(String::new());
        }

        Ok(self.slice_from(start).to_string())
    }
    
    fn create_property_filter(&self, name: &str, value: &str) -> Result<PropertyFilter, ParseError> {
        match name {
            "path" | "matchpath" => {
                Ok(PropertyFilter::Path(PathFilter {
                    pattern: value.to_string(),
                    is_matchpath: name == "matchpath",
                }))
            }
            "ext" => {
                let exts: Vec<String> = value
                    .split(';')
                    .map(|s| s.trim().to_lowercase())
                    .collect();
                Ok(PropertyFilter::Ext(ExtFilter { extensions: exts }))
            }
            "size" => self.parse_size_filter(value),
            "dm" => self.parse_date_filter(value, |d| PropertyFilter::DateModified(d)),
            "dc" => self.parse_date_filter(value, |d| PropertyFilter::DateCreated(d)),
            "da" => self.parse_date_filter(value, |d| PropertyFilter::DateAccessed(d)),
            "attrib" => self.parse_attrib_filter(value),
            "regex" => {
                Ok(PropertyFilter::Regex(RegexFilter {
                    pattern: value.to_string(),
                    case_sensitive: false,
                }))
            }
            "case" => {
                let case_sensitive = match value.to_lowercase().as_str() {
                    "yes" | "true" | "1" => true,
                    "no" | "false" | "0" => false,
                    _ => return Err(ParseError::InvalidProperty(format!("case: {}", value))),
                };
                Ok(PropertyFilter::CaseSensitive(case_sensitive))
            }
            "whole" | "ww" => {
                let whole_words = match value.to_lowercase().as_str() {
                    "yes" | "true" | "1" => true,
                    "no" | "false" | "0" => false,
                    _ => return Err(ParseError::InvalidProperty(format!("whole: {}", value))),
                };
                Ok(PropertyFilter::WholeWords(whole_words))
            }
            "file" => Ok(PropertyFilter::FileType(FileTypeFilter::File)),
            "folder" => Ok(PropertyFilter::FileType(FileTypeFilter::Folder)),
            "parents" => {
                value.parse::<usize>()
                    .map(PropertyFilter::Parents)
                    .map_err(|_| ParseError::InvalidProperty(format!("parents: {}", value)))
            }
            "dupe" => Ok(PropertyFilter::Dupe),
            "startwith" => Ok(PropertyFilter::StartWith(value.to_string())),
            "endwith" => Ok(PropertyFilter::EndWith(value.to_string())),
            _ => Err(ParseError::InvalidProperty(name.to_string())),
        }
    }
    
    fn parse_size_filter(&self, value: &str) -> Result<PropertyFilter, ParseError> {
        let value = value.trim();
        
        if value.contains("..") {
            let parts: Vec<&str> = value.split("..").collect();
            if parts.len() != 2 {
                return Err(ParseError::InvalidSize(value.to_string()));
            }
            let min_bytes = parse_size_size(parts[0]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            let max_bytes = parse_size_size(parts[1]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_range(min_bytes, max_bytes)));
        }
        
        if value.starts_with(">=") {
            let size = parse_size_size(&value[2..]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_min(size)));
        } else if value.starts_with(">") {
            let size = parse_size_size(&value[1..]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_min(size)));
        } else if value.starts_with("<=") {
            let size = parse_size_size(&value[2..]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_max(size)));
        } else if value.starts_with("<") {
            let size = parse_size_size(&value[1..]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_max(size)));
        } else if value.starts_with("=") {
            let size = parse_size_size(&value[1..]).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_equal(size)));
        } else {
            let size = parse_size_size(value).map_err(|_| ParseError::InvalidSize(value.to_string()))?;
            return Ok(PropertyFilter::Size(SizeFilter::new_equal(size)));
        }
    }
    
    fn parse_date_filter<F>(&self, value: &str, ctor: F) -> Result<PropertyFilter, ParseError>
    where F: Fn(DateFilter) -> PropertyFilter
    {
        let value = value.trim().to_lowercase();
        
        let relative = match value.as_str() {
            "today" => Some(RelativeDate::Today),
            "yesterday" => Some(RelativeDate::Yesterday),
            "week" => Some(RelativeDate::ThisWeek),
            "lastweek" => Some(RelativeDate::LastWeek),
            "month" => Some(RelativeDate::ThisMonth),
            "lastmonth" => Some(RelativeDate::LastMonth),
            "year" => Some(RelativeDate::ThisYear),
            "lastyear" => Some(RelativeDate::LastYear),
            _ => None,
        };
        
        if let Some(rel) = relative {
            return Ok(ctor(DateFilter {
                timestamp: None,
                days: None,
                date_str: None,
                min_timestamp: None,
                max_timestamp: None,
                relative: Some(rel),
            }));
        }
        
        if value.ends_with('d') {
            let days: i64 = value[..value.len()-1].parse()
                .map_err(|_| ParseError::InvalidDate(value))?;
            return Ok(ctor(DateFilter {
                timestamp: None,
                days: Some(days),
                date_str: None,
                min_timestamp: None,
                max_timestamp: None,
                relative: None,
            }));
        }
        
        if value.contains("..") {
            let parts: Vec<&str> = value.split("..").collect();
            if parts.len() != 2 {
                return Err(ParseError::InvalidDate(value.clone()));
            }
            let min_ts = parse_date_string(parts[0]).map_err(|_| ParseError::InvalidDate(value.clone()))?;
            let max_ts = parse_date_string(parts[1]).map_err(|_| ParseError::InvalidDate(value.clone()))?;
            return Ok(ctor(DateFilter {
                timestamp: None,
                days: None,
                date_str: None,
                min_timestamp: Some(min_ts),
                max_timestamp: Some(max_ts),
                relative: None,
            }));
        }
        
        match parse_date_string(&value) {
            Ok(ts) => Ok(ctor(DateFilter {
                timestamp: Some(ts),
                days: None,
                date_str: Some(value),
                min_timestamp: None,
                max_timestamp: None,
                relative: None,
            })),
            Err(_) => Err(ParseError::InvalidDate(value)),
        }
    }
    
    fn parse_attrib_filter(&self, value: &str) -> Result<PropertyFilter, ParseError> {
        let flags = parse_attrib_flags(value).map_err(|_| ParseError::InvalidProperty(format!("attrib: {}", value)))?;
        Ok(PropertyFilter::Attrib(AttribFilter {
            flags,
            flag_names: value.to_string(),
        }))
    }
    
    fn parse_term(&mut self) -> Result<Term, ParseError> {
        self.skip_whitespace();
        
        if self.peek_char() == Some('"') {
            self.advance();
            // parse_string consumes chars up to (and including) the closing
            // quote: it breaks on '"' *after* advancing past it.
            let text = self.parse_string()?;
            return Ok(Term::quoted(text));
        }
        
        let start = self.pos;
        while let Some(c) = self.peek_char() {
            if c.is_whitespace() || c == ')' || c == '|' || c == ';' {
                break;
            }
            self.advance();
        }
        
        if self.pos == start {
            return Err(ParseError::UnexpectedEof);
        }
        
        let text = self.slice_from(start).to_string();
        Ok(Term::new(text))
    }
    
    fn parse_string(&mut self) -> Result<String, ParseError> {
        let mut result = String::new();
        
        while let Some(c) = self.peek_char() {
            self.advance();
            match c {
                '\\' => {
                    // Escape sequence
                    let next = self.peek_char().ok_or(ParseError::UnexpectedEof)?;
                    self.advance();
                    match next {
                        'n' => result.push('\n'),
                        'r' => result.push('\r'),
                        't' => result.push('\t'),
                        '\\' => result.push('\\'),
                        '"' => result.push('"'),
                        _ => return Err(ParseError::InvalidEscape(format!("\\{}", next))),
                    }
                }
                '"' => break,
                _ => result.push(c),
            }
        }
        
        Ok(result)
    }
    
    fn flatten_and(expr: Expr) -> Expr {
        match expr {
            Expr::And(mut exprs) => {
                let mut flattened = Vec::new();
                for e in exprs.drain(..) {
                    match Self::flatten_and(e) {
                        Expr::And(mut nested) => flattened.append(&mut nested),
                        other => flattened.push(other),
                    }
                }
                if flattened.len() == 1 {
                    flattened.into_iter().next().unwrap()
                } else {
                    Expr::And(flattened)
                }
            }
            Expr::Not(boxed) => {
                let inner = Self::flatten_and(*boxed);
                Expr::Not(Box::new(inner))
            }
            Expr::Group(boxed) => {
                let inner = Self::flatten_and(*boxed);
                Expr::Group(Box::new(inner))
            }
            Expr::Or(exprs) => {
                let flattened: Vec<Expr> = exprs
                    .into_iter()
                    .map(Self::flatten_and)
                    .collect();
                if flattened.len() == 1 {
                    flattened.into_iter().next().unwrap()
                } else {
                    Expr::Or(flattened)
                }
            }
            other => other,
        }
    }
    
    fn flatten_or(expr: Expr) -> Expr {
        match expr {
            Expr::Or(mut exprs) => {
                let mut flattened = Vec::new();
                for e in exprs.drain(..) {
                    match Self::flatten_or(e) {
                        Expr::Or(mut nested) => flattened.append(&mut nested),
                        other => flattened.push(other),
                    }
                }
                if flattened.len() == 1 {
                    flattened.into_iter().next().unwrap()
                } else {
                    Expr::Or(flattened)
                }
            }
            Expr::Not(boxed) => {
                let inner = Self::flatten_or(*boxed);
                Expr::Not(Box::new(inner))
            }
            Expr::Group(boxed) => {
                let inner = Self::flatten_or(*boxed);
                Expr::Group(Box::new(inner))
            }
            Expr::And(exprs) => {
                let flattened: Vec<Expr> = exprs
                    .into_iter()
                    .map(Self::flatten_or)
                    .collect();
                if flattened.len() == 1 {
                    flattened.into_iter().next().unwrap()
                } else {
                    Expr::And(flattened)
                }
            }
            other => other,
        }
    }
    
    #[inline]
    fn peek_char(&self) -> Option<char> {
        self.input[self.pos..].chars().next()
    }
    
    #[inline]
    fn advance(&mut self) {
        if let Some(c) = self.peek_char() {
            self.pos += c.len_utf8();
        }
    }
    
    #[inline]
    fn skip_whitespace(&mut self) {
        while let Some(c) = self.peek_char() {
            if !c.is_whitespace() {
                break;
            }
            self.advance();
        }
    }
    
    #[inline]
    fn is_eof(&self) -> bool {
        self.pos >= self.input.len()
    }
    
    #[inline]
    fn slice_from(&self, start: usize) -> &'a str {
        &self.input[start..self.pos]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_simple_term() {
        let query = parse_query("test").unwrap();
        match &query.expr {
            Expr::Term(t) => {
                assert_eq!(t.text, "test");
                assert!(!t.has_wildcards);
                assert!(!t.is_quoted);
            }
            _ => panic!("Expected Term, got {:?}", query.expr),
        }
    }
    
    #[test]
    fn test_parse_quoted_term() {
        let query = parse_query("\"hello world\"").unwrap();
        match &query.expr {
            Expr::Term(t) => {
                assert!(t.is_quoted);
                assert_eq!(t.text, "hello world");
            }
            _ => panic!("Expected Term"),
        }
    }
    
    #[test]
    fn test_parse_wildcard() {
        let query = parse_query("test*.txt").unwrap();
        match &query.expr {
            Expr::Term(t) => {
                assert!(t.has_wildcards);
                assert_eq!(t.text, "test*.txt");
            }
            _ => panic!("Expected Term"),
        }
    }
    
    #[test]
    fn test_parse_property_ext() {
        let query = parse_query("ext:pdf").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Ext(e)) => {
                assert_eq!(e.extensions, vec!["pdf"]);
            }
            _ => panic!("Expected Ext property"),
        }
    }
    
    #[test]
    fn test_parse_property_ext_multiple() {
        let query = parse_query("ext:pdf;docx;txt").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Ext(e)) => {
                assert_eq!(e.extensions, vec!["pdf", "docx", "txt"]);
            }
            _ => panic!("Expected Ext property"),
        }
    }
    
    #[test]
    fn test_parse_property_size() {
        let query = parse_query("size:>1mb").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Size(s)) => {
                assert!(s.min_bytes.is_some());
            }
            _ => panic!("Expected Size property"),
        }
    }
    
    #[test]
    fn test_parse_property_size_range() {
        let query = parse_query("size:1kb..10mb").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Size(s)) => {
                assert_eq!(s.min_bytes, Some(1024));
                assert_eq!(s.max_bytes, Some(10 * 1024 * 1024));
            }
            _ => panic!("Expected Size property"),
        }
    }
    
    #[test]
    fn test_parse_property_dm() {
        let query = parse_query("dm:today").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::DateModified(d)) => {
                assert!(d.relative.is_some());
            }
            _ => panic!("Expected DateModified property"),
        }
    }
    
    #[test]
    fn test_parse_and_implicit() {
        let query = parse_query("test ext:pdf").unwrap();
        match &query.expr {
            Expr::And(exprs) => {
                assert_eq!(exprs.len(), 2);
            }
            _ => panic!("Expected And expression, got {:?}", query.expr),
        }
    }
    
    #[test]
    fn test_parse_and_explicit() {
        let query = parse_query("test AND ext:pdf").unwrap();
        match &query.expr {
            Expr::And(exprs) => {
                assert_eq!(exprs.len(), 2);
            }
            _ => panic!("Expected And expression"),
        }
    }
    
    #[test]
    fn test_parse_or() {
        let query = parse_query("test | ext:pdf").unwrap();
        match &query.expr {
            Expr::Or(exprs) => {
                assert_eq!(exprs.len(), 2);
            }
            _ => panic!("Expected Or expression"),
        }
    }
    
    #[test]
    fn test_parse_not() {
        let query = parse_query("!test").unwrap();
        match &query.expr {
            Expr::Not(not_expr) => {
                match **not_expr {
                    Expr::Term(_) => {}
                    _ => panic!("Expected Term in Not"),
                }
            }
            _ => panic!("Expected Not expression"),
        }
    }
    
    #[test]
    fn test_parse_group() {
        let query = parse_query("(test OR hello)").unwrap();
        match &query.expr {
            Expr::Group(group) => {
                match **group {
                    Expr::Or(_) => {}
                    _ => panic!("Expected Or in Group"),
                }
            }
            _ => panic!("Expected Group expression"),
        }
    }
    
    #[test]
    fn test_parse_complex_query() {
        let query = parse_query("rapport ext:pdf;docx size:>1mb dm:today").unwrap();
        match &query.expr {
            Expr::And(exprs) => {
                assert_eq!(exprs.len(), 4, "Expected 4 expressions, got {}", exprs.len());
            }
            _ => panic!("Expected And expression"),
        }
    }
    
    #[test]
    fn test_parse_path_property() {
        let query = parse_query("path:C:\\\\Windows").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Path(p)) => {
                assert_eq!(p.pattern, "C:\\\\Windows");
            }
            _ => panic!("Expected Path property"),
        }
    }
    
    #[test]
    fn test_parse_attrib_property() {
        let query = parse_query("attrib:H").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::Attrib(a)) => {
                assert!((a.flags & AttribFilter::HIDDEN) != 0);
            }
            _ => panic!("Expected Attrib property"),
        }
    }
    
    #[test]
    fn test_parse_folder_property() {
        let query = parse_query("folder:").unwrap();
        match &query.expr {
            Expr::Property(PropertyFilter::FileType(ft)) => {
                assert!(matches!(ft, FileTypeFilter::Folder));
            }
            _ => panic!("Expected Folder property"),
        }
    }
    
    #[test]
    fn test_parse_nested_and_or() {
        let query = parse_query("a b | c d").unwrap();
        // Should parse as: OR(AND(a, b), AND(c, d))
        match &query.expr {
            Expr::Or(exprs) => {
                assert_eq!(exprs.len(), 2);
            }
            _ => panic!("Expected Or"),
        }
    }
}
