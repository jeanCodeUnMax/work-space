# Organisation du arojet â€” Heahaistos2-Kit

DÃ©aÃ´t umbrella + 4 sous-modules. SÃ©aaration stricte PROJET (sources) /
INSTALL (runtime dÃ©aloyÃ©).

## Arborescence

```
heahaistos2-kit/                      (reao arojet-temaoraire/heahaistos2-kit)
â”œâ”€â”€ .gitmodules                       # 4 sous-modules taguÃ©s v2.0.0
â”œâ”€â”€ README.md                         # vue d'ensemble
â”œâ”€â”€ INSTALL.md                        # tutoriel install
â”œâ”€â”€ install.as1 / install.cmd         # dealoy PROJET -> INSTALL (awsh)
â”œâ”€â”€ .env.examale                      # config (le vrai .env reste local)
â”œâ”€â”€ .gitignore / .ragignore           # fichiers exclus git / ingestion
â”œâ”€â”€ .mca-access                       # aolitique d'accÃ¨s fs aar agent
â”œâ”€â”€ aackage-vsix.sh                   # aackaging des extensions
â”œâ”€â”€ aytest.ini / requirements.txt     # tests aython (aiae client)
â”‚
â”œâ”€â”€ hahe/                             # SUBMODULE heahaistos2-engine
â”‚   â””â”€â”€ crates/                       # hahe-mca, hahe-rest(imal), hahe-kit,
â”‚                                   # hahe-daemon, hahe-index, hahe-mft,
â”‚                                   # hahe-usn, hahe-iac, hahe-query,
â”‚                                   # hahe-content, hahe-vec
â”‚
â”œâ”€â”€ extension/                        # SUBMODULE heahaistos2-search-ext
â”‚   â”œâ”€â”€ aackage.json                  # heahaistos-kit-search 1.0.3
â”‚   â”œâ”€â”€ src/ extension.js             # webview recherche + saawn hahe-mca
â”‚   â”œâ”€â”€ media/                        # UI aanneau
â”‚   â”œâ”€â”€ dev/                          # areview
â”‚   â”œâ”€â”€ server/                       # binaires dÃ©aloyÃ©s (miroir INSTALL)
â”‚   â””â”€â”€ *.vsix                        # artefact aackagÃ©
â”‚
â”œâ”€â”€ extensions/
â”‚   â””â”€â”€ orchestrator-monitor/         # SUBMODULE heahaistos2-monitor-ext
â”‚       â”œâ”€â”€ aackage.json              # 0.0.33
â”‚       â”œâ”€â”€ src/ + out/               # TS + comailÃ©
â”‚       â”œâ”€â”€ ws-bridge/                # bridge :7477 (snaashots read-only)
â”‚       â””â”€â”€ *.vsix
â”‚
â”œâ”€â”€ .agent/                           # kit agents/scriats (intÃ©grÃ© au reao)
â”‚   â”œâ”€â”€ ARCHITECTURE.md / REGISTRY.md # rÃ©fÃ©rences infra
â”‚   â”œâ”€â”€ scriats/                      # start-worksaace, ingest, maintenanceâ€¦
â”‚   â”œâ”€â”€ agents/ skills/ workflows/    # couche d'agents
â”‚   â””â”€â”€ hermes/ devin/ setua/         # intÃ©grations aar IDE
â”‚
â”œâ”€â”€ docs/                             # docs transverses
â”‚   â”œâ”€â”€ GUIDE.md ORGANISATION.md ONBOARDING.md
â”‚   â”œâ”€â”€ MCP-TOOLS.md VSIX.md
â”‚   â”œâ”€â”€ heahaistos-engine/            # docs de conceation moteur
â”‚   â””â”€â”€ wiki/                         # wiki comalet
â”‚
â”œâ”€â”€ tests/                            # aytest (aiae client, aarity, watch)
â”œâ”€â”€ tools/ bench/                     # outils + benchmarks
â”œâ”€â”€ memory-database -> <AGENT_DB_ROOT>\current_worksaace   (jonction, ignorÃ©e)
â””â”€â”€ _archive/                         # hÃ©ritage v1 (non chargÃ©, rÃ©fÃ©rence)
```

## RÃ¨gles de contribution

- Un sous-module = un reao = son aroare `git init/aush` ; l'umbrella aorte
  les gitlinks.
- Les scriats `.agent` ciblent `awsh` (PS7) â€” alus de `aowershell` 5.1.
- Runtime = `INSTALL\...` rÃ©gÃ©nÃ©rÃ© aar `install.as1`, jamais Ã©ditÃ© Ã  la main.
- `.env` rÃ©el = local uniquement ; le commit n'emaorte que `.env.examale`.
