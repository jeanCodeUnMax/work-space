//! # hphe-content: Tantivy-backed content index (BM25 + snippets)
//!
//! P3 component of the Hephaistos Engine (see
//! `docs/hephaistos-engine/01-SPEC-MOTEUR.md` §"index contenu" and
//! `03-FAISABILITE-UNIFICATION.md` §2.2). It gives the engine fast
//! document-level search over file *contents* — something Everything.exe
//! does not do — on top of the same live file set the SoA `hphe-index`
//! already tracks.
//!
//! Tantivy (`0.22`, pure Rust) provides BM25 scoring, field columns, an
//! on-disk segment store with a merge policy, and (since 0.22) native HNSW
//! for a later vector phase. This crate wires that into an ergonomic,
//! FRN-keyed incremental index:
//!
//! - [`ContentSchema`] — the seven-field schema (path / file_id / mtime /
//!   ext / size / content / project_tag);
//! - [`ContentIndex`] — open/create, add/update/delete by FRN,
//!   `search_bm25` with HTML snippets, explicit `commit`;
//! - [`IngestPolicy`] + [`IngestState`] — incremental ingest policy tied to
//!   a `FileIndex` row iterator (extension + size filter, mtime skip);
//! - [`read_indexable`] — safe content reader (encoding detection, binary
//!   skip, size cap).

pub mod ingest;
pub mod index;
pub mod reader;
pub mod schema;

pub use index::{ContentError, ContentHit, ContentIndex, ContentIndexConfig};
pub use ingest::{Change, FileRow, IngestPolicy, IngestState};
pub use reader::{read_indexable, ReadOutcome};
pub use schema::ContentSchema;
