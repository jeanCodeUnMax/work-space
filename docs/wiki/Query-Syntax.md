# Query Syntax

The `query` argument of `everything_search` / `everything_count` is passed
**almost verbatim** to Everything.exe — the full native Everything search
syntax is available. Everything interprets the string; the server does not
parse or rewrite it, with exactly one exception (`matchpath:`, below).

## Operators and modifiers

| Syntax | Meaning |
|---|---|
| `*` `?` | wildcards (`*` = any run, `?` = single char) |
| `a|b` | OR |
| `!term` | NOT |
| space | implicit AND |
| `ext:py;txt` | extension list (`;`-separated) |
| `size:>10mb` | size filter (`<` `>` ranges, kb/mb/gb units) |
| `dm:today` | date-modified (`dm:` also takes `yesterday`, `thisweek`, `2024`, `>2024-01-01`, …); `dc:`/`da:` for created/accessed |
| `path:X:\dir` | path contains |
| `parent:X:\dir` | direct-parent directory |
| `regex:...` | treat the remainder as a regular expression |
| `case:foo` | case-sensitive term |
| `ww:foo` | whole-word term |
| `startwith:` `endwith:` | name prefix / suffix |
| `folder:` | directories only |
| `file:` | files only |
| `audio:` `video:` `document:` `executable:` `picture:` `compressed:` | built-in categories (extension sets — see `categories.py`; `everything_categories` lists them) |

Examples:

```
dots folder:                      # folders named *dots*
*.log dm:today size:>1mb          # today's large logs
ext:py|ext:ps1 path:/servers/     # python or powershell under /servers
!node_modules *.json              # json files outside node_modules
regex:^report-\d{4}\.xlsx$        # regex match
report document:                  # docs named *report*
```

## `matchpath:` — the only translation

`matchpath:` has no native Everything modifier; `server.py` translates it
into the `MATCHPATH` search flag (0x04, match terms against the full path
instead of the name only):

```python
def _translate_query(query):
    flags = 0
    out = []
    for tok in query.split():
        low = tok.lower()
        if low in ("matchpath:", "matchpath"):
            flags |= everything_ipc.MATCHPATH
        else:
            out.append(tok)
    return " ".join(out), flags
```

Notes:

- Only the bare tokens `matchpath:` / `matchpath` are recognized — a
  `matchpath:value` form would be passed through as a literal term, not
  translated. Use `path:` / `parent:` for path-scoped queries instead.
- The flag applies to the whole query, not a single term.

## Case / encoding

The query is encoded UTF-16LE and sent in the QUERY2 payload, so accented,
CJK and emoji filenames work end-to-end (the stdio channel is forced to
UTF-8 for the same reason). By default matching is case-insensitive;
`case:` (or the `MATCHCASE` flag) switches to sensitive.

## Sorting and paging

Sorting is server-side in Everything, not by the MCP server — `sort` maps to
IPC sort constants (`name` `path` `ext` `date` `size`, `descending` adds 1
to the constant — Everything encodes direction as base+1). `offset` + `max_results` page through the ordered
result set; `total` in the response is always the full match count, so
clients can loop `offset += max_results` until they've seen `total` rows
(cap: 10,000 rows per call).
