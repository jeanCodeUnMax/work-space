//! NTFS Runlist (Data Runs) parser for non-resident attributes.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MftExtent {
    /// Logical Cluster Number on disk (None if sparse extent).
    pub lcn: Option<u64>,
    /// Number of clusters in this extent.
    pub clusters: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunlistError {
    UnexpectedEnd,
    InvalidHeader,
    IntegerOverflow,
}

impl std::fmt::Display for RunlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnexpectedEnd => write!(f, "Unexpected end of data runlist"),
            Self::InvalidHeader => write!(f, "Invalid data run header (len_bytes is 0)"),
            Self::IntegerOverflow => write!(f, "LCN calculation overflowed"),
        }
    }
}

impl std::error::Error for RunlistError {}

/// Parses a non-resident attribute data runlist into a sequence of extents.
pub fn parse_runlist(data: &[u8]) -> Result<Vec<MftExtent>, RunlistError> {
    let mut extents = Vec::new();
    let mut cursor = 0;
    let mut current_lcn: i64 = 0;

    while cursor < data.len() {
        let header = data[cursor];
        cursor += 1;

        if header == 0 {
            // End of runlist marker
            break;
        }

        let len_bytes = (header & 0x0F) as usize;
        let offset_bytes = ((header >> 4) & 0x0F) as usize;

        if len_bytes == 0 || len_bytes > 8 || offset_bytes > 8 {
            return Err(RunlistError::InvalidHeader);
        }

        if cursor + len_bytes + offset_bytes > data.len() {
            return Err(RunlistError::UnexpectedEnd);
        }

        // Read run length (unsigned)
        let mut clusters: u64 = 0;
        for i in 0..len_bytes {
            clusters |= (data[cursor + i] as u64) << (i * 8);
        }
        cursor += len_bytes;

        // Read LCN offset delta (signed)
        if offset_bytes == 0 {
            // Sparse extent
            extents.push(MftExtent {
                lcn: None,
                clusters,
            });
        } else {
            let mut raw_offset: u64 = 0;
            for i in 0..offset_bytes {
                raw_offset |= (data[cursor + i] as u64) << (i * 8);
            }
            cursor += offset_bytes;

            // Sign-extend from the most significant bit of the read width
            let sign_bit = 1u64 << (offset_bytes * 8 - 1);
            let delta: i64 = if (raw_offset & sign_bit) != 0 {
                let mask = !((1u64 << (offset_bytes * 8)) - 1);
                (raw_offset | mask) as i64
            } else {
                raw_offset as i64
            };

            current_lcn = current_lcn
                .checked_add(delta)
                .ok_or(RunlistError::IntegerOverflow)?;

            if current_lcn < 0 {
                return Err(RunlistError::IntegerOverflow);
            }

            extents.push(MftExtent {
                lcn: Some(current_lcn as u64),
                clusters,
            });
        }
    }

    Ok(extents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_extent() {
        // header: 0x32 -> 2 bytes length, 3 bytes offset
        // len: 0x0100 (256 clusters)
        // offset: 0x001000 (4096 LCN)
        // 0x00: end marker
        let data = [0x32, 0x00, 0x01, 0x00, 0x10, 0x00, 0x00];
        let extents = parse_runlist(&data).unwrap();
        assert_eq!(extents.len(), 1);
        assert_eq!(extents[0].lcn, Some(4096));
        assert_eq!(extents[0].clusters, 256);
    }

    #[test]
    fn test_multi_extent_with_negative_delta() {
        // Run 1: header 0x21 (1 byte len, 2 bytes offset)
        // len = 16 (0x10)
        // offset = 1000 (0x03E8)
        // -> LCN 1000, 16 clusters
        //
        // Run 2: header 0x11 (1 byte len, 1 byte offset)
        // len = 8 (0x08)
        // offset = -10 (0xF6 as signed byte = -10)
        // -> LCN 990, 8 clusters
        let data = [
            0x21, 0x10, 0xE8, 0x03, // Run 1
            0x11, 0x08, 0xF6,       // Run 2: delta -10
            0x00,                   // End
        ];

        let extents = parse_runlist(&data).unwrap();
        assert_eq!(extents.len(), 2);
        assert_eq!(extents[0].lcn, Some(1000));
        assert_eq!(extents[0].clusters, 16);

        assert_eq!(extents[1].lcn, Some(990));
        assert_eq!(extents[1].clusters, 8);
    }

    #[test]
    fn test_sparse_run() {
        // Header 0x02 -> 2 bytes len, 0 bytes offset (sparse)
        // len = 64
        let data = [0x02, 0x40, 0x00, 0x00];
        let extents = parse_runlist(&data).unwrap();
        assert_eq!(extents.len(), 1);
        assert_eq!(extents[0].lcn, None);
        assert_eq!(extents[0].clusters, 64);
    }
}
