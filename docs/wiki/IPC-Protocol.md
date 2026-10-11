# IPC Protocol (WM_COPYDATA / QUERY2)

Everything.exe exposes two IPC channels, both implemented in
`everything_ipc.py`:

1. **Control channel** — plain `SendMessageTimeoutW(hwnd, WM_USER, code, 0)`
   for version queries, DB status, rebuild/save. Cheap, synchronous.
2. **Query channel** — `WM_COPYDATA` with `dwData = 18`
   (`EVERYTHING_IPC_COPYDATA_QUERY2W`) carrying a QUERY2 request; Everything
   answers by sending `WM_COPYDATA` back to a reply window we own.

## Locating Everything

```python
h = user32.FindWindowW("EVERYTHING_TASKBAR_NOTIFICATION", None)
```

If no window exists, `EverythingError("Everything.exe is not running")` is
raised. This is the same window the official SDK targets.

## Control channel — WM_USER (EVERYTHING_WM_IPC)

`EverythingIPC.ipc_call(code, lparam=0)` sends
`SendMessageTimeoutW(ehwnd, WM_USER, code, lparam, SMTO_ABORTIFHUNG, 5000)`
and returns the `LRESULT` as int. Codes used:

| Code | Constant | Meaning |
|---|---|---|
| 0 | `IPC_GET_MAJOR_VERSION` | version components → `"maj.min.rev.build"` |
| 1 | `IPC_GET_MINOR_VERSION` | |
| 2 | `IPC_GET_REVISION` | |
| 3 | `IPC_GET_BUILD_NUMBER` | |
| 5 | `IPC_GET_TARGET_MACHINE` | (defined, unused) |
| 401 | `IPC_IS_DB_LOADED` | db loaded flag |
| 402 | `IPC_IS_DB_BUSY` | db busy flag |
| 403 | `IPC_IS_ADMIN` | Everything running elevated |
| 405 | `IPC_REBUILD_DB` | trigger full index rebuild |
| 407 | `IPC_SAVE_DB` | persist db to disk |

`status()` aggregates version + db_loaded + db_busy + everything_is_admin.

## Query channel — QUERY2 request

Built in `EverythingIPC.query()` (`everything_ipc.py:227`). The payload is a
28-byte header (7 little-endian DWORDs) followed by the search string in
UTF-16LE, NUL-terminated:

```python
text = search.encode("utf-16-le") + b"\x00\x00"
qsize = 28 + len(text)
struct.pack("<7I",
    int(self._hwnd),   # reply_hwnd  — our hidden message-only window
    self._reply_id,    # reply_id    — echoed back in COPYDATASTRUCT.dwData
    search_flags,      # see flags below
    offset,            # first result index
    max_results,       # max items (ALLRESULTS = 0xFFFFFFFF = all)
    request_flags,     # which fields to return
    sort_type)         # sort column + direction
```

Wrapped in `COPYDATASTRUCT(dwData=18, cbData=qsize, lpData=buf)` and sent
with `SendMessageTimeoutW(..., WM_COPYDATA, self._hwnd, &cds,
SMTO_ABORTIFHUNG, timeout_ms)`. `wParam` is our reply HWND.

### search_flags (query semantics)

| Flag | Value | Meaning |
|---|---|---|
| `MATCHCASE` | 0x01 | case-sensitive |
| `MATCHWHOLEWORD` | 0x02 | whole word |
| `MATCHPATH` | 0x04 | match terms against full path (set by `matchpath:` token — see [[Query-Syntax]]) |
| `REGEX` | 0x08 | regex query |
| `MATCHACCENTS` | 0x10 | accent-sensitive |
| `MATCHPREFIX` | 0x40 | prefix match |
| `MATCHSUFFIX` | 0x80 | suffix match |

Note: Everything's native `regex:`, `case:` etc. *query modifiers* are
handled by Everything itself inside the search string — these flags are only
needed for modifiers that have no inline syntax (`matchpath:`).

### request_flags (fields per result item)

| Flag | Value | Field |
|---|---|---|
| `REQ_NAME` | 0x01 | file name |
| `REQ_PATH` | 0x02 | directory path |
| `REQ_FULL_PATH_AND_NAME` | 0x04 | combined full path |
| `REQ_EXTENSION` | 0x08 | extension |
| `REQ_SIZE` | 0x10 | int64 bytes |
| `REQ_DATE_CREATED` | 0x20 | FILETIME |
| `REQ_DATE_MODIFIED` | 0x40 | FILETIME |
| `REQ_DATE_ACCESSED` | 0x80 | FILETIME |
| `REQ_ATTRIBUTES` | 0x100 | DWORD attributes |

`search()` always uses `_DEFAULT_REQ = REQ_FULL_PATH_AND_NAME | REQ_SIZE |
REQ_DATE_MODIFIED | REQ_ATTRIBUTES`. `count()` uses `REQ_NAME` with
`max_results=1` and reads only `total`.

### sort_type

`SORT` maps names to Everything sort constants; **descending = base + 1**:

| Name | Code | Name | Code |
|---|---|---|---|
| name | 1 | date_modified / date | 13 |
| path | 3 | attributes | 15 |
| size | 5 | run_count | 19 |
| ext / extension | 7 | date_recently_changed | 21 |
| date_created | 11 | date_accessed | 23 |

The `everything_search` tool enum exposes a subset: `name`, `path`, `ext`,
`date`, `size`. The other constants are usable via `everything_ipc` directly.

## LIST2 reply (parsing)

`_parse()` (`everything_ipc.py:265`) reads:

```
header: <5I  →  total, num_items, offset, request_flags, sort_type   (20 bytes)
per item: <2I →  item_flags, data_offset                             (8 bytes)
          item_flags bit 0 = folder
then at data_offset, fields in REQ_* bit order:
  strings: <I char_count, UTF-16LE chars, NUL
  size/dates: <q (int64; dates are FILETIME)
  attributes: <I
```

FILETIME → epoch conversion: `(ft - 11644473600000000) / 10_000_000`
(1601 → 1970 delta in 100 ns units).

`total` is the full match count regardless of `max_results`, which is what
`everything_count` uses.

## The hidden reply window

Because Everything answers asynchronously via `WM_COPYDATA`, the client must
own a window. `EverythingIPC` creates, on a dedicated daemon thread:

- window class `"EverythingMcpIpc"` (`RegisterClassW`; error 1410
  `ERROR_CLASS_ALREADY_EXISTS` is tolerated)
- a **message-only** window (`parent = HWND_MESSAGE = -3`) — invisible, gets
  only messages
- a `GetMessageW`/`TranslateMessage`/`DispatchMessageW` loop

The WNDPROC inspects `WM_COPYDATA`: when `COPYDATASTRUCT.dwData ==
self._reply_id` it copies `cbData` bytes out of `lpData`
(`ctypes.string_at`) and sets `_reply_event`. Anything else falls through to
`DefWindowProcW`.

`_reply_id` cycles `1 .. 0x7FFFFFFF` so a stale late reply can never be
mistaken for the current query's data.

## Serialization and timeouts

- `_query_lock` serializes all queries on the singleton — Everything would
  cancel a pending query from the same reply window anyway.
- Window creation readiness: `_ready.wait(10)` s.
- `SendMessageTimeoutW` on the query send: `self._timeout` (default **15 s**)
  with `SMTO_ABORTIFHUNG`.
- Reply wait: `_reply_event.wait(self._timeout)` — raises
  `EverythingError("timed out waiting for Everything reply")`.
- Control channel: fixed 5 s with `SMTO_ABORTIFHUNG`.

A timeout is possible on very large replies (thousands of rows ×
path+size+date payload over `WM_COPYDATA`). Mitigate with `max_results`
paging rather than huge single requests.
