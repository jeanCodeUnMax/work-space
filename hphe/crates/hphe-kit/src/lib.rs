//! hphe-kit — the unified Hephaistos-Kit layer.
//!
//! Absorbs the previously-separate MCPs into one Rust crate:
//!   orchestrator-server (tasks/agents/dispatch/worktrees)  -> `orch`
//!   model-discovery (live provider probes)                 -> `models`
//!   nim-router-mcp (NVIDIA NIM domain routing)             -> `nim`
//!   agentMemory (per-project JSON memory bank)             -> `memory`
//!   .agent/rag Python ingestion (Tantivy + usearch)        -> `ingest`
//!
//! Shared state stays in the SAME stores the old servers used
//! (orchestrator.db, agentmemory/data.json, registre-modeles.json)
//! so nothing is lost and rollback to the legacy servers is possible.

pub mod ingest;
pub mod memory;
pub mod models;
pub mod nim;
pub mod orch;

use std::path::PathBuf;

/// Default orchestrator SQLite database (shared with the legacy Node server).
pub const DEFAULT_ORCH_DB: &str =
    "C:/Program Files/servers/orchestrator-server/data/orchestrator.db";
/// Default agentmemory data root (per-project `agentmemory/data.json`).
pub const DEFAULT_MEMORY_ROOT: &str = "F:/Sqlite-DB/agentmemory";
/// Default NVIDIA NIM base URL.
pub const DEFAULT_NIM_BASE: &str = "https://integrate.api.nvidia.com/v1";

/// Resolve the orchestrator DB path: `HPHE_ORCH_DB` > default.
pub fn orch_db_path() -> PathBuf {
    std::env::var("HPHE_ORCH_DB")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ORCH_DB))
}

/// Resolve the agentmemory root: `HPHE_MEMORY_ROOT` > default.
pub fn memory_root() -> PathBuf {
    std::env::var("HPHE_MEMORY_ROOT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_MEMORY_ROOT))
}

/// NVIDIA NIM base URL: `NVIDIA_BASE_URL` > default.
pub fn nim_base() -> String {
    std::env::var("NVIDIA_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_NIM_BASE.to_string())
}

/// NIM API key for account 1/2.
pub fn nim_key(account: u8) -> Option<String> {
    let var = if account == 2 { "NVIDIA_API_KEY_2" } else { "NVIDIA_API_KEY" };
    std::env::var(var).ok().filter(|v| !v.trim().is_empty())
}
