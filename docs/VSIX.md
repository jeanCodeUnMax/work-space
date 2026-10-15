# Extensions VSIX — fiches techniques

Le kit embarque deux extensions IDE (Devin / VS Code), packagées en `.vsix` et installées côté client. Ce document est la fiche de référence de chacune.

---

## 1. `hephaistos-kit-search` — extension principale

| Champ | Valeur |
|---|---|
| ID | `hephaistos-kit-search` |
| Version | 1.0.4 |
| Nom affiché | Hephaistos-Kit Search |
| Source | `extension/` (sous-module git) |
| Rôle | Recherche NTFS ultra-rapide dans l'IDE — moteur Hephaistos ($MFT + journal USN, daemon Rust, **sans Everything.exe**) |

### Fonctionnement

- **Commande** : `everything-search.openSearch` (palette / raccourci) — ouvre le panneau de recherche.
- **Backend** : dialogue avec le daemon `hphe-index` via le named pipe `\\.\pipe\hphe-index` (protocole JSON lines). Le serveur MCP `hphe-mcp.exe` est embarqué dans `extension/server/` pour les clients MCP.
- **Policy fs** : `extension/server/.mcp-access` — whitelist gitignore-style pilotée par `EVERYTHING_MCP_AGENT` (`[default]` = tout permis, `[external]` = lecture bornée pour les sous-agents muxés).
- **Build VSIX** : `package-vsix.sh` (racine du repo).

---

## 2. `orchestrator-monitor` — supervision orchestrateur

| Champ | Valeur |
|---|---|
| ID | `orchestrator-monitor` |
| Version | 0.0.56 |
| Nom affiché | Hephaistos Orchestrator Monitor |
| Source | `extensions/orchestrator-monitor/` (sous-module git) |
| Rôle | Supervision temps réel de l'orchestrateur multi-agents (tâches, agents, providers, dispatch) |

### Fonctionnement

- **Activation** : `onStartupFinished` — spawne `node ws-bridge/bridge.js` avec `HEPHAISTOS_WORKSPACE`.
- **Bridge** : poll `orchestrator.db` (snapshot read-only + connexions inscriptibles pour toggles providers/purges), sert `ws://127.0.0.1:7477`, broadcast `snapshot`/`task_update`.
- **Native SQLite** : le packaging reconstruit `better-sqlite3` avec le Node courant avant de produire le VSIX. Le Node qui lance `ws-bridge/bridge.js` doit partager cet ABI; le test prépublication vérifie que le binding charge et que le bridge écoute.
- **Commandes** :
  - `orchestratorMonitor.openPanel` — panneau webview principal
  - `orchestratorMonitor.refresh` — forcer un snapshot
  - `orchestratorMonitor.startBridge` / `restartBridge` — cycle de vie du bridge
  - `orchestratorMonitor.clearCompleted` / `clearFailed` / `clearPending` — purge des files
  - `orchestratorMonitor.sendToChat` — injecter un résumé dans le chat Devin
- **Bridge agents** : `agy-hub.js` (Connect-RPC), `devin-hub.js` (WebSocket, inventaire ACP du workspace et routage ciblé), `agent-adapters.js` (sessions CLI Kilo/Hermes avec reprise par ID) et `comms.js` (bus append-only `.agent/comms.jsonl`).
- **Protocole binôme** : commande Devin `/jointes <agent>`; chaque handshake corrèle `pairId`, `session`, transport, provider et IDs exacts, avec TTL de 15 minutes. Les modes hub/ACP/CLI ne basculent jamais implicitement.
- **Garde-fou de routage** : l’extension vérifie le workspace, le provider ACP activé, le `sessionId` connu et le focus avant injection. La route de retour vers Devin reste limitée à `devin-cli`; cible inconnue ou non focalisable = `skipped`, sans nouvelle conversation, toast ou presse-papiers.
- **Filet de secours** : `.agent/task-watch.cjs` (client WS -> `.agent/task-events.log`, auto-reconnect).
- **Build** : `npm run compile` / `vscode:prepublish` (TypeScript).

---

## Dépendances entre les deux

```
hephaistos-kit-search ──► hphe-index (pipe) ──► index NTFS
orchestrator-monitor ──► orchestrator.db (WAL) ──► ws-bridge :7477
                     └──► agy --hub (RPC) + comms.jsonl
```

Les deux sont autonomes : la recherche ne dépend pas du monitor, et le monitor ne dépend pas de la recherche (il lit `orchestrator.db` directement).
