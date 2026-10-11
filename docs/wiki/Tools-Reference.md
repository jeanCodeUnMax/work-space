# Tools Reference

18 tools are registered in `server.py`'s `TOOLS` list and dispatched by
`_HANDLERS`. Schemas below are the real `inputSchema` definitions (server
version `2.0.0`). All tools return MCP results with both text `content` and
`structuredContent`; handler failures come back as `{"error": ...}` with
`isError: true`.

## everything_* tools (6)

### `everything_search`

Whole-index search through the live Everything index.
Annotations: `readOnlyHint`, `idempotentHint`, `openWorldHint`.

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Native Everything query syntax (see [[Query-Syntax]]). Empty = match all. |
| `max_results` | integer | 100 | Capped at **10,000** server-side. |
| `offset` | integer | 0 | Result paging. |
| `sort` | enum | `"name"` | `name` `path` `ext` `date` `size` (mapped to IPC sort constants; descending = +1). |
| `descending` | boolean | false | |
| `stat` | boolean | true | Compatibility no-op — size/mtime already come from the index. |
| `refresh` | boolean | true | Compatibility no-op — the index is always live. |

Response: `{total, offset, results[], filtered_by_policy, query,
elapsed_ms, backend:"everything-ipc"}`. Each result:
`{path, name, dir, size, mtime, attrs}`.
`filtered_by_policy` counts rows removed by `.mcp-access` (null when 0).
`total` is the pre-filter index count.

### `everything_count`

Count matches without returning rows. Sends `max_results=1` and reads
`total` from the LIST2 reply.

| Param | Type | Default |
|---|---|---|
| `query` | string | `""` |

Response: `{count, query}`.

### `everything_categories`

No parameters. Returns `{categories}` — the `CATEGORIES` extension maps from
`categories.py` (`audio`, `compressed`, `document`, `executable`,
`picture`, `video`). These match the categories Everything itself accepts
inline in queries.

### `everything_index_stats`

No parameters. Aggregates `EverythingIPC.status()` plus a full count:

```json
{"version": "...", "db_loaded": true, "db_busy": false,
 "everything_is_admin": false, "total": 15862251,
 "backend": "everything-ipc",
 "note": "index is maintained live by the Everything service; no local index, no rebuild, no admin required"}
```

### `everything_refresh`

| Param | Type | Default | Notes |
|---|---|---|---|
| `full` | boolean | false | `true` → `IPC_REBUILD_DB` (full rebuild, all volumes, done by Everything itself). `false` → `IPC_SAVE_DB` (persist current db). |
| `volume` | string | — | Compatibility no-op; rebuilds are always all volumes. |

Response `{mode: "full"|"none", stats, ...}`.

### `everything_open_gui`

| Param | Type | Default |
|---|---|---|
| `query` | string | `""` |

Launches `Everything.exe -s <query>` detached (`DETACHED_PROCESS`) so results
can be inspected in the GUI. Exe path from `EVERYTHING_EXE` env
(default `C:\Program Files\Everything\Everything.exe`); returns `{error}` if
the exe doesn't exist.

## fs_* tools (12)

Parity with the official `filesystem` MCP server, plus policy checks — every
call goes through `_check()` (EVERYTHING_MCP_ROOTS + `.mcp-access`, see
[[Security]]). Paths >260 chars are supported via the `\\?\` prefix.

### `fs_read_file`

`path` (required), `max_bytes` (default 1 MiB), `encoding` (default utf-8).
Returns `{path, size, truncated, binary, content}`; undecodable content is
returned with `binary: true` and utf-8/replace text.

### `fs_read_multiple_files`

`paths` (required array), `max_bytes`, `encoding`. Per-file failures don't
abort the batch: `{files: [...], errors: {path: msg}}`.

### `fs_list_directory`

`path` (required), `max_entries` (default 1000).
`{path, truncated, entries: [{name, dir, size, mtime}]}` — entries denied by
policy are silently skipped.

### `fs_get_info`

`path` (required). `{path, exists, dir, size, mtime, ctime, atime,
readonly, attributes}` (`attributes` = `st_file_attributes` as octal).

### `fs_directory_tree`

`path` (required), `max_depth` (default **8**), `max_entries` (default
**10,000**). Recursive JSON `{tree, entries, max_depth, max_entries}`; nodes
are `{name, type: "file"|"directory", children[], truncated?}`. Bounds are
hard: a node at `max_depth` or hitting the global `max_entries` counter is
marked `truncated: true`. Entries are sorted dirs-first, then name
(case-insensitive); policy-denied children are skipped; symlinks are not
followed.

### `fs_write_file`

`path`, `content` (required), `encoding`, `append` (default false).
Creates parent directories. `{path, bytes_written, appended}`.

### `fs_edit_file`

`path`, `edits` (required), `dryRun`, `encoding`.
Each edit is `{oldText, newText}` and replaces the **first occurrence** of
`oldText`; a missing `oldText` raises `ValueError("edit #i: oldText not
found")` before anything is written. Returns a **git-style unified diff**
(`difflib.unified_diff`, `a/path` → `b/path`) in `{path, edits_applied,
dry_run, diff}`. `dryRun: true` (or `dry_run`) computes the diff without
writing — use it to preview edits.

### `fs_create_directory`

`path` (required). `os.makedirs(exist_ok=True)` — idempotent, parents
included.

### `fs_move`

`source`, `destination` (required), `overwrite` (default false). Both paths
are checked with `write=True`. Raises `FileExistsError` if destination
exists and `overwrite` is false.

### `fs_delete`

`path` (required), `recursive` (default false). File → `os.remove`; dir →
`os.rmdir` (must be empty) or `shutil.rmtree` when `recursive: true`.
Symlinks to dirs are treated as files.

### `fs_search_files`

`path`, `pattern` (required), `excludePatterns` (array of name globs),
`max_results` (default 1000).

**This is the slow fallback**: a live recursive `os.scandir` traversal doing
case-insensitive substring matching on names (~2,000 entries/s — see
[[Benchmarks]]). Use only for off-index locations (network drives, FAT32,
excluded folders) or exact partial-name parity; prefer `everything_search`
for anything on NTFS volumes. Returns `{path, pattern, matches, count,
truncated, scanned, elapsed_ms}`.

### `fs_list_allowed_roots`

No parameters. Diagnostics: `{allowed_roots, unrestricted, env_var, agent,
policy_file, policy_rules, restricted}` — shows the `EVERYTHING_MCP_ROOTS`
list, the active `.mcp-access` profile and how many rules it has.

## Notes on the registry

- `_fix_schemas()` moves `required` out of property definitions into the
  object schema at import time.
- `fs_edit_file` accepts both `dryRun` and `dry_run` keys.
- `everything_search` / `fs_search_files` / `fs_list_directory` /
  `fs_directory_tree` all apply `.mcp-access` filtering; only
  `everything_search` reports the count in `filtered_by_policy`.
