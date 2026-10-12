//! Synthetic MFT entry generator for benchmarking without elevation.
//!
//! Generates realistic directory trees and file entries adhering to NTFS structures.

use hphe_mft::record::MftEntry;

const FOLDER_NAMES: &[&str] = &[
    "Windows", "System32", "SysWOW64", "drivers", "etc",
    "Program Files", "Common Files", "Microsoft", "Windows Defender",
    "Users", "Administrator", "Default", "Public",
    "AppData", "Local", "Roaming", "LocalLow", "Temp",
    "Documents", "Downloads", "Pictures", "Music", "Videos",
    "Projects", "src", "target", "debug", "release", "deps",
    "build", "node_modules", "vendor", "docs", "bench", "tests",
    "config", "logs", "bin", "lib", "include", "share",
];

const EXTENSIONS: &[&str] = &[
    "dll", "exe", "sys", "rs", "toml", "json", "md", "txt",
    "log", "dat", "ini", "xml", "yaml", "png", "jpg", "zip",
    "tmp", "cache", "lock", "pdb", "lib", "obj", "c", "h",
    "cpp", "py", "js", "ts", "html", "css", "woff2", "pdf",
];

/// Synthetic MFT entry generator implementing `Iterator<Item = MftEntry>`.
pub struct SyntheticMftGenerator {
    total_count: usize,
    current_index: usize,
    dir_frns: Vec<u64>,
}

impl SyntheticMftGenerator {
    pub fn new(count: usize) -> Self {
        let mut dir_frns = Vec::with_capacity(count / 10 + 16);
        dir_frns.push(5); // Root directory FRN

        Self {
            total_count: count,
            current_index: 0,
            dir_frns,
        }
    }
}

impl Iterator for SyntheticMftGenerator {
    type Item = MftEntry;

    fn next(&mut self) -> Option<Self::Item> {
        if self.current_index >= self.total_count {
            return None;
        }

        let idx = self.current_index;
        self.current_index += 1;

        // Entry 0 is root directory
        if idx == 0 {
            return Some(MftEntry {
                frn: 5,
                record_number: 5,
                sequence_number: 1,
                parent_frn: 5,
                parent_record_number: 5,
                name: "C:".to_string(),
                size: 0,
                allocated_size: 0,
                created: 132_000_000_000_000_000,
                modified: 133_000_000_000_000_000,
                accessed: 134_000_000_000_000_000,
                mft_changed: 133_000_000_000_000_000,
                attributes: 0x10,
                is_dir: true,
                is_in_use: true,
                hard_links: 1,
                base_record_frn: 0,
            });
        }

        let frn = 1000 + idx as u64;
        let is_dir = (idx % 12 == 0) && (self.dir_frns.len() < (self.total_count / 8).max(10));

        // Choose a parent from known directories
        let parent_idx = idx % self.dir_frns.len();
        let parent_frn = self.dir_frns[parent_idx];

        let name = if is_dir {
            self.dir_frns.push(frn);
            let folder_base = FOLDER_NAMES[idx % FOLDER_NAMES.len()];
            if idx < FOLDER_NAMES.len() * 2 {
                folder_base.to_string()
            } else {
                format!("{}_{}", folder_base, idx / FOLDER_NAMES.len())
            }
        } else {
            let ext = EXTENSIONS[idx % EXTENSIONS.len()];
            let name_prefix = FOLDER_NAMES[(idx / 3) % FOLDER_NAMES.len()].to_lowercase();
            format!("{}_{}.{}", name_prefix, idx, ext)
        };

        let size = if is_dir {
            0
        } else {
            // Realistic varied sizes: small files, medium binaries, occasional large file
            match idx % 10 {
                0..=6 => (idx % 8192 + 64) as u64,
                7..=8 => ((idx % 65536) * 1024 + 4096) as u64,
                _ => ((idx % 1024) * 1_048_576 + 65536) as u64,
            }
        };

        let base_timestamp = 132_000_000_000_000_000u64;
        let delta = (idx as u64).wrapping_mul(10_000_000); // steps of 1 second

        Some(MftEntry {
            frn,
            record_number: frn & 0x0000_FFFF_FFFF_FFFF,
            sequence_number: 1,
            parent_frn,
            parent_record_number: parent_frn & 0x0000_FFFF_FFFF_FFFF,
            name,
            size,
            allocated_size: (size + 4095) & !4095,
            created: base_timestamp.wrapping_add(delta),
            modified: base_timestamp.wrapping_add(delta * 2),
            accessed: base_timestamp.wrapping_add(delta * 3),
            mft_changed: base_timestamp.wrapping_add(delta * 2),
            attributes: if is_dir { 0x10 } else { 0x20 },
            is_dir,
            is_in_use: true,
            hard_links: 1,
            base_record_frn: 0,
        })
    }
}

/// Generates a vector of synthetic MFT entries.
pub fn generate_synthetic_entries(count: usize) -> Vec<MftEntry> {
    SyntheticMftGenerator::new(count).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_synthetic_generator() {
        let generator = SyntheticMftGenerator::new(100);
        let entries: Vec<MftEntry> = generator.collect();

        assert_eq!(entries.len(), 100);
        assert_eq!(entries[0].name, "C:");
        assert!(entries[0].is_dir);

        let dirs_count = entries.iter().filter(|e| e.is_dir).count();
        let files_count = entries.iter().filter(|e| !e.is_dir).count();

        assert!(dirs_count >= 2);
        assert!(files_count > 80);
    }
}
