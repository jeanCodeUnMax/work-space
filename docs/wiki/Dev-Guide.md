# Dev Guide

## Dev setup

Requirements: Windows, Python 3.11+, Everything.exe running. No pip
dependencies — stdlib + ctypes only.

```bash
git clone https://github.com/projet-temporaire/everything-mcp.git
cd everything-mcp
python server.py        # starts the stdio server, waits on stdin
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `EVERYTHING_EXE` | `C:\Program Files\Everything\Everything.exe` | used by `everything_open_gui` |
| `EVERYTHING_MCP_AGENT` | `default` | active `.mcp-access` profile |
| `EVERYTHING_MCP_ROOTS` | *(empty = unrestricted)* | `;`-separated fs_* allowlist |
| `EVERYTHING_MCP_ACCESS_FILE` | `<repo>/.mcp-access` | policy file location |

## Run standalone / manual JSON-RPC

The server speaks NDJSON JSON-RPC on stdin — one message per line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"everything_search","arguments":{"query":"dots folder:","max_results":5}}}
```

Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list` (empty), `prompts/list` (empty), `shutdown`/`exit`.
Notifications (`notifications/*`) are ignored; malformed lines are skipped.

## Smoke tests (pre-merge checklist)

From `docs/ORGANISATION.md`:

1. **IPC smoke** — `python -c "import everything_ipc; print(everything_ipc.search('test'))"`
2. **Server smoke** — run the JSON-RPC sequence `initialize` → `tools/list`
   → `tools/call everything_search` above.
3. Verify a known path is found and the query answers in <1 s.

Quick status check:

```bash
python -c "import everything_ipc; ipc=everything_ipc.EverythingIPC.get(); print(ipc.status()); print('total:', everything_ipc.count(''))"
```

## Git workflow

Remote: `https://github.com/projet-temporaire/everything-mcp.git`

| Branch | Role | Protected |
|---|---|---|
| `main` | stable, deployable | yes — merges only |
| `dev` | working branch | no |

Rules (`docs/ORGANISATION.md`):

- Work on `dev` (default development branch).
- `main` receives merges from `dev` only when stable and smoke-tested.
- Larger features: `feat/<name>` off `dev`, merge back with `--no-ff`.
- Urgent hotfix: `fix/<name>` off `main`, merge to `main` + back-merge/cherry-pick into `dev`.

```bash
git checkout -b feat/my-feature dev
# ... commits ...
git checkout dev && git merge --no-ff feat/my-feature
```

### Commit convention

`type(scope): message` — `feat` `fix` `chore` `docs` `refactor` `test`
`perf`; one commit = one thing. History so far is in French
(`feat(security): controle d'acces par agent via .mcp-access`,
`feat(fs): parite complete avec le serveur filesystem officiel`,
`chore: initial commit — serveur MCP everything-search sur IPC natif`) —
match the existing style.

## Project status / roadmap

Current organisation is intentionally minimal: flat single-purpose modules,
no packaging, no CI, no pytest suite. Planned evolutions if the project
grows (`docs/ORGANISATION.md`): `pyproject.toml` packaging, `tests/` pytest,
CI syntax check + smoke.

### VS Code extension (VSIX) — in progress

Next step: an in-IDE Everything-style search dashboard
(`extension/everything-search/`), design inspired by
`Hephaistos-Kit/extensions/orchestrator-monitor` (TS `src/` → `out/`,
webview `media/`, build `npx tsc && npx @vscode/vsce package`).

The integration contract is already satisfied — the server is a standard
stdio MCP: the extension spawns `python server.py`, keeps a long-lived
JSON-RPC client, calls `everything_search` / `fs_*`. No `snapshot`/`ws-bridge`
style bridge needed (nothing to poll; queries are synchronous and ms-fast).

Planned layout:

```
extension/everything-search/
├── package.json        # contributes: views/webview, commands, activation
├── tsconfig.json
├── src/
│   ├── extension.ts    # activation, spawn server.py, MCP stdio client
│   ├── mcpClient.ts    # line-based JSON-RPC (initialize, tools/call)
│   └── searchView.ts   # webview provider: input + virtualized results
├── media/
│   ├── panel.js        # search UI (field, list, column sorting)
│   └── panel.css
└── out/                # tsc output
```

Webview → workspace drag & drop via `text/uri-list` on result items (native
VS Code drop into editor/explorer). Manual UI search and agent MCP calls
share the same Everything backend.

## Housekeeping notes

- `__pycache__/`, `.agent/`, `.vscode/`, `*.code-workspace`,
  `memory-database` (symlink), `*.db`/`*.sqlite`, logs and secrets are
  gitignored — don't commit them.
- `_obsolete/` is reference-only; nothing may import from it.
- Coding constraint to preserve: **no listening sockets** — see
  [[Security]].
