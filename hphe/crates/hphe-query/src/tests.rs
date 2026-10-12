//! Integration tests for hphe-query crate.
//!
//! These tests verify:
//! 1. Parse and compile all supported Everything syntax
//! 2. Evaluate predicates correctly against FileIndex
//! 3. Maintain parity with Everything behavior on common cases

use hphe_index::synthetic::generate_synthetic_entries;
use hphe_index::FileIndex;
use crate::*;

/// Create a test index with various file types.
fn make_test_index() -> FileIndex {
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
    
    let entries = vec![
        // Root
        make_entry(5, 5, "C:", true, 0),
        
        // Directories
        make_entry(10, 5, "Windows", true, 0),
        make_entry(11, 5, "Users", true, 0),
        make_entry(12, 10, "System32", true, 0),
        make_entry(13, 11, "Admin", true, 0),
        make_entry(14, 13, "Documents", true, 0),
        make_entry(15, 13, "Downloads", true, 0),
        
        // Files in System32
        make_entry(100, 12, "kernel32.dll", false, 1_000_000),
        make_entry(101, 12, "user32.dll", false, 800_000),
        make_entry(102, 12, "gdi32.dll", false, 500_000),
        
        // Files in Documents
        make_entry(200, 14, "report.pdf", false, 2_000_000),
        make_entry(201, 14, "notes.txt", false, 10_000),
        make_entry(202, 14, "data.xlsx", false, 50_000),
        
        // Files in Downloads
        make_entry(300, 15, "setup.exe", false, 10_000_000),
        make_entry(301, 15, "archive.zip", false, 5_000_000),
        make_entry(302, 15, "image.png", false, 1_000_000),
        
        // Other files
        make_entry(400, 5, "readme.md", false, 500),
        make_entry(401, 5, "config.json", false, 200),
    ];
    
    FileIndex::build(entries)
}

// ============================================================================
// Syntax Parsing Tests (REQUIS 1)
// ============================================================================

#[test]
fn test_parse_simple_term() {
    let query = parse("test").unwrap();
    assert!(matches!(query.expr, Expr::Term(_)));
}

#[test]
fn test_parse_quoted_term() {
    let query = parse("\"hello world\"").unwrap();
    match &query.expr {
        Expr::Term(t) => {
            assert!(t.is_quoted);
            assert_eq!(t.text, "hello world");
        }
        _ => panic!("Expected Term"),
    }
}

#[test]
fn test_parse_wildcard_asterisk() {
    let query = parse("test*.txt").unwrap();
    match &query.expr {
        Expr::Term(t) => {
            assert!(t.has_wildcards);
            assert_eq!(t.text, "test*.txt");
        }
        _ => panic!("Expected Term"),
    }
}

#[test]
fn test_parse_wildcard_question() {
    let query = parse("test?.txt").unwrap();
    match &query.expr {
        Expr::Term(t) => {
            assert!(t.has_wildcards);
            assert_eq!(t.text, "test?.txt");
        }
        _ => panic!("Expected Term"),
    }
}

#[test]
fn test_parse_property_path() {
    let query = parse("path:C:\\\\Windows").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Path(p)) => {
            assert_eq!(p.pattern, "C:\\\\Windows");
            assert!(!p.is_matchpath);
        }
        _ => panic!("Expected Path property"),
    }
}

#[test]
fn test_parse_property_matchpath() {
    let query = parse("matchpath:C:\\\\Windows\\\\System32").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Path(p)) => {
            assert_eq!(p.pattern, "C:\\\\Windows\\\\System32");
            assert!(p.is_matchpath);
        }
        _ => panic!("Expected Path property"),
    }
}

#[test]
fn test_parse_property_ext() {
    let query = parse("ext:pdf").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Ext(e)) => {
            assert_eq!(e.extensions, vec!["pdf"]);
        }
        _ => panic!("Expected Ext property"),
    }
}

#[test]
fn test_parse_property_ext_multiple() {
    let query = parse("ext:pdf;docx;txt").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Ext(e)) => {
            assert_eq!(e.extensions, vec!["pdf", "docx", "txt"]);
        }
        _ => panic!("Expected Ext property"),
    }
}

#[test]
fn test_parse_property_size_equal() {
    let query = parse("size:1mb").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Size(s)) => {
            assert_eq!(s.size_bytes, Some(1024 * 1024));
        }
        _ => panic!("Expected Size property"),
    }
}

#[test]
fn test_parse_property_size_greater() {
    let query = parse("size:>1mb").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Size(s)) => {
            assert_eq!(s.min_bytes, Some(1024 * 1024 + 1));
        }
        _ => panic!("Expected Size property"),
    }
}

#[test]
fn test_parse_property_size_less() {
    let query = parse("size:<10mb").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Size(s)) => {
            assert_eq!(s.max_bytes, Some(10 * 1024 * 1024 - 1));
        }
        _ => panic!("Expected Size property"),
    }
}

#[test]
fn test_parse_property_size_range() {
    let query = parse("size:1kb..10mb").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Size(s)) => {
            assert_eq!(s.min_bytes, Some(1024));
            assert_eq!(s.max_bytes, Some(10 * 1024 * 1024));
        }
        _ => panic!("Expected Size property"),
    }
}

#[test]
fn test_parse_property_dm_today() {
    let query = parse("dm:today").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::DateModified(d)) => {
            assert!(d.relative.is_some());
            assert!(matches!(d.relative.unwrap(), RelativeDate::Today));
        }
        _ => panic!("Expected DateModified property"),
    }
}

#[test]
fn test_parse_property_dm_yesterday() {
    let query = parse("dm:yesterday").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::DateModified(d)) => {
            assert!(matches!(d.relative.unwrap(), RelativeDate::Yesterday));
        }
        _ => panic!("Expected DateModified property"),
    }
}

#[test]
fn test_parse_property_dm_days() {
    let query = parse("dm:7d").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::DateModified(d)) => {
            assert_eq!(d.days, Some(7));
        }
        _ => panic!("Expected DateModified property"),
    }
}

#[test]
fn test_parse_property_attrib() {
    let query = parse("attrib:H").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Attrib(a)) => {
            assert!((a.flags & AttribFilter::HIDDEN) != 0);
        }
        _ => panic!("Expected Attrib property"),
    }
}

#[test]
fn test_parse_property_attrib_multiple() {
    let query = parse("attrib:HS").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Attrib(a)) => {
            assert!((a.flags & AttribFilter::HIDDEN) != 0);
            assert!((a.flags & AttribFilter::SYSTEM) != 0);
        }
        _ => panic!("Expected Attrib property"),
    }
}

#[test]
fn test_parse_property_regex() {
    let query = parse("regex:^test").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Regex(r)) => {
            assert_eq!(r.pattern, "^test");
        }
        _ => panic!("Expected Regex property"),
    }
}

#[test]
fn test_parse_property_case() {
    let query = parse("case:yes").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::CaseSensitive(c)) => {
            assert!(c);
        }
        _ => panic!("Expected CaseSensitive property"),
    }
}

#[test]
fn test_parse_property_whole() {
    let query = parse("whole:yes").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::WholeWords(w)) => {
            assert!(w);
        }
        _ => panic!("Expected WholeWords property"),
    }
}

#[test]
fn test_parse_property_file() {
    let query = parse("file:").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::FileType(ft)) => {
            assert!(matches!(ft, FileTypeFilter::File));
        }
        _ => panic!("Expected FileType property"),
    }
}

#[test]
fn test_parse_property_folder() {
    let query = parse("folder:").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::FileType(ft)) => {
            assert!(matches!(ft, FileTypeFilter::Folder));
        }
        _ => panic!("Expected FileType property"),
    }
}

#[test]
fn test_parse_property_parents() {
    let query = parse("parents:2").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Parents(n)) => {
            assert_eq!(*n, 2);
        }
        _ => panic!("Expected Parents property"),
    }
}

#[test]
fn test_parse_property_dupe() {
    let query = parse("dupe:").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::Dupe) => {}
        _ => panic!("Expected Dupe property"),
    }
}

#[test]
fn test_parse_property_startwith() {
    let query = parse("startwith:test").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::StartWith(s)) => {
            assert_eq!(*s, "test");
        }
        _ => panic!("Expected StartWith property"),
    }
}

#[test]
fn test_parse_property_endwith() {
    let query = parse("endwith:.txt").unwrap();
    match &query.expr {
        Expr::Property(PropertyFilter::EndWith(s)) => {
            assert_eq!(*s, ".txt");
        }
        _ => panic!("Expected EndWith property"),
    }
}

// ============================================================================
// Logical Operator Tests (REQUIS 1)
// ============================================================================

#[test]
fn test_parse_not() {
    let query = parse("!test").unwrap();
    match &query.expr {
        Expr::Not(_) => {}
        _ => panic!("Expected Not expression"),
    }
}

#[test]
fn test_parse_not_with_property() {
    let query = parse("!ext:pdf").unwrap();
    match &query.expr {
        Expr::Not(not_expr) => {
            match **not_expr {
                Expr::Property(PropertyFilter::Ext(_)) => {}
                _ => panic!("Expected Property in Not"),
            }
        }
        _ => panic!("Expected Not expression"),
    }
}

#[test]
fn test_parse_and_implicit() {
    let query = parse("test ext:pdf").unwrap();
    match &query.expr {
        Expr::And(exprs) => {
            assert_eq!(exprs.len(), 2);
        }
        _ => panic!("Expected And expression"),
    }
}

#[test]
fn test_parse_and_explicit() {
    let query = parse("test AND ext:pdf").unwrap();
    match &query.expr {
        Expr::And(exprs) => {
            assert_eq!(exprs.len(), 2);
        }
        _ => panic!("Expected And expression"),
    }
}

#[test]
fn test_parse_or_pipe() {
    let query = parse("test | ext:pdf").unwrap();
    match &query.expr {
        Expr::Or(exprs) => {
            assert_eq!(exprs.len(), 2);
        }
        _ => panic!("Expected Or expression"),
    }
}

#[test]
fn test_parse_or_explicit() {
    let query = parse("test OR ext:pdf").unwrap();
    match &query.expr {
        Expr::Or(exprs) => {
            assert_eq!(exprs.len(), 2);
        }
        _ => panic!("Expected Or expression"),
    }
}

#[test]
fn test_parse_group() {
    let query = parse("(test OR hello)").unwrap();
    match &query.expr {
        Expr::Group(_) => {}
        _ => panic!("Expected Group expression"),
    }
}

#[test]
fn test_parse_nested_group() {
    let query = parse("(test OR (hello AND world))").unwrap();
    match &query.expr {
        Expr::Group(_) => {}
        _ => panic!("Expected Group expression"),
    }
}

#[test]
fn test_parse_complex_query() {
    // rapport ext:pdf;docx size:>1mb dm:today
    let query = parse("rapport ext:pdf;docx size:>1mb dm:today").unwrap();
    match &query.expr {
        Expr::And(exprs) => {
            assert_eq!(exprs.len(), 4);
        }
        _ => panic!("Expected And expression with 4 children"),
    }
}

// ============================================================================
// Compilation Tests (REQUIS 2)
// ============================================================================

#[test]
fn test_compile_term() {
    let query = parse("test").unwrap();
    let compiled = query.compile().unwrap();
    assert!(!compiled.explain().is_empty());
}

#[test]
fn test_compile_property() {
    let query = parse("ext:pdf").unwrap();
    let compiled = query.compile().unwrap();
    assert!(compiled.explain().contains("ext:"));
}

#[test]
fn test_compile_not() {
    let query = parse("!test").unwrap();
    let compiled = query.compile().unwrap();
    assert!(compiled.explain().contains("!"));
}

#[test]
fn test_compile_and() {
    let query = parse("test ext:pdf").unwrap();
    let compiled = query.compile().unwrap();
    assert!(compiled.explain().contains("AND"));
}

#[test]
fn test_compile_or() {
    let query = parse("test | ext:pdf").unwrap();
    let compiled = query.compile().unwrap();
    assert!(compiled.explain().contains("OR"));
}

// ============================================================================
// Evaluation Tests (REQUIS 2)
// ============================================================================

#[test]
fn test_eval_substring_match() {
    let index = make_test_index();
    let query = parse("kernel").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match kernel32.dll
    assert!(results.iter().any(|&r| index.name(r) == "kernel32.dll"));
}

#[test]
fn test_eval_substring_case_insensitive() {
    let index = make_test_index();
    let query = parse("KERNEL").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should still match kernel32.dll (case-insensitive)
    assert!(results.iter().any(|&r| index.name(r) == "kernel32.dll"));
}

#[test]
fn test_eval_extension_match() {
    let index = make_test_index();
    let query = parse("ext:pdf").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match report.pdf
    assert_eq!(results.len(), 1);
    assert_eq!(index.name(results[0]), "report.pdf");
}

#[test]
fn test_eval_extension_multiple() {
    let index = make_test_index();
    let query = parse("ext:pdf;docx;txt").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match report.pdf, notes.txt, readme.md, config.json
    // Actually only pdf, docx, txt - so report.pdf, notes.txt
    let names: Vec<&str> = results.iter().map(|&r| index.name(r)).collect();
    assert!(names.contains(&"report.pdf"));
    assert!(names.contains(&"notes.txt"));
    assert!(!names.contains(&"readme.md"));
}

#[test]
fn test_eval_size_greater() {
    let index = make_test_index();
    let query = parse("size:>1mb").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match files > 1MB: setup.exe, archive.zip, image.png, report.pdf
    assert!(results.len() >= 4);
}

#[test]
fn test_eval_size_less() {
    let index = make_test_index();
    let query = parse("size:<10000").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match small files: notes.txt, readme.md, config.json
    assert!(results.len() >= 3);
}

#[test]
fn test_eval_and() {
    let index = make_test_index();
    let query = parse("ext:dll size:>500kb").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match DLLs > 500KB: kernel32.dll, user32.dll, gdi32.dll
    assert_eq!(results.len(), 3);
}

#[test]
fn test_eval_or() {
    let index = make_test_index();
    let query = parse("ext:pdf | ext:docx").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match PDF and DOCX files
    assert!(results.len() >= 1); // At least report.pdf
}

#[test]
fn test_eval_not() {
    let index = make_test_index();
    let query = parse("!ext:dll").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match all non-DLL files
    let dll_count = (0..index.len())
        .filter(|&r| index.name(r).ends_with(".dll"))
        .count();
    assert_eq!(results.len() + dll_count, index.len());
}

#[test]
fn test_eval_folder_property() {
    let index = make_test_index();
    let query = parse("folder:").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // All results should be directories
    for &row in &results {
        assert!(index.is_dir(row));
    }
}

#[test]
fn test_eval_file_property() {
    let index = make_test_index();
    let query = parse("file:").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // All results should be files
    for &row in &results {
        assert!(!index.is_dir(row));
    }
}

#[test]
fn test_eval_startwith() {
    let index = make_test_index();
    let query = parse("startwith:kernel").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match kernel32.dll
    assert_eq!(results.len(), 1);
    assert_eq!(index.name(results[0]), "kernel32.dll");
}

#[test]
fn test_eval_path() {
    let index = make_test_index();
    let query = parse("path:C:\\\\Windows").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match entries under C:\Windows
    for &row in &results {
        let path = index.resolve_path(row);
        assert!(path.starts_with("C:\\Windows"));
    }
}

// ============================================================================
// Parity Tests (REQUIS 6)
// ============================================================================

#[test]
fn test_parity_dots_folder() {
    // Everything query: "dots folder:"
    let index = make_test_index();
    let query = parse("dots folder:").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match only "Documents" directory
    assert_eq!(results.len(), 1);
    assert_eq!(index.name(results[0]), "Documents");
}

#[test]
fn test_parity_simple_term() {
    // Everything query: "kernel"
    let index = make_test_index();
    let query = parse("kernel").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match kernel32.dll
    assert_eq!(results.len(), 1);
}

#[test]
fn test_parity_wildcard() {
    // Everything query: "*.dll"
    let index = make_test_index();
    let query = parse("*.dll").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Should match all DLL files
    assert_eq!(results.len(), 3);
}

#[test]
fn test_parity_ext() {
    // Everything query: "ext:pdf"
    let index = make_test_index();
    let query = parse("ext:pdf").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Manual check
    let manual: Vec<usize> = (0..index.len())
        .filter(|&r| index.name_lower(r).ends_with(".pdf"))
        .collect();
    
    assert_eq!(results, manual);
}

#[test]
fn test_parity_size_and_ext() {
    // Everything query: "ext:dll size:>500kb"
    let index = make_test_index();
    let query = parse("ext:dll size:>500kb").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect(&index);
    
    // Manual check
    let manual: Vec<usize> = (0..index.len())
        .filter(|&r| {
            let name = index.name_lower(r);
            let size = index.size(r);
            name.ends_with(".dll") && size > 500 * 1024
        })
        .collect();
    
    assert_eq!(results, manual);
}

// ============================================================================
// Edge Case Tests
// ============================================================================

#[test]
fn test_empty_query_error() {
    let result = parse("");
    assert!(result.is_err());
}

#[test]
fn test_whitespace_query_error() {
    let result = parse("   ");
    assert!(result.is_err());
}

#[test]
fn test_quoted_empty_string() {
    let query = parse("\"\"").unwrap();
    match &query.expr {
        Expr::Term(t) => {
            assert!(t.is_quoted);
            assert_eq!(t.text, "");
        }
        _ => panic!("Expected Term"),
    }
}

#[test]
fn test_escaped_quotes() {
    let query = parse("\"hello \\\"world\"").unwrap();
    match &query.expr {
        Expr::Term(t) => {
            assert_eq!(t.text, "hello \"world");
        }
        _ => panic!("Expected Term"),
    }
}

#[test]
fn test_nested_groups() {
    let query = parse("((test OR hello) AND (world | foo))").unwrap();
    match &query.expr {
        Expr::Group(_) => {}
        _ => panic!("Expected Group"),
    }
}

#[test]
fn test_complex_nested_query() {
    // Test a complex query with multiple levels of nesting
    let query = parse("(test AND ext:pdf) OR (size:>1mb AND dm:today)").unwrap();
    match &query.expr {
        Expr::Or(exprs) => {
            assert_eq!(exprs.len(), 2);
            match &exprs[0] {
                Expr::Group(_) => {}
                _ => panic!("Expected Group"),
            }
            match &exprs[1] {
                Expr::Group(_) => {}
                _ => panic!("Expected Group"),
            }
        }
        _ => panic!("Expected Or"),
    }
}

#[test]
fn test_count_operation() {
    let index = make_test_index();
    let query = parse("ext:dll").unwrap();
    let compiled = query.compile().unwrap();
    let count = compiled.count(&index);
    
    // Should count all DLL files
    assert_eq!(count, 3);
}

#[test]
fn test_first_operation() {
    let index = make_test_index();
    let query = parse("ext:dll").unwrap();
    let compiled = query.compile().unwrap();
    let first = compiled.first(&index);
    
    assert!(first.is_some());
    assert_eq!(index.name(first.unwrap()), "gdi32.dll"); // Sorted order
}

#[test]
fn test_any_operation() {
    let index = make_test_index();
    let query = parse("nonexistent").unwrap();
    let compiled = query.compile().unwrap();
    
    assert!(!compiled.any(&index));
}

#[test]
fn test_query_with_limit() {
    let index = make_test_index();
    let query = parse("ext:dll").unwrap();
    let compiled = query.compile().unwrap();
    let results = compiled.collect_with_limit(&index, 2);
    
    assert!(results.len() <= 2);
}
