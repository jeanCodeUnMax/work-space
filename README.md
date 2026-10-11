# everything-search MCP

MCP server that gives an AI agent Everything-class search speed over the whole
PC, plus merged filesystem tools. No external dependencies: Python 3 stdlib +
ctypes only.

## Architecture

Thin client over the running **Everything.exe**: queries go through the official
`WM_COPYDATA` IPC protocol (`QUERY2`), the same channel the Everything GUI and
SDK use. The Everything service keeps its NTFS index live at all times — this
server maintains **no local index**, performs **no MFT enumeration**, and needs
**no admin rights**.

- `everything_ipc.py` — ctypes implementation of the IPC protocol: locates the
  Everything IPC window, builds `QUERY2` requests, receives results on a hidden
  reply window, parses name/path/size/date/attributes.
- `server.py` — MCP stdio JSON-RPC server exposing the tools below.

Search latency is tens of milliseconds for typical queries (~30–400 ms);
large result sets (>1000 paths returned) cost seconds as the whole payload
travels over WM_COPYDATA — same order as the Everything GUI itself.

## Tools

| Tool | Purpose |
|---|---|
| `everything_search` | Native Everything query syntax (wildcards, `ext:`, `path:`, `size:`, `dm:`, categories, `regex:`, `case:`, `folder:`, `file:`, `!`, `\|`, `startwith:`, `endwith:`, `ww:`, `matchpath:`) |
| `everything_count` | Count matches |
| `everything_categories` | List category extension maps |
| `everything_index_stats` | Everything service status: version, db loaded/busy, total entries |
| `everything_refresh` | Save Everything's db (default) or trigger a full rebuild (`full=true`) |
| `everything_open_gui` | Launch `Everything.exe -s <query>` in the GUI |
| `fs_read_file` `fs_read_multiple_files` `fs_list_directory` `fs_get_info` `fs_directory_tree` | Filesystem reads |
| `fs_write_file` `fs_edit_file` `fs_create_directory` `fs_move` `fs_delete` | Filesystem writes |
| `fs_search_files` `fs_list_allowed_roots` | Traversal search (slow fallback) + allowlist |

## Configuration (env)

- `EVERYTHING_EXE` — path to Everything.exe (default `C:\Program Files\Everything\Everything.exe`)

## Access control

`.mcp-access` (gitignore-style) assigns per-agent profiles selected via the
`EVERYTHING_MCP_AGENT` env var in each client's MCP config. Missing var =
`[default]` profile (unrestricted — local trusted agents). The `[external]`
profile (used by mcp-mux) grants bounded read-only access with secrets and
system paths denied. See `docs/GUIDE.md` for the rule syntax.

Transport is **stdio only — the server opens no network port**, by design.

## Requirements

- Windows, Everything.exe running (the Everything service maintains the index)
- No administrator rights needed for search

## Legacy

The `_obsolete/` folder keeps the previous architecture (Python MFT/USN
enumeration into a SQLite index) for reference only — it is no longer used.
