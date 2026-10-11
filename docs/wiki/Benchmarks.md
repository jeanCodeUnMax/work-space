# Benchmarks

Measured on the dev machine (Windows, ~15.8 M indexed entries across four
NTFS volumes, Everything service running). Numbers are single-run figures —
expect variance; they are here to show orders of magnitude, not precision.

## Headline comparison

| | everything-search MCP | official `filesystem` MCP (`search_files`) |
|---|---|---|
| Backend | live Everything index via IPC | recursive `os.scandir` / Node traversal |
| Traversal rate | n/a (index lookup, not traversal) | ~2,000 entries/s |
| Whole-PC `dots` query | **1,328 hits in ~4.7 s** | **`C:/` alone did not finish in 15+ min** |

The filesystem server never completed a `C:/` scan in testing (killed after
15 minutes) — at ~2,000 entries/s, a multi-million-entry volume is simply
not walkable in interactive time. Everything answers the same question from
its resident index.

## Per-drive breakdown — `dots` query

`everything_search` with `path:X:` scoping per drive, plus the fs-side
traversal for comparison:

| Drive | everything_search | fs traversal (`fs_search_files`-equivalent) |
|---|---|---|
| `C:` | 361 hits / **422 ms** | did not finish (15+ min whole-scan) |
| `D:` | 36 hits / **1.5 s** | seconds–minutes depending on tree |
| `E:` | 317 hits / **3.5 s** | |
| `F:` | 597 hits / **14.6 s** | |
| All | 1,328 hits / **~4.7 s** | — |

Notes:

- The per-drive totals (1,311) plus scattered hits elsewhere make the 1,328
  whole-PC figure.
- `F:` dominates the wall time — nearly half the matches ride the slowest
  spindle; Everything still returns them in one ordered set.
- Latency is **result-payload-bound**, not index-bound: the index lookup
  itself is ms; most of the ~4.7 s is `WM_COPYDATA` transfer + parse of the
  1,328-row reply. Small queries (`dots folder:` → 35 hits) return in a few
  hundred ms warm.

## When each backend wins

**Use `everything_search` when:**

- The target is on a local NTFS volume (Everything indexes all of them).
- You need name/path/extension/date/size matching — anything Everything's
  query syntax expresses.
- The tree is large: index lookup is O(result set), traversal is O(volume).

**Use `fs_search_files` (traversal) when:**

- The location is **off-index**: network shares, FAT32/exFAT volumes,
  folders excluded in Everything's options, ReFS.
- You need exact partial-name parity with the reference filesystem MCP
  (`fs_search_files` is a substring match on the base name; `everything_*`
  interprets Everything syntax, where e.g. `a|b` means OR).
- The search root is small and shallow — a few thousand entries walks
  faster than an IPC round trip plus policy filtering.

**Either way:** `fs_*` read/write/stat tools and `everything_*` share the
same `.mcp-access` + `EVERYTHING_MCP_ROOTS` enforcement, so choosing the
fast backend never weakens the policy.

## Practical limits observed

- `max_results` is capped at 10,000. Replies in the multi-thousand-row range
  can approach the 15 s IPC reply timeout — page with `offset` instead of
  requesting everything at once.
- `db_busy` in `everything_index_stats` goes true while Everything is
  applying USN deltas; queries still answer, occasionally slower.
