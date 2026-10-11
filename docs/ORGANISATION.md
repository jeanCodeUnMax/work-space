# Organisation du projet — everything-search MCP

Organisation **provisoire** : projet mono-fichier-fonctionnel, pas de
packaging, pas de CI. À faire évoluer si le projet grossit.

## Arborescence

```
everything-mcp/
├── server.py            # serveur MCP stdio (point d'entrée)
├── everything_ipc.py    # client IPC Everything (ctypes, QUERY2)
├── categories.py        # catégories de filtres
├── fs_tools.py          # outils filesystem
├── README.md            # vue d'ensemble
├── .gitignore
├── docs/
│   ├── GUIDE.md         # guide local (install, usage, test)
│   └── ORGANISATION.md  # ce fichier
└── _obsolete/           # ancienne archi MFT/SQLite — référence, archivé
```

Non versionné (`.gitignore`) : `.agent/`, `.vscode/`, `*.code-workspace`,
`memory-database` (symlink), `__pycache__/`, logs, DB locales, secrets.

## Branches

| Branche | Rôle | Protégée |
|---|---|---|
| `main` | État stable, déployé/utilisable | oui — commits via merge uniquement |
| `dev` | Branche de travail courante | non |

Règles :

- On travaille **sur `dev`** (branche par défaut de développement).
- `main` ne reçoit que des merges de `dev` quand l'état est stable et testé.
- Features conséquentes : branche `feat/<nom>` depuis `dev`, merge retour sur `dev`.
- Hotfix urgent : `fix/<nom>` depuis `main`, merge `main` + cherry-pick/merge dans `dev`.

```bash
git checkout -b feat/mon-feature dev
# ... commits ...
git checkout dev && git merge --no-ff feat/mon-feature
```

## Commits

Format `type(scope): message` (convention du workspace) :

- `feat` nouvelle fonctionnalité, `fix` bug, `chore` maintenance,
  `docs` documentation, `refactor`, `test`, `perf`
- Un commit = une chose
- Ex: `fix(ipc): aligne le parsing QUERY2 sur le header 20 octets`

## Tests avant merge vers main

1. Smoke IPC : `python -c "import everything_ipc; print(everything_ipc.search('test'))"`
2. Smoke serveur : séquence JSON-RPC `initialize` → `tools/list` → `tools/call everything_search`
3. Vérifier que la recherche répond en <1 s et trouve un chemin connu

## Évolutions possibles

- Packaging (`pyproject.toml`) si distribution prévue
- `tests/` pytest quand la surface le justifiera
- CI (syntax check + smoke) si plusieurs contributeurs

## Étape suivante : extension VS Code (VSIX)

Dashboard de recherche type Everything dans l'IDE — conception inspirée de
`Hephaistos-Kit/extensions/orchestrator-monitor` (src/ TS → out/, webview
media/, build `npx tsc && npx @vscode/vsce package`).

**Contrat d'intégration déjà prêt** — le serveur est un MCP stdio standard :
l'extension spawn `python server.py`, garde un client JSON-RPC longue durée
et appelle `everything_search` / `fs_*`. Aucun bridge supplémentaire requis
(le protocole `snapshot`/`ws-bridge` du monitor n'est pas nécessaire ici :
pas de DB à poller, les requêtes sont synchrones et en ms).

Cible :

```
extension/everything-search/
├── package.json        # contributes: views/webview, commandes, activation
├── tsconfig.json
├── src/
│   ├── extension.ts    # activation, spawn server.py, client MCP stdio
│   ├── mcpClient.ts    # JSON-RPC ligne par ligne (initialize, tools/call)
│   └── searchView.ts   # webview provider : input + résultats virtualisés
├── media/
│   ├── panel.js        # UI recherche (champ, liste, tri colonnes)
│   └── panel.css
└── out/                # compilé tsc
```

Drag & drop webview → workspace : `text/uri-list` sur les items de résultats
(drop natif VS Code vers l'éditeur / l'explorer). Recherche utilisateur
(manuelle, UI) et agent (MCP) partagent le même backend Everything.
