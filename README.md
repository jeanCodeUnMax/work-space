# everything-search MCP

> Recherche de fichiers **instantanée sur tout le PC** pour agents IA —
> serveur MCP stdio en *thin client* sur l'index live d'**Everything.exe**,
> avec une suite filesystem complète intégrée.
> Zéro dépendance : Python 3.11+ stdlib + `ctypes`.

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Python](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)
![Dépendances](https://img.shields.io/badge/dépendances-zéro-brightgreen)
![Backend](https://img.shields.io/badge/backend-Everything%201.4.1%2B-orange)
![Protocole](https://img.shields.io/badge/protocole-MCP%20stdio%20%2F%20JSON--RPC-blueviolet)
![Ports réseau](https://img.shields.io/badge/ports%20réseau-aucun-success)
![Outils](https://img.shields.io/badge/outils-18-informational)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

| Chiffres clés | Valeur |
|---|---|
| Entrées indexées | ~15,8 M (mesuré sur la machine de dev, 4 volumes NTFS) |
| Latence de recherche | **< 50 ms** typique — identique au GUI Everything |
| Index local | **aucun** — pas de SQLite, pas d'énumération MFT, pas de rebuild |
| Droits admin | **non requis** pour la recherche |
| Transport | stdio uniquement — **aucun port réseau** |

---

## Sommaire

- [Présentation](#présentation)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration MCP](#configuration-mcp)
- [Outils exposés](#outils-exposés)
- [Syntaxe de requête](#syntaxe-de-requête)
- [Sécurité et politique d'accès](#sécurité-et-politique-daccès)
- [Extension VS Code](#extension-vs-code)
- [Structure du projet](#structure-du-projet)
- [Benchmarks](#benchmarks)
- [Roadmap](#roadmap)
- [Crédits](#crédits)

---

## Présentation

`everything-search` donne à un agent IA la vitesse de recherche d'Everything
sur l'ensemble du PC, plus la parité complète des outils du serveur MCP
`filesystem` officiel (`fs_*`) — un seul serveur couvre
« chercher + lire + éditer ».

Le serveur est un **thin client** : il ne maintient aucun index propre. Les
requêtes sont relayées au processus **Everything.exe** en cours via le
protocole IPC officiel `WM_COPYDATA` / `QUERY2` — le même canal que le GUI
Everything et le SDK officiel. Le service Everything maintient son index NTFS
en continu (base unique `~600 Mo` dans
`%LOCALAPPDATA%\Everything\Everything.db`) : **zéro redondance**.

Par rapport au MCP `filesystem` officiel (`@modelcontextprotocol/server-filesystem`),
qui parcourt le disque récursivement et ne sait pas chercher par nom indexé,
une requête `everything_search` typique répond en millisecondes là où un
traversal de `C:/` ne termine pas en temps interactif. Voir le
[comparatif argumenté](docs/GUIDE.md#everything-search-vs-mcp-filesystem-officiel)
et les [mesures reproductibles](docs/wiki/Benchmarks.md).

---

## Architecture

```
┌─────────────────────────────┐
│  Client MCP                 │   Devin / Claude / tout client stdio
│  ou extension VS Code       │   (spawn `python -u server.py`)
└──────────────┬──────────────┘
               │  stdio — JSON-RPC NDJSON (1 objet / ligne)
               ▼
┌─────────────────────────────┐
│  server.py                  │   registry des 18 outils
│  fs_tools.py                │   + policy .mcp-access (profils par agent)
│  categories.py              │   catégories audio:/video:/document:…
└──────────────┬──────────────┘
               │  WM_COPYDATA / QUERY2 — everything_ipc.py (ctypes)
               │  fenêtre cachée de réponse, SendMessageTimeout 15 s
               ▼
┌─────────────────────────────┐
│  Everything.exe             │   FindWindow("EVERYTHING_TASKBAR_NOTIFICATION")
│  service d'indexation live  │   MFT + journal USN, index toujours à jour
│  Everything.db (~600 Mo)    │   %LOCALAPPDATA%\Everything\Everything.db
└──────────────┬──────────────┘
               │
               ▼
        Volumes NTFS locaux (C: D: E: F: …)
```

| Composant | Rôle |
|---|---|
| `server.py` | Boucle JSON-RPC NDJSON sur stdio, registry des outils, traduction `matchpath:` → flag MATCHPATH |
| `everything_ipc.py` | Client IPC `ctypes` : FindWindow, construction QUERY2, fenêtre de réponse cachée, parsing LIST2 (full path / size / mtime / attributs), sort, `find_everything_exe()` |
| `fs_tools.py` | Outils filesystem + moteur de policy `.mcp-access` |
| `categories.py` | Ensembles d'extensions des catégories de filtres |

La latence est **bornée par le payload de résultats**, pas par l'index :
la lookup est en ms, l'essentiel du temps des gros résultats (>1000 lignes)
est le transfert `WM_COPYDATA` + le parsing — même ordre de grandeur que le
GUI Everything lui-même.

---

## Installation

### Prérequis

- **Windows** avec **Everything 1.4.1+** installé et **en cours d'exécution**
  (le service Everything maintient l'index — téléchargement :
  [voidtools.com](https://www.voidtools.com/)).
- **Python 3.11+**. Aucune dépendance tierce.
- Aucun droit administrateur requis pour la recherche.

> `Everything.exe` est localisé par `find_everything_exe()` dans l'ordre :
> chemin de l'image du processus en cours (couvre les installs exotiques) →
> `EVERYTHING_EXE` → clés de désinstallation du registre → chemins standards
> (`ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`).

### Récupérer le serveur

```bash
git clone <repo> "C:/Program Files/servers/everything-mcp"
cd "C:/Program Files/servers/everything-mcp"
python server.py   # mode standalone : JSON-RPC une ligne par requête sur stdin
```

Smoke test sans client MCP :

```bash
python -c "import everything_ipc, time; t=time.time(); print(everything_ipc.search('dots folder:')['total'], (time.time()-t)*1000, 'ms')"
```

---

## Configuration MCP

Exemple Devin (`%APPDATA%\devin\mcp_config.json`) — identique pour tout
client MCP stdio :

```json
"everything-search": {
  "command": "python",
  "args": ["-u", "C:/Program Files/servers/everything-mcp/server.py"],
  "env": {
    "EVERYTHING_EXE": "C:/Program Files/Everything/Everything.exe",
    "EVERYTHING_MCP_AGENT": "default"
  }
}
```

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `EVERYTHING_EXE` | Chemin vers `Everything.exe` | `C:\Program Files\Everything\Everything.exe` |
| `EVERYTHING_MCP_AGENT` | Profil `.mcp-access` actif (`default`, `external`, …) | `default` (sans restriction) |
| `EVERYTHING_MCP_ROOTS` | Allowlist brute de racines pour `fs_*`, séparées par `;` — vide = sans restriction | vide |
| `EVERYTHING_MCP_ACCESS_FILE` | Chemin alternatif du fichier de policy | `.mcp-access` à la racine du repo |

---

## Outils exposés

**18 outils** : 6 `everything_*` (recherche index) + 12 `fs_*` (filesystem,
parité avec le serveur `filesystem` officiel).

### Recherche — index Everything live

| Outil | Rôle | Lecture seule |
|---|---|---|
| `everything_search` | Recherche syntaxe native Everything. Params : `query`, `max_results` (défaut 100, cap 10 000), `offset`, `sort` (`name`/`path`/`ext`/`date`/`size`), `descending`. Retourne `path`, `name`, `dir`, `size`, `mtime`, `attrs`, `total`, `elapsed_ms`, `filtered_by_policy` | ✅ |
| `everything_count` | Compte les matches sans retourner les lignes | ✅ |
| `everything_categories` | Liste les catégories de filtres et leurs extensions | ✅ |
| `everything_index_stats` | Statut du service : version, `db_loaded`, `db_busy`, total indexé | ✅ |
| `everything_refresh` | Sauvegarde la db (défaut) ; `full=true` → rebuild complet par Everything | — |
| `everything_open_gui` | Lance `Everything.exe -s <query>` pour visualiser dans le GUI | — |

### Filesystem

| Outil | Rôle | Lecture seule |
|---|---|---|
| `fs_read_file` | Lit un fichier (UTF-8, tronqué à `max_bytes`, défaut 1 Mio) | ✅ |
| `fs_read_multiple_files` | Lit plusieurs fichiers en un appel ; les échecs unitaires n'arrêtent pas le batch | ✅ |
| `fs_list_directory` | Entrées d'un dossier (nom, dir, taille, mtime) | ✅ |
| `fs_get_info` | Stat d'un chemin : taille, dates, attributs, readonly | ✅ |
| `fs_directory_tree` | Arbre JSON récursif borné (`max_depth` 8, `max_entries` 10 000) | ✅ |
| `fs_write_file` | Écrit du texte (crée les parents ; `append` optionnel) | ❌ |
| `fs_edit_file` | Remplacements exacts `oldText`→`newText`, diff git-style, `dryRun` | ❌ |
| `fs_create_directory` | Crée un dossier (parents inclus, idempotent) | ❌ |
| `fs_move` | Déplace/renomme (`overwrite` optionnel) | ❌ |
| `fs_delete` | Supprime fichier ou dossier (`recursive` optionnel) | ❌ |
| `fs_search_files` | Recherche par traversal, nom partiel insensible casse — **lent** sur gros arbres : fallback hors-index, préférer `everything_search` | ✅ |
| `fs_list_allowed_roots` | Liste l'allowlist `EVERYTHING_MCP_ROOTS` effective | ✅ |

---

## Syntaxe de requête

`query` est passée quasi brute à Everything — syntaxe native complète :

```
rapport ext:pdf;docx           # PDF/DOCX nommés rapport
*.log size:>10mb               # gros logs
dm:today folder:               # dossiers modifiés aujourd'hui
audio: F:/                     # audio sur F:
"a|b" !*.tmp                   # OU / NON
regex:^\d{4}-                  # regex
path:servers matchpath:        # terme matché sur le chemin complet
```

Wildcards `*` `?`, `a|b` (OR), `!` (NOT), `ext:`, `size:`, `dm:`, `path:`,
`parent:`, `regex:`, `case:`, `ww:`, `startwith:`, `endwith:`, `folder:`,
`file:`, catégories `audio:` `video:` `document:` `executable:` `picture:`
`compressed:`. Seul `matchpath:` n'est pas natif : il est traduit en flag de
recherche `MATCHPATH`.

---

## Sécurité et politique d'accès

Deux couches indépendantes, appliquées à **tous** les outils (les résultats
de recherche sont aussi filtrés — champ `filtered_by_policy`) :

1. **`.mcp-access`** (racine du repo) — policy par agent, syntaxe
   gitignore : `<action>:<glob>`, dernier match gagne, profils `[default]`
   / `[external]` / … sélectionnés par `EVERYTHING_MCP_AGENT`.
   Actions : `allow:` `read:` `write:` `deny-write:` `deny:`.

   ```gitignore
   [default]
   allow: **                       # agents locaux de confiance (extension comprise)

   [external]
   read: F:/Promgramation-teste/**
   deny: **/.env                   # secrets toujours refusés
   deny: **/*.pem
   deny-write: **                  # aucune écriture
   ```

2. **`EVERYTHING_MCP_ROOTS`** — allowlist de racines absolues additionnelle
   sur les `fs_*` (vide = sans restriction).

**Règles d'architecture à ne jamais casser :**

- Transport **stdio uniquement** — le serveur n'ouvre aucun port réseau.
- Les serveurs **HTTP/ETP d'Everything doivent rester désactivés** (option
  Everything) : l'IPC local `WM_COPYDATA` suffit.
- L'extension locale et les agents de confiance tournent en profil
  `default` (sans restriction) ; les agents externes muxés reçoivent un
  profil borné (`external` = lecture limitée + `deny-write: **`).
- Détail complet : [`docs/GUIDE.md`](docs/GUIDE.md) et
  [`docs/wiki/Security.md`](docs/wiki/Security.md).

---

## Extension VS Code

`extension/` embarque une extension **VS Code / Devin** « Everything Search »
(build dev, non packagée) : panneau webview complet dans la barre latérale —
recherche live, navigation fichiers PC→drives, favoris dossiers/fichiers,
preview texte/images avec détection binaire, colonnes redimensionnables et
réordonnables, multi-sélection, *submit-to-agent* via `fileMention` natif
Devin, breadcrumbs + historique, multilingue FR/EN/ES/DE.

- `extension/src/mcpClient.js` spawne `python -u server.py` en profil
  `default` (utilisateur local = sans restriction) avec respawn à backoff.
- Raccourci : `Ctrl+Alt+F` (`everything-search.openSearch`).
- Harness navigateur pour itérer l'UI hors IDE sur l'index réel :
  `python extension/dev/serve_preview.py --port 8787`.

---

## Structure du projet

```
everything-mcp/
├── server.py              # serveur MCP stdio (point d'entrée, 18 outils)
├── everything_ipc.py      # client IPC WM_COPYDATA / QUERY2 (ctypes)
├── fs_tools.py            # outils fs_* + moteur .mcp-access
├── categories.py          # catégories de filtres Everything
├── .mcp-access            # politique d'accès par profil d'agent
├── docs/
│   ├── GUIDE.md           # guide d'installation / usage / policy
│   ├── ORGANISATION.md    # conventions du repo (branches, commits)
│   └── wiki/              # wiki complet (Architecture, IPC, Security…)
├── extension/             # extension VS Code/Devin (build dev)
│   ├── package.json       # manifest : vue webview, commande, settings
│   ├── extension.js       # activate/deactivate, spawn client MCP
│   ├── src/               # mcpClient.js, searchView.js
│   ├── media/             # panel.js / panel.css / icon.svg (UI webview)
│   └── dev/               # serve_preview.py + preview.html (harness)
└── _obsolete/             # ancienne archi MFT/SQLite — référence, ne pas importer
```

---

## Benchmarks

Mesures sur la machine de dev (~15,8 M d'entrées indexées) — détail et
protocole reproductible : [`docs/wiki/Benchmarks.md`](docs/wiki/Benchmarks.md).

| Requête | everything_search | `search_files` du MCP filesystem officiel |
|---|---|---|
| `dots` sur tout le PC (1 328 hits) | **~4,7 s** (payload-bound) | `C:/` seul : **>15 min, interrompu** |
| `dots folder:` (35 hits) | **~300–400 ms** warm | selon l'arbre parcouru |
| Lookup index pure (`everything_count`) | **ms** | n/a (pas d'index) |

Le serveur renvoie `elapsed_ms` dans chaque réponse `everything_search` pour
faciliter l'instrumentation.

---

## Roadmap

- [x] Thin client IPC `QUERY2` officiel (remplace l'index MFT/SQLite maison)
- [x] Suite `fs_*` en parité avec le MCP filesystem officiel
- [x] Policy `.mcp-access` par profil d'agent
- [x] Extension VS Code/Devin — panneau de recherche complet (build dev)
- [ ] Packaging VSIX + publication de l'extension (dashboard intégré IDE)
- [ ] `pyproject.toml` + tests pytest + CI si le projet grossit
- [ ] Évolution éventuelle des profils `.mcp-access` (granularité par outil)

---

## Crédits

- **Everything © voidtools — David Carpenter** : ce MCP est un *thin client*
  sur l'index live d'Everything, exactement comme le SDK officiel Everything —
  sans lui, rien de tout cela. <https://www.voidtools.com/>
- Module du **Hephaistos-Kit** — [github.com/art-qalam-fr](https://github.com/art-qalam-fr),
  [art-qalam.fr](https://art-qalam.fr) ; organisation publique **ArchNext**.
- Ancienne architecture (énumération MFT/USN → SQLite) conservée dans
  `_obsolete/` à titre de référence historique.
