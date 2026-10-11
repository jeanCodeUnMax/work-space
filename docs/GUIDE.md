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

Sécurité — deux couches :

1. `.mcp-access` (à la racine du projet) : politique par agent, style
   gitignore. Le profil actif = env `EVERYTHING_MCP_AGENT` (posée par la config
   MCP du client ; absente = `[default]` = accès total — Devin/Antigravity).
   Actions : `allow:` `read:` `write:` `deny-write:` `deny:` — dernier match
   gagne, patterns glob sur chemins forward-slash. Le profil `[external]`
   (mux) = lecture bornée (F:/Promgramation-teste, servers, Desktop), secrets
   et AppData refusés, écriture totalement interdite.
   Override du fichier : env `EVERYTHING_MCP_ACCESS_FILE`.
2. `EVERYTHING_MCP_ROOTS` (env, `;`-séparé) : allowlist brute additionnelle
   sur les fs_* — vide = sans restriction.

Les résultats de `everything_search` / `fs_search_files` / `fs_list_directory`
/ `fs_directory_tree` sont filtrés par la politique (champ
`filtered_by_policy` dans les réponses de recherche).

Transport : le serveur n'écoute sur **aucun port** — stdio uniquement. Ne
jamais ajouter de socket d'écoute ; si un transport réseau devient
nécessaire (extension distante), bind 127.0.0.1 + token obligatoires.

## Everything Search vs MCP filesystem officiel

Comparatif honnête avec `@modelcontextprotocol/server-filesystem` (le
serveur de référence, traversal récursif Node). Les deux peuvent cohabiter —
ce serveur embarque d'ailleurs les `fs_*` en parité pour couvrir les cas où
l'index ne suffit pas.

| Critère | everything-search (ce repo) | MCP `filesystem` officiel |
|---|---|---|
| **Backend de recherche** | Index live Everything via IPC `QUERY2` | Traversal récursif (`scandir`) à chaque appel |
| **Latence typique** | **< 50 ms**, quel que soit le volume | Secondes → inutilisable sur gros volumes (~2 000 entrées/s ; un scan de `C:/` ne termine pas en temps interactif) |
| **Syntaxe de recherche** | Langage Everything complet : wildcards, `a|b`, `!`, `ext:`, `size:`, `dm:`, `path:`, `regex:`, catégories… | Nom partiel / glob uniquement — pas de filtres taille/date/chemin natifs |
| **Couverture multi-drives** | Tous les volumes NTFS indexés d'un coup (`C:` `D:` `E:` `F:`…) | Borné par les répertoires autorisés et le temps de parcours |
| **Champs exploitables** | Nom, chemin complet, taille, mtime, attributs — tri natif par colonne | Nom essentiellement ; stat par fichier si nécessaire |
| **Outils fs (read/write/edit)** | Intégrés — parité complète, un seul serveur | Oui — c'est son cœur de métier |
| **Dépendances** | **Everything.exe requis** (installé + lancé, 1.4.1+) | Aucune — Node cross-platform |
| **Plateforme** | Windows uniquement (IPC `WM_COPYDATA`) | Windows / Linux / macOS |
| **Complexité O()** | O(taille du résultat) — lookup d'index | O(taille du volume) — parcours complet |
| **Contenu de fichiers** | Fonctions `content:` d'Everything possibles mais non accélérées par index par défaut | Aucune recherche de contenu non plus |

### Où le MCP filesystem reste meilleur — sois lucide

- **Portable / zero-dep** : rien à installer, pas de processus externe —
  Everything.exe *doit* tourner pour que `everything_*` réponde (sinon
  `EverythingError`), alors que `fs_search_files` marche toujours.
- **Non-Windows** : le serveur officiel tourne partout ; ici c'est
  Windows-only par construction.
- **Zones hors-index** : partages réseau, volumes FAT32/exFAT/ReFS, dossiers
  exclus dans les options Everything — le traversal les voit, l'index non.
  D'où `fs_search_files` conservé comme fallback.
- **Parité de sémantique exacte** : `fs_search_files` est un match de
  sous-chaîne sur le basename ; `everything_search` interprète la syntaxe
  Everything (`a|b` = OU, `!` = NOT…) — une requête littérale contenant ces
  caractères peut surprendre.
- **Tout petit arbre** : quelques milliers d'entrées se parcourent plus vite
  qu'un round-trip IPC + filtrage de policy.

### Où everything-search gagne

- Toute recherche par nom/chemin/taille/date sur des volumes NTFS locaux de
  taille réelle — c'est le cas général d'un agent explorant un PC.
- Questions impossibles autrement en temps interactif : « tous les `.env`
  sur la machine », « les `node_modules` de plus de 500 Mo », « fichiers
  modifiés aujourd'hui sur `F:` ».
- `everything_count` donne un ordre de grandeur instantané avant de paginer
  (`offset` / `max_results`) au lieu de déclencher un scan.

Mesures et protocole reproductible : voir [`wiki/Benchmarks.md`](wiki/Benchmarks.md).
