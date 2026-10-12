//! Safe file-content reader for the ingest pipeline.
//!
//! Responsibilities:
//! - read a file from disk with a hard size cap (`max_bytes`) so a huge or
//!   adversarial file can never exhaust memory;
//! - basic encoding detection (UTF-8 BOM, UTF-16 LE/BE BOM, else Latin-1 as a
//!   lossy fallback) via `encoding_rs`;
//! - binary sniffing: if the byte head contains a NUL byte (or a high ratio of
//!   non-text control bytes) the file is treated as binary and skipped.
//!
//! It never panics on malformed input: all decoding is lossy and loss-tolerant.

use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Outcome of attempting to read a file for indexing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// Text content, successfully decoded (lossy).
    Text(String),
    /// File is (very likely) binary — caller should skip indexing.
    Binary,
    /// File could not be read (missing, permission, IO error).
    Error(String),
}

/// Result of a binary sniff over the head of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextKind {
    /// Decodable as text (UTF-8/16/Latin-1, no NUL).
    Text,
    /// Contains a NUL byte in the head → treat as binary.
    Binary,
}

/// Detects whether the leading `head` bytes look like text or binary.
///
/// Heuristic (cheap, no dependencies beyond what we already read):
/// - a NUL byte anywhere in the head ⇒ binary (this catches PE/ELF/images/etc.);
/// - otherwise count "textual" bytes; if the ratio of suspicious control
///   bytes is high (> 10% of the head) ⇒ binary. This catches e.g. UTF-16
///   without a BOM (lots of 0x00 handled above) and compressed blobs.
fn sniff_text(head: &[u8]) -> TextKind {
    if head.is_empty() {
        // Empty file is harmless text.
        return TextKind::Text;
    }
    if head.contains(&0x00) {
        return TextKind::Binary;
    }
    let mut suspicious = 0usize;
    for &b in head {
        // Allowed control chars: tab, LF, CR, FF, ESC. Everything else below
        // 0x20 that is not one of those counts as suspicious.
        let is_allowed_ctrl = matches!(b, b'\t' | b'\n' | b'\r' | 0x0C | 0x1B);
        if b < 0x20 && !is_allowed_ctrl {
            suspicious += 1;
        }
    }
    // >10% suspicious control bytes ⇒ binary.
    if suspicious * 10 > head.len() {
        return TextKind::Binary;
    }
    TextKind::Text
}

/// Decodes a byte buffer to a UTF-8 `String` using basic encoding detection.
///
/// - UTF-8 BOM (`EF BB BF`) → strip, decode UTF-8;
/// - UTF-16 LE BOM (`FF FE`) / BE BOM (`FE FF`) → decode UTF-16 (BOM handled);
/// - otherwise → try strict UTF-8; if that fails, fall back to windows-1252
///   (a superset of Latin-1 for printable range) losslessly via `encoding_rs`.
fn decode_bytes(bytes: &[u8]) -> String {
    // UTF-8 BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    // UTF-16 LE BOM
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    // UTF-16 BE BOM
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    // Plain UTF-8 (strict) — the common case for source files.
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    // Fallback: windows-1252 (printable Latin-1 superset).
    let (cow, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    cow.into_owned()
}

/// Reads a file for content indexing, capped at `max_bytes`.
///
/// Returns [`ReadOutcome::Binary`] for files that sniff as binary,
/// [`ReadOutcome::Text`] with lossily-decoded content otherwise, and
/// [`ReadOutcome::Error`] on IO failure. Never panics.
pub fn read_indexable(path: &Path, max_bytes: usize) -> ReadOutcome {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => return ReadOutcome::Error(format!("open failed: {e}")),
    };

    // Read up to max_bytes (+1 to detect "at least" overflow cheaply).
    let mut buf = Vec::new();
    match file.take((max_bytes as u64).saturating_add(1)).read_to_end(&mut buf) {
        Ok(_) => {}
        Err(e) => return ReadOutcome::Error(format!("read failed: {e}")),
    }

    // Sniff on the first chunk of the actual content.
    let head = &buf[..buf.len().min(8192)];
    if sniff_text(head) == TextKind::Binary {
        return ReadOutcome::Binary;
    }

    // Hard cap: if we read more than max_bytes, truncate the content so a
    // pathological file cannot balloon the index. We keep the first max_bytes.
    if buf.len() > max_bytes {
        buf.truncate(max_bytes);
        // Avoid cutting a multi-byte UTF-8 char in half: trim trailing bytes
        // that are UTF-8 continuation bytes until we land on a boundary or
        // run out. (decode is lossy anyway, but this keeps output clean.)
        while buf.last().map(|&b| b & 0xC0 == 0x80).unwrap_or(false) {
            buf.pop();
        }
    }

    ReadOutcome::Text(decode_bytes(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_text() {
        assert_eq!(sniff_text(b""), TextKind::Text);
    }

    #[test]
    fn nul_byte_is_binary() {
        assert_eq!(sniff_text(&[0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), TextKind::Binary);
        assert_eq!(sniff_text(b"hello\x00world"), TextKind::Binary);
    }

    #[test]
    fn plain_ascii_is_text() {
        assert_eq!(sniff_text(b"fn main() { println!(\"hi\"); }"), TextKind::Text);
    }

    #[test]
    fn high_control_ratio_is_binary() {
        // 0x01..0x08 are all "suspicious" control bytes.
        let data = vec![0x01u8; 64];
        assert_eq!(sniff_text(&data), TextKind::Binary);
    }

    #[test]
    fn decode_utf8_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("héllo".as_bytes());
        assert_eq!(decode_bytes(&b), "héllo");
    }

    #[test]
    fn decode_utf16le_bom() {
        // "hi" in UTF-16 LE with BOM
        let b = vec![0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        assert_eq!(decode_bytes(&b), "hi");
    }

    #[test]
    fn decode_plain_utf8() {
        assert_eq!(decode_bytes("café ☕".as_bytes()), "café ☕");
    }

    #[test]
    fn decode_latin1_fallback() {
        // 0xE9 = 'é' in latin1 / invalid as standalone UTF-8
        assert_eq!(decode_bytes(&[0xE9]), "é");
    }

    #[test]
    fn read_missing_file_errors() {
        let out = read_indexable(Path::new("this/does/not/exist.rs"), 1024);
        assert!(matches!(out, ReadOutcome::Error(_)));
    }
}
