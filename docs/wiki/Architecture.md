# Architecture

The server is deliberately thin. All search work is delegated to the running
Everything.exe; the Python side only serializes requests, applies the access
policy, and formats MCP responses.

## Request flow

```
MCP client (Devin, mcp-mux, ...)
        │  stdin: NDJSON, one JSON-RPC message per line (UTF-8)
        ▼
server.py  ── main() loop ──► handle()
        │  tools/call → _HANDLERS[name](args)
        ├──► everything_* tools ──► everything_ipc.py
        │         │  EverythingIPC.get()  (singleton)
        │         │  query(): pack QUERY2 (7 DWORDs + UTF-16 search)
        │         ▼
        │    WM_COPYDATA ──► Everything.exe  (EVERYTHING_TASKBAR_NOTIFICATION window)
        │         │  Everything replies via WM_COPYDATA to our hidden
        │         │  message-only window (class "EverythingMcpIpc")
        │         ▼
        │    _parse() LIST2 → dict → filtered through .mcp-access policy
        ├──► fs_* tools ──► fs_tools.py (os.scandir / open / shutil,
        │                   every call gated by _check() → EVERYTHING_MCP_ROOTS
        │                   allowlist + .mcp-access profile rules)
        ▼
   stdout: JSON-RPC result (text content + structuredContent)
```

## Components

| File | Role |
|---|---|
| `server.py` | MCP stdio server. NDJSON JSON-RPC loop (`main()` → `handle()`), the `TOOLS` registry (18 schemas), handlers, `matchpath:` → `MATCHPATH` flag translation, policy filtering of `everything_search` results. |
| `everything_ipc.py` | IPC client. `EverythingIPC` singleton owns a hidden message-only window on a daemon thread; `query()` sends `WM_COPYDATA` QUERY2 requests and parses LIST2 replies; `ipc_call()` sends `WM_USER` control codes (version, db status, rebuild, save). |
| `fs_tools.py` | The 12 `fs_*` tools plus the `.mcp-access` policy engine (`path_allowed`, `_check`, `filter_paths`) and the `EVERYTHING_MCP_ROOTS` allowlist. |
| `categories.py` | `CATEGORIES` extension maps for `audio:` `video:` `document:` `executable:` `picture:` `compressed:` and `CATEGORY_ALIASES`. |
| `.mcp-access` | Per-agent access policy (gitignore-style). See [[Security]]. |
| `_obsolete/` | Previous architecture (see below). Not imported anywhere. |

## Threading model

`EverythingIPC` is a singleton (`EverythingIPC.get()`). Its `__init__` starts
a daemon thread (`everything-ipc`) that registers window class
`EverythingMcpIpc`, creates a `HWND_MESSAGE` (message-only) window, and runs
a standard `GetMessage`/`DispatchMessage` loop. All inbound `WM_COPYDATA`
replies are therefore marshalled onto that thread; the WNDPROC copies the
payload when `dwData` matches the current `reply_id` and sets
`_reply_event`.

Queries are serialized by `_query_lock` — required anyway because Everything
cancels a previous pending query issued from the same reply window.

## Why the MFT/SQLite architecture was abandoned

The first version of this project (kept under `_obsolete/` for reference)
built its own index:

- `_obsolete/ntfs_index.py` — read the NTFS USN journal via
  `FSCTL_ENUM_USN_DATA` / `FSCTL_READ_USN_JOURNAL` to enumerate ~14 M file
  records directly from the MFT, stored them in SQLite, and applied deltas
  from the journal.
- `_obsolete/build_index.py`, `query_parser.py`, `elevated_setup.ps1`,
  `register_task.ps1` — index builder, query layer, and the scheduled-task /
  elevation plumbing.

It was replaced because it had real costs the Everything service already
pays:

| Problem with self-built index | Consequence |
|---|---|
| Python-side MFT enumeration of ~14 M records | minutes to build, **GBs of RAM** resident |
| `FSCTL_*` USN journal ioctls | **admin rights required** (elevation scripts) |
| USN delta application racing the live volume | index freshness race conditions, rebuild churn |
| SQLite index to maintain and compact | extra on-disk state, corruption surface |

Everything.exe already keeps the same data live in RAM with a battle-tested
indexer. Querying it over IPC gives identical results and latency with none
of the maintenance burden: no admin, no DB file, no rebuild logic on our
side. A "rebuild" is now just an `IPC_REBUILD_DB` message to Everything.

## Error handling

- `EverythingError` (Everything not running / rejected query / reply
  timeout) and `PermissionError` (policy denials) are returned as MCP tool
  results with `isError: true`.
- Any other exception in a handler is caught and returned as
  `{"error": "<Type>: <msg>", "trace": <last 5 frames>}`.
- Unknown tool → JSON-RPC error `-32602`; unknown method → `-32601`.

## Transport

Stdio only — NDJSON JSON-RPC on stdin/stdout, one message per line. The
server opens **no network port** by design (see [[Security]]).
`sys.stdin`/`stdout`/`stderr` are reconfigured to UTF-8 because Windows
pipes default to cp1252 and would crash on non-ASCII paths.
