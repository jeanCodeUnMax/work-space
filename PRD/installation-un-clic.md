# PRD — Installation en un clic du kit Hephaistos2 (`kit.toml` + `install-kit.ps1`)

Objectif : un poste vierge rejoint l'infrastructure complète en une commande,
avec health check prouvant le bon fonctionnement. Public cible : Webman & co.

## Principe d'architecture

**Orchestrer, pas réécrire.** Les scripts existants restent les implémentations ;
l'installeur est une couche de pilotage déclarative :

- `kit.toml` (racine) : manifeste déclaratif de TOUT le kit — composants,
  versions attendues, CLIs requis, extensions VSIX, config MCP, tâches
  planifiées, règles/skills à injecter, checks de santé.
- `install-kit.ps1` (racine) : lit kit.toml, exécute les phases en appelant
  les scripts existants, tolérant `-WhatIf` / `-Only <phase>` / `-Skip`.
- `kit-health.ps1` : audit post-install non destructif (ping MCP, démon,
  extensions chargées, roster, pipe, ports).

## Technologies portabilité

- **TOML** : manifeste unique lisible par humains + machines (PS has built-in
  parsing via simple regex ou `powershell-yaml`-like minimal parser embarqué).
- **winget** : installation des CLIs Windows (nodejs, python, git…).
- **npm -g / uv tool** : CLIs Node (devin, agy, kilo, hermes, opencode,
  omniroute) et CLIs Python via `uv tool install` (uvx one-shot).

## Phases (kit.toml sections)

| Phase | Contenu | Script sous-jacent |
|---|---|---|
| 0 prerequis | node, pwsh, git, cargo?, winget, uv/uvx | vérif + install winget |
| 1 engine | install.ps1 existant (build Rust, deploy bin, MCP config, indexd task) | install.ps1 |
| 2 agent-layer | .agent/ scaffold + sync + init-project | init-project.ps1, sync-agent-layer.ps1 |
| 3 cli | CLIs : devin, agy, kilo, hermes, opencode, **omniroute** (priorité), uvx | npm -g / uv tool |
| 4 extensions | 4 VSIX : hephaistos-chats, orchestrator-monitor, kit-search, postdev | install-extension-hub.ps1 |
| 5 plugin | `devin plugins install --local plugin-devin/` | devin CLI |
| 6 config | mcp.json, provider_prefs, skills .agent/skills, rules globales + rules bleubites, binome | setup-config.mjs, setup-devin-acp.mjs, setup-devin-binome.ps1, setup-agent-surfaces.ps1, setup-mcp-mux.mjs |
| 7 services | hphe-indexd task, hphe-taskwatch, bridge :7477, startup REST | mcp_autostart.ps1, start-workspace.ps1 |
| 8 secrets | clés NVIDIA_API_KEY[_2], GEMINI — prompt interactif OU env vars, JAMAIS en dur | interactif |
| 9 health | kit-health.ps1 : MCP initialize, daemon up, extensions list, roster, comms | nouveau |

## Tracker

| Jalon | Contenu | État |
|---|---|---|
| K1 | kit.toml manifeste complet + parseur minimal PS | à faire |
| K2 | install-kit.ps1 orchestrateur (phases, idempotent, -WhatIf) | à faire |
| K3 | kit-health.ps1 audit post-install | à faire |
| K4 | doc PRD + guide Webman + nettoyage scripts obsolètes | à faire |

## Règles

- Idempotent : relancer = même état final, rien de cassé.
- Aucun secret en dur ; clés via env ou prompt.
- Chaque phase = OK/WARN/FAIL explicite ; FAIL bloquant seulement si marquée `required`.
- Ne jamais écraser une config existante sans backup `.bak-<ts>`.
- Chemins tous relatifs au repo ou %ProgramFiles% — aucun absolu machine.
