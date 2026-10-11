# Security

Two independent layers gate filesystem access, plus a hard transport rule.

```
tool call
  └─► _check(path, write)
        ├─► EVERYTHING_MCP_ROOTS allowlist   (coarse, env-set)
        └─► .mcp-access profile rules        (fine-grained, per agent)
```

`everything_search` results are additionally post-filtered by the same
`.mcp-access` engine (denied rows are dropped from `results`; the count is
reported in `filtered_by_policy`).

## Layer 1 — `.mcp-access` policy file

Gitignore-style rules at `C:\Program Files\servers\everything-mcp\.mcp-access`
(override path: env `EVERYTHING_MCP_ACCESS_FILE`). Parsed once and cached by
`fs_tools._load_policy()`.

### Profiles

Sections `[name]` (or `[profile:name]`) define rule lists. The active
profile is the `EVERYTHING_MCP_AGENT` env var, which each client sets in
**its own MCP server config** — i.e. the agent cannot self-select a weaker
name, the profile is bound at spawn time:

```json
"everything-search": {
  "command": "python",
  "args": ["-u", "C:/Program Files/servers/everything-mcp/server.py"],
  "env": { "EVERYTHING_MCP_AGENT": "external" }
}
```

Missing or empty `EVERYTHING_MCP_AGENT` → profile `default`.

### Rule syntax

```
<action>:<glob-pattern>     # one per line, # comments allowed
```

Patterns are matched with `fnmatch.fnmatchcase` against the path normalized
to absolute, forward-slash, **lowercase** — so write patterns lowercase too
(`F:/dir/**`, `**/.env*`).

| Action | Grants |
|---|---|
| `allow:` | read **and** write |
| `read:` | read only (read/list/info/tree/multi-read/search results) |
| `write:` | read + write (same effect as `allow:`) |
| `deny-write:` | blocks write tools only (`fs_write_file`, `fs_edit_file`, `fs_create_directory`, `fs_move`, `fs_delete`) |
| `deny:` | blocks everything |

### Evaluation — last match wins

```python
grant = False
for action, pat in rules:
    if not fnmatch.fnmatchcase(np, pat): continue
    if   action == "deny":       grant = False
    elif action == "deny-write": grant = False if write else grant
    elif action == "read":       grant = True  if not write else grant
    elif action in ("write","allow"): grant = True
```

Order matters: later rules override earlier ones, so the shipped
`[external]` profile grants broad subtrees first and ends with
`deny-write: **`. Caveats:

- **A profile with no matching rules is unrestricted** — `path_allowed`
  returns `True` when the profile has no rules at all (`if not rules:
  return True`). This is a *fail-open* design: a typo'd
  `EVERYTHING_MCP_AGENT` name silently gets full access. Define profiles
  explicitly and treat `default` as trusted-local only.
- A profile *with* rules is effectively whitelist: `grant` starts `False`,
  so nothing is accessible unless a rule grants it.

### Shipped profiles (`.mcp-access`)

```ini
[default]
allow: **                      # local trusted agents (Devin, Antigravity)

[external]                     # used by mcp-mux for external agents
read: F:/Promgramation-teste/**
read: C:/Program Files/servers/**
read: C:/Users/Administrator/Desktop/**
deny: **/.ssh/**  **/.gnupg/**  **/.aws/**  **/.azure/**
deny: **/.env  **/.env.**  **/*.pem  **/*.key  **/*credential*
deny: **/id_rsa*  **/token*.json  **/secrets.*
deny: C:/Users/Administrator/AppData/**
deny: C:/Program Files/Everything/**
deny-write: **                 # never any write
```

The `deny:` patterns are placed after the `read:` grants, so a secret inside
a granted tree is still refused (last-match-wins).

## Layer 2 — `EVERYTHING_MCP_ROOTS`

`;`-separated env allowlist applied to every `fs_*` call **before** the
`.mcp-access` rules (`fs_tools._check`). Empty/unset = unrestricted. Paths
must equal a root or be inside it (`normcase` + prefix comparison). Denial
raises `PermissionError("path outside allowed roots")`. Inspect the active
config with `fs_list_allowed_roots`.

Both layers must pass: ROOTS narrows the universe, `.mcp-access` refines it
per agent.

## Result filtering

`everything_search` drops rows failing `path_allowed` and reports
`filtered_by_policy: <n>` (null when 0). `fs_list_directory`,
`fs_directory_tree` and `fs_search_files` skip denied entries silently.
`total` in a search response is the pre-filter count — do not treat it as
the number of accessible rows under a restricted profile.

## Transport rule — stdio only, no ports

The server opens **no network port**, by design and permanently: all I/O is
NDJSON JSON-RPC on stdin/stdout. Do not add a listening socket. If a network
transport ever becomes necessary (remote extension), bind `127.0.0.1` and
require a token — documented constraint in `docs/GUIDE.md`.
