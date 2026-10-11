# Guide local — everything-search MCP

Client MCP stdio ultra-léger sur l'index vivant d'Everything.exe.
Zéro dépendance : Python 3.11+ stdlib + ctypes.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.py` | Serveur MCP (boucle JSON-RPC NDJSON, registry des outils) |
| `everything_ipc.py` | Client IPC natif : `WM_COPYDATA` / `QUERY2` vers Everything.exe |
| `categories.py` | Catégories de filtres (audio:, video:, document:…) |
| `fs_tools.py` | Outils filesystem (read/list/info/write/move/delete) |
| `_obsolete/` | Ancienne archi MFT/SQLite — référence historique, ne pas importer |

## Prérequis

- Windows, Everything.exe qui tourne (son service maintient l'index)
- Aucun droit admin requis pour la recherche

## Lancer en standalone

```bash
python server.py
```

Puis envoyer du JSON-RPC une ligne à la fois sur stdin :

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"everything_search","arguments":{"query":"dots folder:","max_results":5}}}
```

## Test rapide sans serveur

```bash
python -c "import everything_ipc, time; t=time.time(); print(everything_ipc.search('dots folder:')['total'], (time.time()-t)*1000,'ms')"
```

## Config Devin

`%APPDATA%\devin\mcp_config.json` :

```json
"everything-search": {
  "command": "python",
  "args": ["-u", "C:/Program Files/servers/everything-mcp/server.py"],
  "env": { "EVERYTHING_EXE": "C:/Program Files/Everything/Everything.exe" }
}
```

## Syntaxe de requête

La chaîne `query` est passée quasi brute à Everything — syntaxe native complète :
wildcards `*` `?`, `a|b` (OR), `!` (NOT), `ext:py;txt`, `size:>10mb`, `dm:today`,
`path:`, `parent:`, `regex:`, `case:`, `ww:`, `startwith:`, `endwith:`,
`folder:`, `file:`, catégories `audio:` `video:` `document:` `executable:`
`picture:` `compressed:`.

Seul `matchpath:` n'est pas natif : il est traduit en flag de recherche MATCHPATH.

## Outils MCP

`everything_search` (query, max_results, offset, sort, descending),
`everything_count`, `everything_categories`, `everything_index_stats`,
`everything_refresh` (save_db / rebuild si `full=true`), `everything_open_gui`.

Filesystem (parité complète avec le serveur `filesystem` officiel) :
`fs_read_file`, `fs_read_multiple_files`, `fs_list_directory`, `fs_get_info`,
`fs_directory_tree`, `fs_write_file`, `fs_edit_file` (diff git-style + dryRun),
`fs_create_directory`, `fs_move`, `fs_delete`, `fs_search_files` (traversal —
lent, fallback hors-index), `fs_list_allowed_roots`.

Sécurité : `EVERYTHING_MCP_ROOTS` (env, `;`-séparé) restreint les outils fs_*
à une whitelist de répertoires — vide = sans restriction.
