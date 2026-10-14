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
| Version | 0.0.54 |
| Nom affiché | Hephaistos Orchestrator Monitor |
| Source | `extensions/orchestrator-monitor/` (sous-module git) |
| Rôle | Supervision temps réel de l'orchestrateur multi-agents (tâches, agents, providers, dispatch) |

### Fonctionnement

- **Activation** : `onStartupFinished` — spawne `node ws-bridge/bridge.js` avec `HEPHAISTOS_WORKSPACE`.
- **Bridge** : poll `orchestrator.db` (snapshot read-only + connexions inscriptibles pour toggles providers/purges), sert `ws://127.0.0.1:7477`, broadcast `snapshot`/`task_update`.
- **Commandes** :
  - `orchestratorMonitor.openPanel` — panneau webview principal
  - `orchestratorMonitor.refresh` — forcer un snapshot
  - `orchestratorMonitor.startBridge` / `restartBridge` — cycle de vie du bridge
  - `orchestratorMonitor.clearCompleted` / `clearFailed` / `clearPending` — purge des files
  - `orchestratorMonitor.sendToChat` — injecter un résumé dans le chat Devin
- **Bridge agents** : `agent-bridge/agy-hub.js` (RPC vers `agy.exe --hub`, Connect-RPC), `agent-adapters.js` (agy, kilo, opencode, gemini, hermes, cline, codex), `comms.js` (bus append-only `.agent/comms.jsonl`).
- **Route finale de transport et wake (agy -> devin)** :
  Le flux direct emprunte :
  `devin-hub.js` (ou `binome.js --as agy send`) -> WebSocket bridge (`ws://127.0.0.1:7477`) -> `wake_devin`.
  
  1. **Si cible `acp/*` (sessions Devin Desktop `devin-cli`, ex. `acp/devin-cli/<slug>`)** :
     - **Restauration de focus dynamique** : interrogation de l'état ACP via `workbench.action.getAcpState`. Si la session focalisée (`focusedSessionId`) n'est pas la session cible mais que celle-ci est bien enregistrée (`providerId === 'devin-cli'`), l'extension exécute `vscode.open` sur l'URI `vscode-cascade-editor:///cascade-<sessionId>`. Cela commute l'onglet existant sans modifier l'arborescence ni créer de session fantôme.
     - **Injection ACP native** : soumission via `devin.sendChatActionMessage` avec `actionType: 'explainAndFixProblem'` et un payload = UN `TextOrScopeItem` brut base64 (champ 1 = texte UTF-8, sans wrapper `SendCascadeInputRequest`). Devin achemine ce payload vers `session/prompt` et le rend comme un message utilisateur dans la session ACP focalisée.
     - **Garde-fou strict** : si la cible n'est ni focalisée ni restaurable, ou inconnue, l'envoi est purement sauté (`skipped` / `wake-noroute`). **JAMAIS** de notification toast, **JAMAIS** de copie dans le presse-papier, **JAMAIS** d'ouverture de nouvelle conversation parasite.
  2. **Si cible UUID classique (sessions Cascade `.pb` historiques)** :
     - `setCascadeId` (switch in-place) puis `sendCascadeInput`.
     - Une cible explicite inconnue est ignorée sans reroutage intempestif.
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
