//! NTFS Update Sequence Array (USA) fixup verification and repair.

pub const NTFS_SECTOR_SIZE: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FixupError {
    RecordTooSmall(usize),
    InvalidUsaOffset { offset: usize, record_len: usize },
    InvalidUsaCount(usize),
    SequenceMismatch {
        sector: usize,
        expected: u16,
        actual: u16,
    },
}

impl std::fmt::Display for FixupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RecordTooSmall(len) => write!(f, "Record too small for USA fixup: {len} bytes"),
            Self::InvalidUsaOffset { offset, record_len } => {
                write!(f, "USA offset {offset} out of bounds for record {record_len}")
            }
            Self::InvalidUsaCount(cnt) => write!(f, "Invalid USA count: {cnt}"),
            Self::SequenceMismatch { sector, expected, actual } => write!(
                f,
                "USA sequence mismatch on sector {sector}: expected 0x{expected:04X}, found 0x{actual:04X}"
            ),
        }
    }
}

impl std::error::Error for FixupError {}

/// Applies the USA fixup to an in-memory FILE record buffer in-place.
///
/// In NTFS, each sector boundary (last 2 bytes of every 512 bytes) is overwritten
/// on disk with the Update Sequence Number (USN). The original bytes are stored
/// in the Update Sequence Array in the record header.
///
/// This function verifies the USN at the end of every sector and restores
/// the original bytes.
pub fn apply_usa_fixup(record: &mut [u8]) -> Result<(), FixupError> {
    if record.len() < NTFS_SECTOR_SIZE {
        return Err(FixupError::RecordTooSmall(record.len()));
    }

    let usa_offset = u16::from_le_bytes([record[4], record[5]]) as usize;
    let usa_count = u16::from_le_bytes([record[6], record[7]]) as usize;

    if usa_offset + usa_count * 2 > record.len() {
        return Err(FixupError::InvalidUsaOffset {
            offset: usa_offset,
            record_len: record.len(),
        });
    }

    if usa_count < 2 {
        return Err(FixupError::InvalidUsaCount(usa_count));
    }

    let expected_usn = u16::from_le_bytes([record[usa_offset], record[usa_offset + 1]]);
    let num_sectors = usa_count - 1;

    for i in 0..num_sectors {
        let sector_end = (i + 1) * NTFS_SECTOR_SIZE - 2;
        if sector_end + 2 > record.len() {
            break;
        }

        let actual_usn = u16::from_le_bytes([record[sector_end], record[sector_end + 1]]);
        if actual_usn != expected_usn {
            return Err(FixupError::SequenceMismatch {
                sector: i,
                expected: expected_usn,
                actual: actual_usn,
            });
        }

        let replacement_offset = usa_offset + 2 + i * 2;
        record[sector_end] = record[replacement_offset];
        record[sector_end + 1] = record[replacement_offset + 1];
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_fixup() {
        let mut buf = vec![0u8; 1024];
        // Magic FILE
        buf[0..4].copy_from_slice(b"FILE");
        // USA offset = 48
        buf[4..6].copy_from_slice(&48u16.to_le_bytes());
        // USA count = 3 (1 USN + 2 sectors)
        buf[6..8].copy_from_slice(&3u16.to_le_bytes());

        let usn: u16 = 0x42AA;
        buf[48..50].copy_from_slice(&usn.to_le_bytes());
        // Original sector 0 bytes: 0x1122
        buf[50..52].copy_from_slice(&0x1122u16.to_le_bytes());
        // Original sector 1 bytes: 0x3344
        buf[52..54].copy_from_slice(&0x3344u16.to_le_bytes());

        // On disk, sector ends have the USN
        buf[510..512].copy_from_slice(&usn.to_le_bytes());
        buf[1022..1024].copy_from_slice(&usn.to_le_bytes());

        assert!(apply_usa_fixup(&mut buf).is_ok());

        // Verify restoration
        assert_eq!(&buf[510..512], &0x1122u16.to_le_bytes());
        assert_eq!(&buf[1022..1024], &0x3344u16.to_le_bytes());
    }

    #[test]
    fn test_mismatched_usn() {
        let mut buf = vec![0u8; 1024];
        buf[0..4].copy_from_slice(b"FILE");
        buf[4..6].copy_from_slice(&48u16.to_le_bytes());
        buf[6..8].copy_from_slice(&3u16.to_le_bytes());

        let usn: u16 = 0x42AA;
        buf[48..50].copy_from_slice(&usn.to_le_bytes());
        buf[50..52].copy_from_slice(&0x1122u16.to_le_bytes());
        buf[52..54].copy_from_slice(&0x3344u16.to_le_bytes());

        // Corrupted sector 0 end: wrong USN
        buf[510..512].copy_from_slice(&0x9999u16.to_le_bytes());
        buf[1022..1024].copy_from_slice(&usn.to_le_bytes());

        let res = apply_usa_fixup(&mut buf);
        assert!(matches!(res, Err(FixupError::SequenceMismatch { sector: 0, .. })));
    }
}
