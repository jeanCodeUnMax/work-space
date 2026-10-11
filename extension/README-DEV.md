# everything-search-dev (DEVELOPMENT build)

Unpackaged VS Code extension: an Everything-style search sidebar powered by the
`everything-search` MCP server (`../server.py`, stdio NDJSON JSON-RPC over the
live Everything.exe index).

Plain JavaScript / CommonJS — no TypeScript, no build step, no npm deps
(vscode API + node builtins only). **This is a dev version: no `.vsix`.**

## How it works

- `extension.js` activates, creates an `McpClient` and registers a
  `WebviewViewProvider` (`everything-search.searchView`) in a new activity-bar
  container, plus the `everything-search.openSearch` command (Ctrl+Alt+F).
- `src/mcpClient.js` spawns `python -u <serverPath>` (cwd = server dir),
  speaks NDJSON JSON-RPC, performs `initialize` → `notifications/initialized`,
  maps request ids to pending promises, and lazily respawns on crash with
  exponential backoff. Logs go to the `everything-search` output channel.
- `src/searchView.js` renders `media/panel.{js,css}` in the webview and
  bridges postMessage traffic: `search`, `open`, `reveal`, `copyPath`,
  `openContaining`, `dragStart`.
- `media/panel.js` debounces input (150 ms), calls `everything_search`, and
  renders a Name | Path | Size | Modified table capped at ~500 rows.

The MCP server is spawned **without** `EVERYTHING_MCP_AGENT` — the extension is
a trusted local client and runs under the server's `[default]` (full access)
profile.

### Known server quirk: `mtime`

`everything_ipc.py` converts FILETIME with a 10x-too-small epoch delta, so
`mtime` on the wire is `unix_seconds + 10480026240` (~1.2e10), **not** unix
seconds. `media/panel.js` decodes this (plus raw FILETIME and plain unix s/ms
as fallbacks). If the server is fixed to emit real unix seconds the UI keeps
working automatically.

## Run it in dev mode

### Option A — Extension Development Host (recommended)

```bat
code --extensionDevelopmentPath="C:\Program Files\servers\everything-mcp\extension"
```

or for the Devin IDE / any code-fork binary:

```bat
devin --extensionDevelopmentPath="C:\Program Files\servers\everything-mcp\extension"
```

A new window opens with the extension loaded. Click the magnifier icon in the
activity bar (or Ctrl+Alt+F) and type to search.

### Option B — F5 from an extension host

Open this folder in VS Code and press F5 — `.vscode/launch.json` already
points `--extensionDevelopmentPath` at `${workspaceFolder}`.

### Option C — symlink into the extensions dir (persists across launches)

```bat
mklink /D "%USERPROFILE%\.devin\extensions\everything-search-dev" "C:\Program Files\servers\everything-mcp\extension"
```

(Use `%USERPROFILE%\.vscode\extensions\` for plain VS Code. Dev installs
loaded this way need a reload to pick up edits.)

### Editing

Everything is plain JS — edit, then `Developer: Reload Window` in the dev host.
The MCP server respawns automatically on the next query after a crash;
watch the **everything-search** output channel for spawn/stderr logs.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `everythingSearch.serverPath` | `C:/Program Files/servers/everything-mcp/server.py` | MCP server script |
| `everythingSearch.pythonPath` | `python` | Interpreter (must be Python 3.11+) |
| `everythingSearch.maxResults` | `500` | `max_results` per query |
| `everythingSearch.renderCap` | `500` | Max rows rendered |
| `everythingSearch.requestTimeoutMs` | `30000` | Per-request timeout |

## Packaging later

`vsce package` is intentionally **not** done here. When packaging, revisit the
manifest (add `publisher`, `icon`, `repository`, real `version`, drop `private`)
and bundle `media/`, `src/`, `extension.js`.
