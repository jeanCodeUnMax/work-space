# Organisation du projet — everything-search MCP

Organisation **provisoire** : projet mono-fichier-fonctionnel, pas de
packaging, pas de CI. À faire évoluer si le projet grossit.

## Arborescence

```
everything-mcp/
├── server.py            # serveur MCP stdio (point d'entrée, 18 outils)
├── everything_ipc.py    # client IPC Everything (ctypes, WM_COPYDATA/QUERY2)
├── categories.py        # catégories de filtres
├── fs_tools.py          # outils filesystem + moteur .mcp-access
├── .mcp-access          # politique d'accès par agent (profils)
├── README.md            # vue d'ensemble
├── .gitignore
├── docs/
│   ├── GUIDE.md         # guide local (install, usage, policy, comparatif)
│   ├── ORGANISATION.md  # ce fichier
│   └── wiki/            # wiki complet (Architecture, IPC-Protocol,
│                        #  Tools-Reference, Query-Syntax, Security,
│                        #  Benchmarks, Dev-Guide…)
├── extension/           # extension VS Code/Devin (build dev, non packagée)
│   ├── package.json     # manifest : vue webview, commande, settings
│   ├── extension.js     # entry point : activate/deactivate, spawn client
│   ├── src/
│   │   ├── mcpClient.js # client MCP stdio NDJSON (respawn à backoff)
│   │   └── searchView.js# WebviewViewProvider + pont postMessage
│   ├── media/
│   │   ├── panel.js     # UI du panneau (recherche, nav, favoris, i18n)
│   │   ├── panel.css    # thème via variables CSS VS Code
│   │   └── icon.svg     # icône barre d'activité
│   └── dev/
│       ├── serve_preview.py  # harness navigateur sur l'index réel
│       └── preview.html      # stub acquireVsCodeApi + DOM du panneau
└── _obsolete/           # ancienne archi MFT/SQLite — référence, archivé
```

Non versionné (`.gitignore`) : `.agent/`, `.vscode/`, `*.code-workspace`,
`memory-database` (symlink), `__pycache__/`, logs, DB locales, secrets.

## Branches

| Branche  | Rôle                              | Protégée                          |
| -------- | ---------------------------------- | ----------------------------------- |
| `main` | État stable, déployé/utilisable | oui — commits via merge uniquement |
| `dev`  | Branche de travail courante        | non                                 |

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

## Extension VS Code — état actuel (implémentée, build dev)

L'extension `extension/` existe et fonctionne en version dev (non packagée,
JavaScript CommonJS — le plan initial TypeScript/`out/` a été simplifié en
JS direct, pas de build `tsc` requis) :

- `extension.js` — `activate()` : crée l'OutputChannel, instancie
  `McpClient`, enregistre le `SearchViewProvider` et la commande
  `everything-search.openSearch` (`Ctrl+Alt+F`), warmup du serveur.
- `src/mcpClient.js` — spawn `python -u server.py` en profil `default`
  (utilisateur local = sans restriction), JSON-RPC NDJSON, mapping
  id→promesse, respawn paresseux avec backoff exponentiel (cap 30 s).
- `src/searchView.js` — `WebviewViewProvider` : sert `media/panel.{js,css}`,
  relaie le trafic postMessage webview ↔ MCP, actions fichiers réelles
  (open, openContaining, reveal, create).
- `media/panel.js` — panneau complet : recherche live, navigation
  PC→drives, favoris dossiers/fichiers, preview texte/images avec
  détection binaire, colonnes redimensionnables/réordonnables,
  multi-sélection, submit-to-agent via `fileMention` natif Devin,
  breadcrumbs + historique, i18n FR/EN/ES/DE.
- `dev/serve_preview.py` + `dev/preview.html` — harness de dev navigateur :
  sert les vrais `media/panel.*` avec `acquireVsCodeApi` stubbé, adossé à
  l'index réel via `everything_ipc` (`POST /api/search`, `POST /api/act`).
  Lancement : `python extension/dev/serve_preview.py --port 8787`.

Conception inspirée de `Hephaistos-Kit/extensions/orchestrator-monitor`,
mais **sans bridge** : le serveur est un MCP stdio standard, les requêtes
sont synchrones et en ms — pas de DB à poller, pas de protocole snapshot.

**Reste à faire** : packaging VSIX (`@vscode/vsce package`), publication,
et éventuellement un dashboard plus riche que le panneau sidebar.

Recherche utilisateur (UI manuelle) et agent (MCP) partagent le même
backend Everything — même index, même policy `.mcp-access`.
