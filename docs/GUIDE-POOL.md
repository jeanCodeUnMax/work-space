# GUIDE-POOL — l'organisation `projet-temporaire` et son pool de modules

Carte complète de l'org GitHub `projet-temporaire` : le noyau Hephaistos2
(umbrella + sous-modules) et le pool des modules complémentaires qui
l'entourent. Chaque module est un dépôt indépendant — **pas** un sous-module
du kit — cloné et installé à côté selon le besoin.

## Vue d'ensemble

- **Org** : `github.com/projet-temporaire` — tous les dépôts sont privés.
- **Noyau** : `hephaistos2-kit` (umbrella) + 3 sous-modules git.
- **Pool** : ~19 dépôts satellites répartis en 5 familles (agents, navigateur,
  MCP génériques, sécurité/infra, divers).
- **Miroir** : les dépôts du noyau sont aussi poussés vers `lascard-m/*`
  (mêmes commits, même tag).

## Noyau — Hephaistos2 v2

| Repo | Rôle | Type |
|---|---|---|
| `hephaistos2-kit` | umbrella : docs, `install.ps1`, tests, couche `.agent/` | repo racine |
| `hephaistos2-engine` | workspace Rust : `hphe-indexd` ($MFT+USN), `hphe-mcp` (58 outils), `hphe-rest` :8792 | sous-module `hphe/` |
| `hephaistos2-search-ext` | extension VS Code recherche (VSIX 1.0.3) | sous-module `extension/` |
| `hephaistos2-monitor-ext` | `orchestrator-monitor` (VSIX 0.0.58, ws-bridge :7477) | sous-module `extensions/orchestrator-monitor/` |

Détail : [ONBOARDING.md](ONBOARDING.md) · [ORGANISATION.md](ORGANISATION.md) ·
[GUIDE.md](GUIDE.md)

## Pool des modules complémentaires

### Agents & recherche

| Repo | Rôle | Langage |
|---|---|---|
| `Thot-Agents` | console de veille perso : revue de presse quotidienne, cockpit Telegram, chat multi-providers (NIM, Ollama, OpenRouter, agy, Kilo…), dashboard local :8787 | Python |
| `super-agent` | interroge les chats IA web (ChatGPT, Gemini, Grok, sites custom) dans le Chrome-robot partagé ; cible `devin` via le protocole binôme (WS :7477 + `comms.jsonl`) | Python |
| `beacon-mcp` | serveur MCP Beacon : expose l'activité locale des agents (prompts, tool calls, mémoire cross-harness) en JSON compatible Wazuh ; binaires v1.3.20 vendored | PowerShell |

### Navigateur & automatisation web

| Repo | Rôle | Langage |
|---|---|---|
| `OpenCLI` | transforme tout site en CLI ; pilote le Chrome connecté (adapters de sites + browser-use) | — |
| `opencli-mcp` | OpenCLI reborn en runtime MCP : host spawné par Chrome, object API + code mode, adapters de sites vérifiés | TypeScript |
| `opencli-cookies` | adaptateur OpenCLI maison : jar de cookies Chrome complet (HttpOnly inclus) via l'extension Browser Bridge | Python |
| `puppeteer` | serveur MCP Puppeteer vendored depuis `servers-archived` (MIT), `dist/` prébuildé commité | TypeScript |

### Serveurs MCP génériques

| Repo | Rôle | Langage |
|---|---|---|
| `mcp-mux` | multiplexeur stdio→stdio : partage les processus MCP backend entre sessions via un broker local (N shims + serveurs partagés) | JavaScript |
| `mcp-quick-sqlite3` | MCP SQLite : lister tables, décrire schémas, exécuter des requêtes | TypeScript |
| `google-drive-mcp` | MCP Google Drive enrichi : lister, lire, rechercher, envoyer des fichiers (composant Hephaistos-Kit v1) | JavaScript |
| `kaggle-mcp` | MCP Kaggle complet : compétitions, datasets, kernels, modèles, benchmarks + 10 outils de discussions | Python |

### Sécurité & infrastructure

| Repo | Rôle | Langage |
|---|---|---|
| `acp-backup` | stack agents ACP de Devin (ACP-CLI-MCP-MASTER) : registre, binaires CLI, configs MCP, snapshots/restore, scan/scrub secrets, `doctor.py` | Python |
| `secu-git` | pack sécu GitHub 100 % gratuit : secrets, antivirus, deps malveillantes, code smell, couverture, audit — scripts + workflows | PowerShell |
| `security-sheeld` | Cerbere Security Shield : suite sécurité Windows 100 % locale — ports en écoute, DNS sortants, processus communicants | Python |
| `sin-and-death` | application Tauri/Rust de monitoring système et sécurité | Python |
| `Herald-OS` | appliance Linux bootc (Fedora) pour ASUS K70IJ : install unattended, SSH clés-only, wayvnc, agent Hermes + outillage USB Ventoy | TypeScript |

### Org & archives

| Repo | Rôle |
|---|---|
| `.github` | fichiers de santé communautaire de l'org (SECURITY.md, templates issues/PR, CONTRIBUTING) |
| `Hephaistos-Kit` | miroir du kit v1 historique (`art-qalam-fr/Hephaistos-Kit`) |
| `demo-repository` | dépôt de démonstration GitHub |

## Comment les modules se relient au kit

- **Pas de sous-module** : seuls engine/search-ext/monitor-ext sont déclarés
  dans `.gitmodules`. Les modules du pool se clonent côte à côte.
- **Enregistrement MCP** : les serveurs du pool se déclarent dans la config
  MCP de l'IDE (stdio), aux côtés de `Hephaistos-everything-search`
  (`hphe-mcp`).
- **Chrome-robot** : `super-agent`/`Thot-Agents` partagent le profil robot
  `%LOCALAPPDATA%\ThotBrowser` (debug `127.0.0.1:9223`).
- **Beacon** : `beacon-mcp` est consommé par la boucle d'ingestion
  `hphe-rest` uniquement quand `beacon.enabled` est actif.
- **Bridge ACP** : `acp-backup` sauvegarde la stack que
  `.agent/agent-bridge/` pilote (`binome.js`, `acp-inject.js`, WS :7477).

## Cycle de vie

- Chaque dépôt du pool a son propre cycle commit/push — indépendant de
  l'umbrella.
- Remote de travail : `origin` = `projet-temporaire`. Le noyau est aussi
  poussé vers le miroir `lascard-m/*`.
- Vérifier `.env`, secrets et `.gitignore` avant tout push
  (cf. [ONBOARDING.md](ONBOARDING.md) — section Sécurité).
