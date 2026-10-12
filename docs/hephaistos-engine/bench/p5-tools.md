# Hephaistos Engine: MCP Tool Surface & Backend Implementation (T-092)

## 1. Overview

In milestone T-092, the initial V1 stubs for content and vector tools in `hphe-mcp` were replaced with real, fully functional implementations directly integrating the unified Hephaistos Engine crates:
- **`hphe-content`** (Tantivy 0.22, BM25 text search + HTML snippets)
- **`hphe-vec`** (usearch 2.26, embedded HNSW k-NN vector search)

Additionally, multi-collection support, vector stats, and multi-modal hybrid search (combining filename, BM25 text, and vector distance) were implemented with lazy initialization and zero cold-start penalty.

---

## 2. Tool Implementation Matrix: Real vs Remaining Stubs

| Tool Name | Status | Backend | Implementation Details |
|---|---|---|---|
| `everything_search` | Real | Daemon Named Pipe (`hphe-ipc`) | Fast NTFS filename search with Everything syntax via `hphe-indexd` |
| `search_files` | Real | Daemon Named Pipe (`hphe-ipc`) | Alias for `everything_search` |
| `everything_count` | Real | Daemon Named Pipe (`hphe-ipc`) | Count matching records without row retrieval |
| `everything_categories` | Real | In-Process | 6 category definitions and extension sets |
| `everything_index_stats` | Real | Daemon Named Pipe (`hphe-ipc`) | Daemon index statistics (entries, files, dirs, memory) |
| `everything_stats` | Real | Daemon Named Pipe (`hphe-ipc`) | Alias for `everything_index_stats` |
| `everything_refresh` | Real | Daemon Named Pipe / In-Proc | Refresh index or trigger rebuild |
| `everything_open_gui` | Real | In-Process | Visualizer launcher (Everything.exe GUI) |
| `resolve_path` | Real | Daemon Named Pipe (`hphe-ipc`) | Resolves FileIndex row to full path and FRN |
| `hphe_health` | Real | Daemon Named Pipe (`hphe-ipc`) | Health check for server and IPC pipe connectivity |
| `fs_*` (12 tools) | Real | Local Kernel Filesystem | `read`, `write`, `list`, `info`, `move`, `copy`, `delete`, `multi-read`, `edit`, `tree`, `search`, `allowed_roots` |
| **`content_search`** | **Real (T-092)** | **`hphe-content` (Tantivy BM25)** | Full-text search with HTML snippets; lazy init via read-only open; clean `{ status: "index_absent", matches: [] }` on missing index |
| **`vec_search`** | **Real (T-092)** | **`hphe-vec` (usearch HNSW)** | k-NN vector search; multi-collection support (`*.usearch`), vector array or `query_key` FRN lookup |
| **`semantic_search`** | **Real (T-092)** | **`hphe-vec` (usearch HNSW)** | Semantic vector search alias forwarding to `vec_search` |
| **`vec_stats`** | **Real (T-092)** | **`hphe-vec` (usearch HNSW)** | Reports discovered collections (`name`, `dim`, `size`, `backend: "usearch"`) |
| **`hybrid_search`** | **Real (T-092)** | **Multi-Modal Hybrid Engine** | Merges `everything_search` (filenames) + `content_search` (BM25) + `vec_search` (vectors) with path deduplication and normalized ranking |
| `memory_*` | Stub (V1) | In-Process Stub | Memory tools reserved for P5/agentmemory rusqlite unification |

---

## 3. Configuration & Lazy Loading

### Directory Resolution
- **Content Index**: Configured via `HPHE_CONTENT_DIR`. Default: `data/content-index` relative to binary or current working directory.
- **Vector Collections**: Configured via `HPHE_VEC_DIR`. Default: `migrated-vec/` or `data/vec`.

### Cold Start & Resource Management
1. **Lazy Initialization**: Neither Tantivy nor usearch indexes are loaded at server startup. Server cold start remains under 8 ms.
2. **Read-Only Concurrency**: Content search uses `ContentIndex::open_read_only` to prevent Tantivy directory write-lock contention with ingest workers or daemons.
3. **In-Memory Collection Caching**: Once opened, vector collections and content readers are cached in thread-safe memory caches for sub-millisecond query responses.
4. **Resilience**: If indexes or collections are absent, tools return clean, non-crashing structured JSON responses (`{ "status": "index_absent" }`).

---

## 4. Benchmark Measurements: stdio JSON-RPC Subprocess Latency

Measured across 50 iterations over standard I/O JSON-RPC subprocess invocation (Release build):

| Tool Invocation | min (ms) | p50 (ms) | avg (ms) | p95 (ms) | p99 (ms) | Status |
|---|---|---|---|---|---|---|
| `everything_search` | 0.091 | 0.095 | 0.100 | 0.111 | 0.255 | PASS |
| `everything_index_stats` | 0.082 | 0.088 | 0.090 | 0.104 | 0.124 | PASS |
| `hphe_health` | 0.086 | 0.090 | 0.092 | 0.105 | 0.121 | PASS |
| `resolve_path` | 0.078 | 0.084 | 0.085 | 0.096 | 0.109 | PASS |
| `fs_get_info` | 0.143 | 0.149 | 0.154 | 0.181 | 0.189 | PASS |
| `fs_read_file` | 0.172 | 0.182 | 0.186 | 0.206 | 0.232 | PASS |
| **`content_search`** | 0.095 | **0.111** | 0.113 | 0.137 | 0.150 | PASS |
| **`vec_search`** | 0.129 | **0.132** | 0.137 | 0.158 | 0.164 | PASS |
| **`semantic_search`** | 0.131 | **0.136** | 0.142 | 0.170 | 0.187 | PASS |
| **`vec_stats`** | 0.124 | **0.128** | 0.131 | 0.156 | 0.161 | PASS |
| **`hybrid_search`** | 0.144 | **0.149** | 0.151 | 0.171 | 0.172 | PASS |

---

## 5. Verification & Test Suite

All tests pass 100% green:
- `cargo test -p hphe-mcp`: 21 passed (4 unit, 8 e2e, 4 roundtrip, 5 tools_v2).
- `cargo test --workspace`: 100% passed across all crates (`hphe-mft`, `hphe-index`, `hphe-query`, `hphe-usn`, `hphe-vec`, `hphe-content`, `hphe-daemon`, `hphe-ipc`, `hphe-mcp`).
- `python -m pytest tests/parity/test_tool_parity.py`: 18/18 reference tool parity tests pass.
- Release binary built cleanly: `hphe/target/release/hphe-mcp.exe`.
