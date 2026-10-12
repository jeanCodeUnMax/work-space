//! # hphe-vec: Embedded HNSW vector store (usearch)
//!
//! P4 component of the Hephaistos Engine (see
//! `docs/hephaistos-engine/01-SPEC-MOTEUR.md` §"stack technique" and
//! `03-FAISABILITE-UNIFICATION.md` §3.1). It replaces the external
//! Qdrant (`:6333`) and Zvec (`:8001`) servers with a single embedded
//! store, closing two local network surfaces.
//!
//! ## Engine choice — why `usearch` and not tantivy HNSW
//!
//! tantivy 0.22.1 was expected to carry native HNSW since 0.22, but the
//! **installed crate exposes no vector/ANN API at all** (verified against
//! the crate source: no `knn`/`hnsw`/`embedding` symbols, no `vector`
//! feature). The BM25 content index therefore stays lexical, and vectors
//! live in their own store.
//!
//! `usearch` 2.26.4 (decision #309, `03-FAISABILITE-UNIFICATION.md` §0) was
//! selected: official Rust bindings over a statically-linked C++ HNSW core
//! (SIMD, mmap, `f16`/`i8` quantization). It compiles cleanly with the
//! local MSVC BuildTools 2022 toolchain. Honest trade-off, as documented in
//! the spec: the C++ core is compiled into the binary — this is still an
//! *embedded* deployment (no server, no port), same pattern as `zvec-rust`.
//! Pure-Rust fallbacks (`hnsw_rs`, `hora`) remain available if the recall
//! gate (`recall@10 >= 0.95`, `bench/p4-vec.md`) were not met.
//!
//! ## API
//!
//! - [`VecIndex`] — create/open/save/load an index on disk;
//! - `upsert_vector(frn, &[f32])` / `remove(frn)` / `knn(&[f32], k)`;
//! - keys are NTFS FRNs (`u64`), so vector rows join 1:1 onto `hphe-index`
//!   rows and `hphe-content` documents;
//! - metric = cosine (`MetricKind::Cos`), scalar = `F32`.
//!
//! A vector store is deliberately separate from `ContentIndex`: the spec
//! (§3.2) requires **two distinct semantic spaces** — 2048D (NVIDIA NIM)
//! and 384D (MiniLM) — never fused. One [`VecIndex`] instance = one
//! collection at one fixed dimension; use two instances for the two spaces.

use std::path::Path;

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

/// Default embedding dimension — 384D (all-MiniLM-L6-v2, the Zvec space).
pub const DEFAULT_DIMENSIONS: usize = 384;

/// Errors surfaced by the vector store.
#[derive(Debug)]
pub enum VecError {
    /// usearch returned an error (kept as a string: `cxx::Exception` is not `Clone`).
    Usearch(String),
    /// An input vector had the wrong length for this index.
    DimensionMismatch { expected: usize, got: usize },
    /// The key could not be resolved.
    MissingKey(u64),
}

impl std::fmt::Display for VecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usearch(e) => write!(f, "usearch error: {e}"),
            Self::DimensionMismatch { expected, got } => {
                write!(f, "vector dimension mismatch: expected {expected}, got {got}")
            }
            Self::MissingKey(k) => write!(f, "key {k} not present in index"),
        }
    }
}

impl std::error::Error for VecError {}

/// Maps a usearch FFI exception into our error type. usearch returns
/// `cxx::Exception`; we do not want a direct `cxx` dependency (usearch does
/// not re-export it), so we stringify here at every call boundary.
fn map_ffi<E: std::fmt::Display>(e: E) -> VecError {
    VecError::Usearch(e.to_string())
}

/// A single k-NN hit: the stored key (FRN) and its distance to the query.
/// With the cosine metric, smaller distance = more similar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VecHit {
    /// The stored key — an NTFS FRN joining onto `hphe-index` / `hphe-content`.
    pub key: u64,
    /// Distance to the query under the index metric (cosine distance here).
    pub distance: f32,
}

/// Configuration for opening / creating a [`VecIndex`].
#[derive(Debug, Clone, Copy)]
pub struct VecIndexConfig {
    /// Vector dimension (must be identical for every vector added).
    pub dimensions: usize,
    /// HNSW connectivity M — number of bi-directional links per node.
    /// Higher = better recall, more memory. `0` = usearch default.
    pub connectivity: usize,
    /// Size of the dynamic candidate list at build time (recall/latency knob).
    /// `0` = usearch default.
    pub expansion_add: usize,
    /// Size of the dynamic candidate list at search time (recall/latency knob).
    /// `0` = usearch default.
    pub expansion_search: usize,
    /// Optional capacity reservation hint (number of vectors).
    pub capacity: usize,
}

impl Default for VecIndexConfig {
    fn default() -> Self {
        Self {
            dimensions: DEFAULT_DIMENSIONS,
            connectivity: 0,
            expansion_add: 0,
            expansion_search: 0,
            capacity: 0,
        }
    }
}

impl VecIndexConfig {
    /// A config tuned for higher recall on this engine's corpus
    /// (M = 16, ef_search = 64). Used by the recall gate benchmark.
    pub fn recall_tuned(dimensions: usize, capacity: usize) -> Self {
        Self {
            dimensions,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            capacity,
        }
    }
}

/// An embedded HNSW vector store backed by usearch.
///
/// Keys are `u64` FRNs. `Clone`-able: usearch's `Index` is `Send + Sync`,
/// and we hold it behind an `Arc` so a clone shares the same underlying
/// index (matching the `ContentIndex` ergonomics).
#[derive(Clone)]
pub struct VecIndex {
    inner: std::sync::Arc<VecIndexInner>,
}

struct VecIndexInner {
    index: Index,
    dimensions: usize,
    dir: Option<std::path::PathBuf>,
}

fn build_index(cfg: &VecIndexConfig) -> Result<Index, VecError> {
    if cfg.dimensions == 0 {
        return Err(VecError::Usearch("dimensions must be > 0".to_string()));
    }
    let mut options = IndexOptions::default();
    options.dimensions = cfg.dimensions;
    options.metric = MetricKind::Cos;
    options.quantization = ScalarKind::F32;
    options.connectivity = cfg.connectivity;
    options.expansion_add = cfg.expansion_add;
    options.expansion_search = cfg.expansion_search;
    options.multi = false;

    let index = Index::new(&options).map_err(map_ffi)?;
    // usearch requires reserve() before any add — reserve a sensible minimum
    // when the caller didn't hint a capacity.
    index.reserve(cfg.capacity.max(1024)).map_err(map_ffi)?;
    Ok(index)
}

impl VecIndex {
    /// Creates a brand-new in-memory index with `cfg` (optionally
    /// remembering `dir` for [`save`](Self::save)).
    pub fn create<P: AsRef<Path>>(cfg: &VecIndexConfig, dir: Option<P>) -> Result<Self, VecError> {
        let index = build_index(cfg)?;
        Ok(Self {
            inner: std::sync::Arc::new(VecIndexInner {
                index,
                dimensions: cfg.dimensions,
                dir: dir.map(|p| p.as_ref().to_path_buf()),
            }),
        })
    }

    /// Opens an index persisted by a previous [`save`](Self::save), loading it
    /// into memory. The dimension/metric are read from the file header, so the
    /// stored config is authoritative.
    pub fn open<P: AsRef<Path>>(dir: P, file: &str) -> Result<Self, VecError> {
        let path = dir.as_ref().join(file);
        // Read metadata to reconstruct matching options before loading.
        let meta = Index::metadata(&path.to_string_lossy()).map_err(map_ffi)?;
        let cfg = VecIndexConfig {
            dimensions: meta.dimensions as usize,
            capacity: 0,
            ..Default::default()
        };
        let index = build_index(&cfg)?;
        index.load(&path.to_string_lossy()).map_err(map_ffi)?;
        Ok(Self {
            inner: std::sync::Arc::new(VecIndexInner {
                index,
                dimensions: meta.dimensions as usize,
                dir: Some(dir.as_ref().to_path_buf()),
            }),
        })
    }

    /// Opens `dir/file` if present, otherwise creates a new empty index with
    /// `cfg` (recording `dir` so a later [`save`](Self::save) persists it).
    pub fn open_or_create<P: AsRef<Path>>(
        dir: P,
        file: &str,
        cfg: &VecIndexConfig,
    ) -> Result<Self, VecError> {
        let path = dir.as_ref().join(file);
        if path.exists() {
            Self::open(&dir, file)
        } else {
            Self::create(cfg, Some(dir))
        }
    }

    /// Persists the index to `dir/file` (atomic-ish: usearch writes then we
    /// return). Creates `dir` if needed.
    pub fn save(&self, file: &str) -> Result<(), VecError> {
        let dir = self
            .inner
            .dir
            .as_ref()
            .ok_or_else(|| VecError::Usearch("no directory configured for save".to_string()))?;
        std::fs::create_dir_all(dir).map_err(|e| VecError::Usearch(e.to_string()))?;
        let path = dir.join(file);
        self.inner.index.save(&path.to_string_lossy()).map_err(map_ffi)?;
        Ok(())
    }

    /// The configured vector dimension.
    pub fn dimensions(&self) -> usize {
        self.inner.dimensions
    }

    fn check_dim(&self, vector: &[f32]) -> Result<(), VecError> {
        if vector.len() != self.inner.dimensions {
            return Err(VecError::DimensionMismatch {
                expected: self.inner.dimensions,
                got: vector.len(),
            });
        }
        Ok(())
    }

    /// Adds (or replaces) the vector for `key` (an FRN).
    pub fn upsert_vector(&self, key: u64, vector: &[f32]) -> Result<(), VecError> {
        self.check_dim(vector)?;
        // usearch high-level wrappers reject duplicate keys — remove first.
        if self.inner.index.contains(key) {
            let _ = self.inner.index.remove(key);
        }
        self.inner.index.add(key, vector).map_err(map_ffi)?;
        Ok(())
    }

    /// Removes `key` from the index. Returns `true` if it was present.
    pub fn remove(&self, key: u64) -> Result<bool, VecError> {
        let n = self.inner.index.remove(key).map_err(map_ffi)?;
        Ok(n > 0)
    }

    /// Whether `key` is present.
    pub fn contains(&self, key: u64) -> bool {
        self.inner.index.contains(key)
    }

    /// Number of live vectors in the index.
    pub fn len(&self) -> usize {
        self.inner.index.size()
    }

    /// Whether the index holds no vectors.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Approximate nearest-neighbour search (HNSW). Returns up to `k` hits
    /// ordered by ascending distance.
    pub fn knn(&self, query: &[f32], k: usize) -> Result<Vec<VecHit>, VecError> {
        self.check_dim(query)?;
        let matches = self.inner.index.search(query, k).map_err(map_ffi)?;
        Ok(zip_matches(&matches))
    }

    /// Exact brute-force nearest-neighbour search — the recall ground truth.
    /// Slower than [`knn`](Self::knn) but returns the true top-`k`.
    pub fn exact_knn(&self, query: &[f32], k: usize) -> Result<Vec<VecHit>, VecError> {
        self.check_dim(query)?;
        let matches = self.inner.index.exact_search(query, k).map_err(map_ffi)?;
        Ok(zip_matches(&matches))
    }

    /// Retrieves the stored vector for `key` (or `None` if absent).
    pub fn get(&self, key: u64) -> Result<Option<Vec<f32>>, VecError> {
        if !self.contains(key) {
            return Ok(None);
        }
        let mut out = vec![0.0f32; self.inner.dimensions];
        // usearch `get` returns the number of keys found (0/1), not the
        // element count — the buffer is already dimension-sized.
        let n = self.inner.index.get(key, &mut out).map_err(map_ffi)?;
        Ok((n > 0).then_some(out))
    }

    /// usearch hardware acceleration in use (informational).
    pub fn hardware_acceleration(&self) -> String {
        self.inner.index.hardware_acceleration()
    }
}

fn zip_matches(matches: &usearch::ffi::Matches) -> Vec<VecHit> {
    matches
        .keys
        .iter()
        .zip(matches.distances.iter())
        .map(|(&key, &distance)| VecHit { key, distance })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(dim: usize) -> VecIndexConfig {
        VecIndexConfig {
            dimensions: dim,
            ..Default::default()
        }
    }

    #[test]
    fn upsert_and_knn_returns_nearest() {
        let idx = VecIndex::create(&cfg(4), None::<&str>).unwrap();
        idx.upsert_vector(1, &[1.0, 0.0, 0.0, 0.0]).unwrap();
        idx.upsert_vector(2, &[0.0, 1.0, 0.0, 0.0]).unwrap();
        idx.upsert_vector(3, &[0.9, 0.1, 0.0, 0.0]).unwrap();

        // Query closest to key 1 / 3.
        let hits = idx.knn(&[1.0, 0.0, 0.0, 0.0], 3).unwrap();
        assert_eq!(hits.len(), 3);
        // Nearest must be one of the "x-axis" vectors.
        assert!(hits[0].key == 1 || hits[0].key == 3);
        // Distances are ascending.
        assert!(hits[0].distance <= hits[1].distance);
        assert!(hits[1].distance <= hits[2].distance);
    }

    #[test]
    fn dimension_mismatch_rejected() {
        let idx = VecIndex::create(&cfg(4), None::<&str>).unwrap();
        let err = idx.upsert_vector(1, &[1.0, 0.0, 0.0]).unwrap_err();
        assert!(matches!(err, VecError::DimensionMismatch { expected: 4, got: 3 }));
        let err = idx.knn(&[1.0, 0.0], 1).unwrap_err();
        assert!(matches!(err, VecError::DimensionMismatch { .. }));
    }

    #[test]
    fn upsert_replaces_same_key() {
        let idx = VecIndex::create(&cfg(3), None::<&str>).unwrap();
        idx.upsert_vector(7, &[1.0, 0.0, 0.0]).unwrap();
        idx.upsert_vector(7, &[0.0, 1.0, 0.0]).unwrap();
        assert_eq!(idx.len(), 1, "same key must replace, not duplicate");

        let got = idx.get(7).unwrap().unwrap();
        assert!(got[1] > got[0], "stored vector is the updated one");
    }

    #[test]
    fn remove_and_contains() {
        let idx = VecIndex::create(&cfg(3), None::<&str>).unwrap();
        idx.upsert_vector(42, &[1.0, 0.0, 0.0]).unwrap();
        assert!(idx.contains(42));
        assert!(idx.remove(42).unwrap());
        assert!(!idx.contains(42));
        assert!(!idx.remove(42).unwrap(), "removing absent key = false");
    }

    #[test]
    fn get_missing_key_is_none() {
        let idx = VecIndex::create(&cfg(3), None::<&str>).unwrap();
        assert!(idx.get(99).unwrap().is_none());
    }

    #[test]
    fn persistence_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        {
            let idx = VecIndex::create(&cfg(5), Some(dir.path())).unwrap();
            idx.upsert_vector(1, &[1.0, 0.0, 0.0, 0.0, 0.0]).unwrap();
            idx.upsert_vector(2, &[0.0, 1.0, 0.0, 0.0, 0.0]).unwrap();
            idx.save("vec.usearch").unwrap();
        }
        // Reopen from disk.
        let idx = VecIndex::open(dir.path(), "vec.usearch").unwrap();
        assert_eq!(idx.len(), 2);
        assert_eq!(idx.dimensions(), 5);
        let hits = idx.knn(&[1.0, 0.0, 0.0, 0.0, 0.0], 2).unwrap();
        assert_eq!(hits[0].key, 1);
    }

    #[test]
    fn open_or_create_creates_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let idx = VecIndex::open_or_create(dir.path(), "vec.usearch", &cfg(8)).unwrap();
        assert_eq!(idx.dimensions(), 8);
        assert!(idx.is_empty());
        // Second call reopens the (still empty) file only after a save.
        idx.upsert_vector(3, &[0.5; 8]).unwrap();
        idx.save("vec.usearch").unwrap();
        let idx2 = VecIndex::open_or_create(dir.path(), "vec.usearch", &cfg(8)).unwrap();
        assert_eq!(idx2.len(), 1);
    }

    #[test]
    fn recall_tuned_config_applies() {
        let idx = VecIndex::create(&VecIndexConfig::recall_tuned(4, 100), None::<&str>).unwrap();
        assert_eq!(idx.dimensions(), 4);
        idx.upsert_vector(1, &[1.0, 0.0, 0.0, 0.0]).unwrap();
        assert!(idx.contains(1));
    }
}
