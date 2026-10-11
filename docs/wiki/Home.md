# everything-search MCP — Wiki

**everything-search** is a stdio MCP server that gives an AI agent
Everything-class search speed over the whole PC, plus a merged set of
filesystem tools. It is a *thin client*: it maintains no index of its own.
Queries are forwarded to the running **Everything.exe** through the official
`WM_COPYDATA` / `QUERY2` IPC protocol — the same channel the Everything GUI
and the Everything SDK use. The Everything service keeps its NTFS index live
at all times, so this server never enumerates the MFT, never rebuilds, and
needs no administrator rights.

Zero dependencies: Python 3.11+ stdlib + `ctypes` only.

## Key numbers

| Metric | Value |
|---|---|
| Indexed entries | ~15.8 M (15,862,251 measured via `everything_index_stats` on the dev machine) |
| Search latency | ~30–400 ms typical (identical index and speed to the Everything GUI) |
| Admin rights | none required for search |
| Local index | none — no SQLite, no MFT enumeration, no rebuilds |
| Transport | stdio only — the server opens **no network port** |
| Tools exposed | 18 (6 `everything_*` + 12 `fs_*`) |

## What it is for

- Instant whole-PC filename/path search for agents (`everything_search`,
  `everything_count`) using native Everything query syntax.
- Full filesystem tool parity with the official `filesystem` MCP server
  (`fs_*` tools) so a single server covers "find it + read it + edit it".
- Per-agent access control via the `.mcp-access` policy file and the
  `EVERYTHING_MCP_AGENT` / `EVERYTHING_MCP_ROOTS` environment variables.

## Requirements

- Windows, with **Everything.exe running** (the Everything service maintains
  the index). Located via `FindWindowW("EVERYTHING_TASKBAR_NOTIFICATION")`.
- Everything 1.4.1+ for the QUERY2 protocol.
- No administrator rights needed for search.

## Wiki pages

| Page | Content |
|---|---|
| [[Architecture]] | IPC flow, why the MFT/SQLite design was abandoned, file map |
| [[IPC-Protocol]] | QUERY2/LIST2 wire format, WM_COPYDATA mechanics, flags, timeouts |
| [[Tools-Reference]] | All 18 MCP tools with real input schemas and behaviors |
| [[Query-Syntax]] | Native Everything query syntax as passed through, `matchpath:` translation |
| [[Security]] | `.mcp-access` policy engine, profiles, `EVERYTHING_MCP_ROOTS`, stdio-only rule |
| [[Benchmarks]] | Measured comparison vs the official filesystem MCP |
| [[Dev-Guide]] | Git workflow, dev setup, smoke tests, VSIX extension roadmap |

## Repository layout (short)

```
everything-mcp/
├── server.py            # MCP stdio JSON-RPC server (entry point)
├── everything_ipc.py    # WM_COPYDATA / QUERY2 IPC client (ctypes)
├── categories.py        # filter category extension maps
├── fs_tools.py          # fs_* tools + .mcp-access policy engine
├── .mcp-access          # per-agent access rules
├── docs/                # GUIDE.md, ORGANISATION.md, wiki/
└── _obsolete/           # previous MFT/SQLite architecture (reference only)
```

See [[Architecture]] for the full file map and data flow.
