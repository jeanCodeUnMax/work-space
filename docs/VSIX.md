# Extensions VSIX — fiches techniques

Le kit embarque deux extensions IDE (Devin / VS Code), packagées en `.vsix` et installées côté client. Ce document est la fiche de référence de chacune.

---

## 1. `hephaistos-kit-search` — extension principale

| Champ        | Valeur                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| ID           | `hephaistos-kit-search`                                                                                                    |
| Version      | 1.0.4                                                                                                                        |
| Nom affiché | Hephaistos-Kit Search                                                                                                        |
| Source       | `extension/` (sous-module git)                                                                                             |
| Rôle        | Recherche NTFS ultra-rapide dans l'IDE — moteur Hephaistos ($MFT + journal USN, daemon Rust, **sans Everything.exe**) |

### Fonctionnement

- **Commande** : `everything-search.openSearch` (palette / raccourci) — ouvre le panneau de recherche.
- **Backend** : dialogue avec le daemon `hphe-index` via le named pipe `\\.\pipe\hphe-index` (protocole JSON lines). Le serveur MCP `hphe-mcp.exe` est embarqué dans `extension/server/` pour les clients MCP.
- **Policy fs** : `extension/server/.mcp-access` — whitelist gitignore-style pilotée par `EVERYTHING_MCP_AGENT` (`[default]` = tout permis, `[external]` = lecture bornée pour les sous-agents muxés).
- **Build VSIX** : `package-vsix.sh` (racine du repo).

---

## 2. `hephaistos-chats` - workspace d'orchestration d'agents

| Champ        | Valeur                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| ID           | `hephaistos.hephaistos-chats`                                                                 |
| Version      | 0.2.0                                                                                           |
| Nom affiche  | Hephaistos Chats                                                                                |
| Source       | `extensions/hephaistos-chats/` (dossier local du repo)                                        |
| Role         | Fenetres de chat multi-providers + canvas React Flow de composition de flux d'agents            |

### Fonctionnement

- **Chats** : onglets persistes (`.agent/chats/sessions.json`), transport canonique `completeTurn` (API directe, ACP, Devin via bridge ws :7477 + comms.jsonl).
- **Espace de travail** : panneau React Flow ouvrable en onglet IDE ; nœuds = agents reels du roster `.agent/workspace-roster.json` (Bleubites chat-*, sessions Devin/AGY acp/*, Cerberos) ; roles, skills drag-drop, missions, positions et edges persistes dans le roster.
- **Sync roster** : ajout/retrait de membre met a jour le graphe ; `hidden` retire un bloc sans sortir l'agent ; `double-clic` ouvre la fenetre de chat exacte ; schemas sauvegardables (`~/.hephaistos-workflow-schemas.json`, portee workspace, option tous-workspaces).
- **CLI agent** : `node .agent/agent-bridge/workspace-roster.js` - `add|hide|unhide|workflow connect|configure [--role --task --skills --entry]|schema save|list|load` : le meme outil pour l'utilisateur et pour l'agent orchestrateur.
- **Build VSIX** : `npx @vscode/vsce package` dans `extensions/hephaistos-chats/` ; artefact `hephaistos-chats-<version>.vsix` a la racine de l'extension, committe avec `git add -f` (gitignore `*.vsix`).

---

## 3. `orchestrator-monitor` — supervision orchestrateur

| Champ        | Valeur                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- |
| ID           | `orchestrator-monitor`                                                                       |
| Version      | 0.0.59                                                                                         |
| Nom affiché | Hephaistos Orchestrator Monitor                                                                |
| Source       | `extensions/orchestrator-monitor/` (sous-module git)                                         |
| Rôle        | Supervision temps réel de l'orchestrateur multi-agents (tâches, agents, providers, dispatch) |

### Fonctionnement

- **Activation** : `onStartupFinished` — spawne `node ws-bridge/bridge.js` avec `HEPHAISTOS_WORKSPACE`.
- **Bridge** : poll `orchestrator.db` (snapshot read-only + connexions inscriptibles pour toggles providers/purges), sert `ws://127.0.0.1:7477` (bind loopback strict + token `?token=`/`Bearer` — `ORCH_MONITOR_TOKEN` ou `.agent/ws-bridge.token` généré au boot), broadcast `snapshot`/`task_update`.
- **Native SQLite** : le prépublish vérifie que le binding `better-sqlite3` déjà présent charge et que le bridge écoute. Si le code natif ou l’ABI Node change, arrêter le bridge puis lancer `npm run build:bridge-native` séparément avant le package; ne pas reconstruire un `.node` chargé par le monitor.
- **Commandes** :
  - `orchestratorMonitor.openPanel` — panneau webview principal
  - `orchestratorMonitor.refresh` — forcer un snapshot
  - `orchestratorMonitor.startBridge` / `restartBridge` — cycle de vie du bridge
  - `orchestratorMonitor.clearCompleted` / `clearFailed` / `clearPending` — purge des files
  - `orchestratorMonitor.sendToChat` — injecter un résumé dans le chat Devin
- **Bridge agents** : `agy-hub.js` (Connect-RPC), `devin-hub.js` (WebSocket, inventaire ACP du workspace et routage ciblé), `agent-adapters.js` (sessions CLI Kilo/Hermes avec reprise par ID) et `comms.js` (bus append-only `.agent/comms.jsonl`).
- **Protocole binôme** : commande Devin `/jointes <agent>`; chaque handshake corrèle `pairId`, `session`, transport, provider et IDs exacts, avec TTL de 15 minutes. Les modes hub/ACP/CLI ne basculent jamais implicitement.
- **Injection ACP** : l’inventaire vérifie workspace, provider activé et `providerId/sessionId`. Pour les providers tiers, `wake_acp_agent` passe par `agent-bridge/acp-inject.js` : connexion ACP stdio dédiée, `session/load`/`session/resume` sur l’ID exact puis `session/prompt` (`opencode`, `antigravity-acp`, `mistral-vibe`, `hermes`, `kilo`; binaire surchargeable via `HEPHAISTOS_ACP_CMD_<PROVIDER>`). Provider non mappé ou session non attachable = `skipped`/`failed`; la route native `devin-cli` reste distincte; pas de nouvelle conversation, toast ou presse-papiers.
- **Filet de secours** : `.agent/task-watch.cjs` (client WS -> `.agent/task-events.log`, auto-reconnect).
- **Build** : `npm run vscode:prepublish` depuis `extensions/orchestrator-monitor/`; le VSIX `orchestrator-monitor-0.0.59.vsix` reste dans ce répertoire.

---

## Dépendances entre les deux

```
hephaistos-kit-search ──► hphe-index (pipe) ──► index NTFS
orchestrator-monitor ──► orchestrator.db (WAL) ──► ws-bridge :7477
                     └──► agy --hub (RPC) + comms.jsonl
```

Les deux sont autonomes : la recherche ne dépend pas du monitor, et le monitor ne dépend pas de la recherche (il lit `orchestrator.db` directement).
