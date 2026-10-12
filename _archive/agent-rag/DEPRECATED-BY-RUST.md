# ⚠️ Pipeline Python RAG — REMPLACÉE par le backend Rust unifié

**Ne plus utiliser `cli.py` / `pipeline.py` pour l'ingestion.** Toute la
chaîne est absorbée par `hphe-kit` (crate Rust) exposée via `hphe-mcp`
(57 outils) et `hphe-rest` (HTTP 127.0.0.1:8792).

| Ancien (Python)                    | Nouveau (Rust)                                         |
|------------------------------------|--------------------------------------------------------|
| `cli.py ingest <path>`             | `hphe-mcp.exe --tool hephaistos_update --args '{...}'`   |
| `pipeline.py` walk + .ragignore    | `hphe_kit::ingest::ingest_workspace` (même sémantique)   |
| `chunker.py`                       | `ingest.rs::chunk_text` (~1800 chars, bords de lignes)   |
| `embedder.py` (NIM 2048D)          | `hphe_kit::nim::embed_texts` — tool `nim_embed`          |
| `router.py` → qdrant/zvec          | `hphe-vec` (usearch embarqué) — tool `vec_search`        |
| `fusion.py` (RRF BM25+vec)         | tool `hybrid_search`                                    |
| index plein-texte (absent !)       | `hphe-content` Tantivy — tool `content_search`           |
| écriture KG memory_mcp.db          | `ingest.rs::mirror_kg` (mêmes tables/relations)          |
| `rag_rest_bridge.py` (ports 8001/2)| `hphe-rest.exe` (un seul port, 57 outils)               |
| `ingest-workspace.ps1` (931 lignes)| wrapper 69 lignes → même binaire                         |

Conservé pour rollback uniquement. La pipeline avait des erreurs connues :
input >65536 chars NIM, payload >32MB Qdrant, batch zvec — le backend Rust
borne à 32 textes/appel et écrit en local, sans serveur externe.
