//! NTFS Boot Sector parser and BPB geometry.

pub const NTFS_BOOT_SECTOR_SIZE: usize = 512;
pub const NTFS_OEM_ID: &[u8; 8] = b"NTFS    ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NtfsBootSector {
    pub bytes_per_sector: u16,
    pub sectors_per_cluster: u8,
    pub cluster_size: u64,
    pub total_sectors: u64,
    pub mft_lcn: u64,
    pub mft_mirr_lcn: u64,
    pub clusters_per_file_record: i8,
    pub file_record_size: u32,
    pub volume_serial: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootSectorError {
    BufferTooSmall(usize),
    InvalidOemId([u8; 8]),
    InvalidGeometry,
}

impl std::fmt::Display for BootSectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferTooSmall(sz) => write!(f, "Boot sector buffer too small: {sz} bytes (expected 512)"),
            Self::InvalidOemId(oem) => write!(f, "Invalid OEM ID: {:?} (expected NTFS)", String::from_utf8_lossy(oem)),
            Self::InvalidGeometry => write!(f, "Invalid cluster or sector geometry in boot sector"),
        }
    }
}

impl std::error::Error for BootSectorError {}

/// Parses an NTFS boot sector (BPB) from the first 512 bytes of a volume.
pub fn parse_boot_sector(data: &[u8]) -> Result<NtfsBootSector, BootSectorError> {
    if data.len() < NTFS_BOOT_SECTOR_SIZE {
        return Err(BootSectorError::BufferTooSmall(data.len()));
    }

    let mut oem_id = [0u8; 8];
    oem_id.copy_from_slice(&data[3..11]);
    if &oem_id != NTFS_OEM_ID {
        return Err(BootSectorError::InvalidOemId(oem_id));
    }

    let bytes_per_sector = u16::from_le_bytes([data[0x0B], data[0x0C]]);
    let sectors_per_cluster = data[0x0D];

    if bytes_per_sector == 0 || sectors_per_cluster == 0 {
        return Err(BootSectorError::InvalidGeometry);
    }

    let cluster_size = (bytes_per_sector as u64) * (sectors_per_cluster as u64);
    let total_sectors = u64::from_le_bytes(
        data[0x28..0x30].try_into().map_err(|_| BootSectorError::InvalidGeometry)?
    );
    let mft_lcn = u64::from_le_bytes(
        data[0x30..0x38].try_into().map_err(|_| BootSectorError::InvalidGeometry)?
    );
    let mft_mirr_lcn = u64::from_le_bytes(
        data[0x38..0x40].try_into().map_err(|_| BootSectorError::InvalidGeometry)?
    );
    let clusters_per_file_record = data[0x40] as i8;

    // NTFS file record size:
    // If clusters_per_file_record > 0: clusters_per_file_record * cluster_size
    // If clusters_per_file_record < 0: 2^(-clusters_per_file_record) bytes
    // (typically -10 = 0xF6 -> 2^10 = 1024 bytes)
    let file_record_size = if clusters_per_file_record > 0 {
        (clusters_per_file_record as u32) * (cluster_size as u32)
    } else {
        let shift = (-clusters_per_file_record) as u32;
        if shift > 30 {
            return Err(BootSectorError::InvalidGeometry);
        }
        1u32 << shift
    };

    let volume_serial = u64::from_le_bytes(
        data[0x48..0x50].try_into().map_err(|_| BootSectorError::InvalidGeometry)?
    );

    Ok(NtfsBootSector {
        bytes_per_sector,
        sectors_per_cluster,
        cluster_size,
        total_sectors,
        mft_lcn,
        mft_mirr_lcn,
        clusters_per_file_record,
        file_record_size,
        volume_serial,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_boot_sector() {
        let mut buf = vec![0u8; 512];
        buf[0..3].copy_from_slice(&[0xEB, 0x52, 0x90]);
        buf[3..11].copy_from_slice(b"NTFS    ");
        buf[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes()); // 512 bytes/sector
        buf[0x0D] = 8; // 8 sectors/cluster = 4096 bytes/cluster
        buf[0x28..0x30].copy_from_slice(&100_000_000u64.to_le_bytes());
        buf[0x30..0x38].copy_from_slice(&786432u64.to_le_bytes()); // mft_lcn
        buf[0x38..0x40].copy_from_slice(&2u64.to_le_bytes()); // mft_mirr
        buf[0x40] = 0xF6; // -10 signed -> 1024 bytes
        buf[0x48..0x50].copy_from_slice(&0x1234_5678_9ABC_DEF0u64.to_le_bytes());

        let bs = parse_boot_sector(&buf).unwrap();
        assert_eq!(bs.bytes_per_sector, 512);
        assert_eq!(bs.sectors_per_cluster, 8);
        assert_eq!(bs.cluster_size, 4096);
        assert_eq!(bs.mft_lcn, 786432);
        assert_eq!(bs.file_record_size, 1024);
        assert_eq!(bs.volume_serial, 0x1234_5678_9ABC_DEF0);
    }

    #[test]
    fn test_invalid_oem() {
        let mut buf = vec![0u8; 512];
        buf[3..11].copy_from_slice(b"FAT32   ");
        let res = parse_boot_sector(&buf);
        assert!(matches!(res, Err(BootSectorError::InvalidOemId(_))));
    }
}
