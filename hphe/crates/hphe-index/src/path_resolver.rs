//! Path Resolution Module
//!
//! `FileIndex` already resolves paths internally via `resolve_path(row)` with
//! a directory-segment cache (`dir_cache`). This module provides a thin
//! batch/typed facade used by the CLI and benchmarks.

use crate::FileIndex;
use std::sync::Arc;

/// Facade over `FileIndex::resolve_path` with batch helpers.
pub struct PathResolver {
    index: Arc<FileIndex>,
}

impl PathResolver {
    pub fn new(index: Arc<FileIndex>) -> Self {
        Self { index }
    }

    /// Resolve full path for a row ("" when out of bounds).
    pub fn resolve(&self, row: usize) -> String {
        self.index.resolve_path(row)
    }

    /// Batch resolve.
    pub fn resolve_batch(&self, rows: &[usize]) -> Vec<String> {
        rows.iter().map(|&r| self.index.resolve_path(r)).collect()
    }

    /// Number of cached directory paths in the underlying index.
    pub fn cache_size(&self) -> usize {
        self.index.path_cache_len()
    }

    /// Clear the directory path cache.
    pub fn clear_cache(&self) {
        self.index.clear_path_cache();
    }

    /// Access the underlying index.
    pub fn index(&self) -> &Arc<FileIndex> {
        &self.index
    }
}

/// Statistics about the resolver (cache usage).
#[derive(Debug, Clone)]
pub struct PathResolverStats {
    pub cached_dir_paths: usize,
}

impl PathResolverStats {
    pub fn of(resolver: &PathResolver) -> Self {
        Self {
            cached_dir_paths: resolver.cache_size(),
        }
    }
}

/// Standalone bounded segment cache.
pub struct SegmentCache {
    segments: hashbrown::HashMap<u64, String>,
    max_size: usize,
}

impl SegmentCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            segments: hashbrown::HashMap::new(),
            max_size,
        }
    }

    pub fn get(&self, frn: u64) -> Option<&str> {
        self.segments.get(&frn).map(|s| s.as_str())
    }

    pub fn insert(&mut self, frn: u64, path: String) {
        if self.segments.len() >= self.max_size {
            if let Some(&first_key) = self.segments.keys().next() {
                self.segments.remove(&first_key);
            }
        }
        self.segments.insert(frn, path);
    }

    pub fn clear(&mut self) {
        self.segments.clear();
    }

    pub fn len(&self) -> usize {
        self.segments.len()
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hphe_mft::record::MftEntry;

    fn mk(frn: u64, parent: u64, name: &str, is_dir: bool) -> MftEntry {
        MftEntry {
            frn,
            record_number: frn,
            sequence_number: 1,
            parent_frn: parent,
            parent_record_number: parent,
            name: name.to_string(),
            size: 0,
            allocated_size: 0,
            created: 0,
            modified: 0,
            accessed: 0,
            mft_changed: 0,
            attributes: if is_dir { 0x10 } else { 0x20 },
            is_dir,
            is_in_use: true,
            hard_links: 1,
            base_record_frn: 0,
        }
    }

    #[test]
    fn test_resolve_and_batch() {
        let index = Arc::new(FileIndex::build_with_drive(
            "C:",
            vec![
                mk(5, 5, "C:", true),
                mk(10, 5, "Users", true),
                mk(11, 10, "readme.txt", false),
            ],
        ));
        let resolver = PathResolver::new(index);
        let row = resolver.index().find_exact("readme.txt").unwrap();
        assert_eq!(resolver.resolve(row), "C:\\Users\\readme.txt");
        let paths = resolver.resolve_batch(&[row]);
        assert_eq!(paths, vec!["C:\\Users\\readme.txt".to_string()]);
        assert!(resolver.cache_size() >= 1);
    }
}
