# Organisation du projet — Hephaistos2-Kit

Dépôt umbrella + 4 sous-modules. Séparation stricte PROJET (sources) /
INSTALL (runtime déployé).

## Arborescence

```
hephaistos2-kit/                      (repo projet-temporaire/hephaistos2-kit)
├── .gitmodules                       # 4 sous-modules tagués v2.0.0
├── README.md                         # vue d'ensemble
├── INSTALL.md                        # tutoriel install
├── install.ps1 / install.cmd         # deploy PROJET -> INSTALL (pwsh)
├── .env.example                      # config (le vrai .env reste local)
├── .gitignore / .ragignore           # fichiers exclus git / ingestion
├── .mcp-access                       # politique d'accès fs par agent
├── package-vsix.sh                   # packaging des extensions
├── pytest.ini / requirements.txt     # tests python (pipe client)
│
├── hphe/                             # SUBMODULE hephaistos2-engine
│   └── crates/                       # hphe-mcp, hphe-rest(impl), hphe-kit,
│                                   # hphe-daemon, hphe-index, hphe-mft,
│                                   # hphe-usn, hphe-ipc, hphe-query,
│                                   # hphe-content, hphe-vec
│
├── extension/                        # SUBMODULE hephaistos2-search-ext
│   ├── package.json                  # hephaistos-kit-search 1.0.3
│   ├── src/ extension.js             # webview recherche + spawn hphe-mcp
│   ├── media/                        # UI panneau
│   ├── dev/                          # preview
│   ├── server/                       # binaires déployés (miroir INSTALL)
│   └── *.vsix                        # artefact packagé
│
├── extensions/
│   └── orchestrator-monitor/         # SUBMODULE hephaistos2-monitor-ext
│       ├── package.json              # 0.0.59
│       ├── src/ + out/               # TS + compilé
│       ├── ws-bridge/                # bridge :7477 (snapshots read-only)
│       └── *.vsix
│
├── .agent/                           # kit agents/scripts (intégré au repo)
│   ├── ARCHITECTURE.md / REGISTRY.md # références infra
│   ├── scripts/                      # start-workspace, ingest, maintenance…
│   ├── agents/ skills/ workflows/    # couche d'agents
│   └── hermes/ devin/ setup/         # intégrations par IDE
│
├── docs/                             # docs transverses
│   ├── GUIDE.md ORGANISATION.md ONBOARDING.md
│   ├── MCP-TOOLS.md VSIX.md
│   ├── hephaistos-engine/            # docs de conception moteur
│   └── wiki/                         # wiki complet
│
├── tests/                            # pytest (pipe client, parity, watch)
├── tools/ bench/                     # outils + benchmarks
├── memory-database -> <AGENT_DB_ROOT>\current_workspace  (jonction, ignorée)
└── _archive/                         # héritage v1 (non chargé, référence)
```

## Règles de contribution

- Un sous-module = un repo = son propre `git init/push` ; l'umbrella porte
  les gitlinks.
- Les scripts `.agent` ciblent `pwsh` (PS7) — plus de `powershell` 5.1.
- Runtime = `INSTALL\...` régénéré par `install.ps1`, jamais édité à la main.
- `.env` réel = local uniquement ; le commit n'emporte que `.env.example`.
