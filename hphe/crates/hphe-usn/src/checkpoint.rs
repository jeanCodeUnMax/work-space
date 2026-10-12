//! Checkpoint persistence for USN journal position.
//!
//! This module handles saving and loading the last processed USN for each volume,
//! allowing the watcher to resume from where it left off after a restart.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::UsnError;

/// Checkpoint data containing the last processed USN state for a volume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// Volume drive letter (e.g., "C")
    pub drive_letter: String,
    /// USN Journal ID at the time of checkpoint
    pub journal_id: i64,
    /// Last processed USN
    pub last_usn: i64,
    /// First USN in the journal at checkpoint time
    pub first_usn: i64,
    /// Timestamp when checkpoint was saved (Unix seconds)
    pub saved_at: i64,
}

impl Checkpoint {
    pub fn new(drive_letter: &str, journal_id: i64, last_usn: i64, first_usn: i64) -> Self {
        Self {
            drive_letter: drive_letter.to_uppercase(),
            journal_id,
            last_usn,
            first_usn,
            saved_at: chrono::Utc::now().timestamp(),
        }
    }

    pub fn needs_resync(&self, current_journal_id: i64, current_first_usn: i64) -> bool {
        // Resync needed if journal ID changed (journal was recreated)
        if self.journal_id != current_journal_id {
            return true;
        }

        // Resync needed if our last_usn is before the current first_usn
        // (journal wrapped around and overwrote old records)
        if self.last_usn < current_first_usn {
            return true;
        }

        false
    }
}

/// Stores and retrieves checkpoints for volumes.
pub struct CheckpointStore {
    base_path: PathBuf,
}

impl CheckpointStore {
    /// Creates a new CheckpointStore with the given base directory.
    pub fn new(base_path: impl AsRef<Path>) -> Self {
        Self {
            base_path: base_path.as_ref().to_path_buf(),
        }
    }

    /// Creates a new CheckpointStore in the program data directory.
    #[cfg(windows)]
    pub fn in_program_data() -> io::Result<Self> {
        use std::env;

        let program_data = env::var_os("PROGRAMDATA")
            .unwrap_or_else(|| "C:\\ProgramData".into());
        let base_path = Path::new(&program_data).join("HephaistosKit").join("hphe-usn");
        fs::create_dir_all(&base_path)?;

        Ok(Self { base_path })
    }

    /// Returns the checkpoint file path for a given drive.
    pub fn checkpoint_path(&self, drive_letter: &str) -> PathBuf {
        self.base_path.join(format!("{}.checkpoint", drive_letter.to_uppercase()))
    }

    /// Saves a checkpoint to disk.
    pub fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError> {
        let path = self.checkpoint_path(&checkpoint.drive_letter);
        
        // Write to temporary file first, then rename for atomicity
        let temp_path = path.with_extension("tmp");
        
        let json = serde_json::to_string_pretty(checkpoint)
            .map_err(|e| UsnError::CheckpointError {
                path: path.display().to_string(),
                source: io::Error::new(io::ErrorKind::InvalidData, e.to_string()),
            })?;

        fs::write(&temp_path, json.as_bytes())
            .map_err(|e| UsnError::CheckpointError {
                path: path.display().to_string(),
                source: e,
            })?;

        // Atomic rename
        fs::rename(temp_path, &path)
            .map_err(|e| UsnError::CheckpointError {
                path: path.display().to_string(),
                source: e,
            })?;

        Ok(())
    }

    /// Loads a checkpoint from disk for the given drive.
    pub fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError> {
        let path = self.checkpoint_path(drive_letter);
        
        if !path.exists() {
            return Ok(None);
        }

        let json = fs::read_to_string(&path)
            .map_err(|e| UsnError::CheckpointError {
                path: path.display().to_string(),
                source: e,
            })?;

        serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| UsnError::CheckpointError {
                path: path.display().to_string(),
                source: io::Error::new(io::ErrorKind::InvalidData, e.to_string()),
            })
    }

    /// Deletes a checkpoint file for the given drive.
    pub fn delete(&self, drive_letter: &str) -> Result<(), UsnError> {
        let path = self.checkpoint_path(drive_letter);
        
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| UsnError::CheckpointError {
                    path: path.display().to_string(),
                    source: e,
                })?;
        }

        Ok(())
    }

    /// Lists all available checkpoints.
    pub fn list(&self) -> io::Result<Vec<Checkpoint>> {
        let mut checkpoints = Vec::new();
        
        if !self.base_path.exists() {
            return Ok(checkpoints);
        }

        for entry in fs::read_dir(&self.base_path)? {
            let entry = entry?;
            let path = entry.path();
            
            if path.extension().and_then(|s| s.to_str()) == Some("checkpoint") {
                if let Ok(json) = fs::read_to_string(&path) {
                    if let Ok(checkpoint) = serde_json::from_str::<Checkpoint>(&json) {
                        checkpoints.push(checkpoint);
                    }
                }
            }
        }

        Ok(checkpoints)
    }
}

/// Trait for checkpoint storage (abstraction for production and testing).
pub trait CheckpointStoreTrait: Send + Sync {
    fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError>;
    fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError>;
    fn delete(&self, drive_letter: &str) -> Result<(), UsnError>;
}

impl CheckpointStoreTrait for CheckpointStore {
    fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError> {
        CheckpointStore::save(self, checkpoint)
    }

    fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError> {
        CheckpointStore::load(self, drive_letter)
    }

    fn delete(&self, drive_letter: &str) -> Result<(), UsnError> {
        CheckpointStore::delete(self, drive_letter)
    }
}

impl CheckpointStoreTrait for Box<dyn CheckpointStoreTrait> {
    fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError> {
        (**self).save(checkpoint)
    }

    fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError> {
        (**self).load(drive_letter)
    }

    fn delete(&self, drive_letter: &str) -> Result<(), UsnError> {
        (**self).delete(drive_letter)
    }
}

/// Memory checkpoint store for testing (doesn't persist to disk).
#[derive(Debug, Default)]
pub struct MemoryCheckpointStore {
    checkpoints: std::sync::RwLock<std::collections::HashMap<String, Checkpoint>>,
}

impl MemoryCheckpointStore {
    pub fn new() -> Self {
        Self {
            checkpoints: std::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError> {
        let mut map = self.checkpoints.write().map_err(|e| {
            UsnError::Io(io::Error::new(io::ErrorKind::Other, e.to_string()))
        })?;
        map.insert(checkpoint.drive_letter.to_uppercase(), checkpoint.clone());
        Ok(())
    }

    pub fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError> {
        let map = self.checkpoints.read().map_err(|e| {
            UsnError::Io(io::Error::new(io::ErrorKind::Other, e.to_string()))
        })?;
        Ok(map.get(&drive_letter.to_uppercase()).cloned())
    }

    pub fn delete(&self, drive_letter: &str) -> Result<(), UsnError> {
        let mut map = self.checkpoints.write().map_err(|e| {
            UsnError::Io(io::Error::new(io::ErrorKind::Other, e.to_string()))
        })?;
        map.remove(&drive_letter.to_uppercase());
        Ok(())
    }
}

impl CheckpointStoreTrait for MemoryCheckpointStore {
    fn save(&self, checkpoint: &Checkpoint) -> Result<(), UsnError> {
        self.save(checkpoint)
    }

    fn load(&self, drive_letter: &str) -> Result<Option<Checkpoint>, UsnError> {
        self.load(drive_letter)
    }

    fn delete(&self, drive_letter: &str) -> Result<(), UsnError> {
        self.delete(drive_letter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checkpoint_ser_de() {
        let cp = Checkpoint::new("C", 100, 5000, 0);
        let json = serde_json::to_string(&cp).unwrap();
        let loaded: Checkpoint = serde_json::from_str(&json).unwrap();
        
        assert_eq!(cp.drive_letter, loaded.drive_letter);
        assert_eq!(cp.journal_id, loaded.journal_id);
        assert_eq!(cp.last_usn, loaded.last_usn);
        assert_eq!(cp.first_usn, loaded.first_usn);
    }

    #[test]
    fn test_checkpoint_needs_resync_journal_id_change() {
        let cp = Checkpoint::new("C", 100, 5000, 0);
        assert!(cp.needs_resync(200, 0)); // Journal ID changed
        assert!(!cp.needs_resync(100, 0)); // Same journal ID
    }

    #[test]
    fn test_checkpoint_needs_resync_wrap() {
        let cp = Checkpoint::new("C", 100, 5000, 1000);
        assert!(!cp.needs_resync(100, 1000)); // last_usn >= first_usn
        assert!(cp.needs_resync(100, 6000)); // last_usn < first_usn (wrap)
    }

    #[test]
    fn test_memory_checkpoint_store() {
        let store = MemoryCheckpointStore::new();
        
        let cp = Checkpoint::new("C", 100, 5000, 0);
        store.save(&cp).unwrap();
        
        let loaded = store.load("C").unwrap().unwrap();
        assert_eq!(loaded.journal_id, 100);
        assert_eq!(loaded.last_usn, 5000);
        
        store.delete("C").unwrap();
        assert!(store.load("C").unwrap().is_none());
    }
}
