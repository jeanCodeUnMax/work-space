---
titre: Phase 3 — Supervision JS (ws-bridge, agent-bridge) + extension IDE
statut: draft
date: 2026-10-18
---

# Phase 3 — Supervision JS + extension orchestrator-monitor

## Contexte

Ce qui ne peut pas vivre dans `hphe-mcp.exe` (Rust) : le bus temps réel, le
pairage inter-agents et l'intégration IDE. Trois composants JS existants :

- **ws-bridge** `extensions/orchestrator-monitor/ws-bridge/bridge.js` —
  poll `orchestrator.db` en **read-only** (`better-sqlite3`, 2 s par défaut,
  `ORCH_MONITOR_POLL_MS`), tail multi-workspaces de `.agent/comms.jsonl`,
  broadcast WebSocket `ws://127.0.0.1:7477` (`ORCH_MONITOR_PORT`).
- **agent-bridge** `.agent/agent-bridge/` — `binome.js` (handshake
  Request/ACK corrélé par `pairId`, paire expirant après 15 min,
  `PAIR_ACK_TIMEOUT_MS=120000`), `chat-id.js`, `acp-inject.js`, `comms.js`,
  `agy-hub.js`, `devin-hub.js`, `agent-adapters.js`.
- **extension** `extensions/orchestrator-monitor/` — VSIX déjà packagée 22+
  fois (v0.0.59), `src/extension.ts` + `src/panel/`.

Problèmes : (a) un worker mort sans `update_task` laisse sa tâche
`in_progress` indéfiniment — le `reap_ghosts` Rust (orch.rs:1450) teste les
PID mais pas les workers qui tournent sans jamais rendre la main ;
(b) les paires binôme sont volatiles (mémoire + comms.jsonl) — un reconnect
perd le `pairId` ; (c) `list_acp_sessions` dépend de l'extension IDE —
absente, plus de découverte ACP ; (d) pas de surface UI pour rejoindre une
paire ou tuer une tâche sans passer par le chat.

Règle 2.1 : le JS ne fait que ce que l'IDE/le navigateur impose ; toute
écriture DB d'infrastructure passe soit par le schéma migré côté Rust
(colonnes posées en phase 1), soit par des outils MCP. La table `pairs` est
créée par la migration Rust (canonique) ; l'agent-bridge y écrit via
`better-sqlite3` en connexion dédiée (composant infrastructure, pas agent).

## Exigences fonctionnelles

### FR-3.1 — Heartbeat worker

Le **template de spawn** (wrapper `command` dans `agents.config`, ex.
`nim-worker.mjs`/shim `.cmd`) émet un tick toutes les **30 s** pendant
l'exécution du worker : `UPDATE tasks_todo SET last_heartbeat=? WHERE id=?
AND status='in_progress'` + pid du worker en `task_events` au premier tick.

Canal : prioritairement `POST /tasks/:id/heartbeat` sur hphe-rest (alias
léger) ; sinon outil MCP `task_heartbeat {task_id, pid}` (nouveau, écrit
`last_heartbeat` — readOnly=false, idempotent). Le tick vient du **wrapper**,
jamais du worker lui-même (point d'attention feasibility : un worker peut
être figé sans que son enrobage meure).

### FR-3.2 — Reaper ws-bridge

Dans `bridge.js`, tâche `in_progress` dont
`COALESCE(last_heartbeat, dispatched_at, created_at) < now - 10 min` →
reaper : `status='failed'`, `result='reaped: heartbeat_timeout'`,
`task_events(event='reaped')`, append `comms.jsonl` (format ci-dessous),
broadcast WS.

Garde-fous : seuil configurable `ORCH_REAPER_TIMEOUT_MS` (défaut 600 000) ;
jamais de reap sur tâche `in_progress` âgée de < seuil ; si `last_heartbeat`
NULL et `dispatched_at` NULL (tâche pré-migration) → fallback pid_alive déjà
assuré par `reap_ghosts` Rust, le reaper JS **n'y touche pas** (pas de
double fauchage : priorité Rust, JS ne traite que les lignes avec
`last_heartbeat` renseignée ou `dispatched_at` postérieur au déploiement).

Écriture : le bridge ouvre une **seconde connexion** better-sqlite3 en
écriture (`readonly:false`, `busy_timeout`) — la connexion de poll reste
read-only. Alternative si politique « MCP only » renforcée : appel stdio
`hphe-mcp` par reap — retenu en option B (latence spawn ~100 ms, acceptable).

### FR-3.3 — Persistance des paires

Table créée par migration Rust (phase 1/3, additive) :

```sql
CREATE TABLE IF NOT EXISTS pairs (
  pairId      TEXT PRIMARY KEY,
  self        TEXT NOT NULL,          -- nom canonique agent_adapters
  peer        TEXT NOT NULL,
  via         TEXT NOT NULL,          -- acp|cli|hub|cascade (côté self)
  peer_via    TEXT,
  self_session TEXT,                  -- id de session ACP/CLI côté self
  peer_session TEXT,
  established INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_ack    TEXT                    -- ts du dernier ACK/message reçu
);
```

`binome.js` : à l'ACK du handshake → UPSERT `established=1, last_ack=now` ;
à chaque `send`/`ask` réussi → `last_ack=now` ; à l'échec timeout →
`established=0`. `comms.js` expose `pairRegistry.open(dbPath)` réutilisable.

### FR-3.4 — Rejoin auto au reconnect

Au démarrage de l'agent-bridge (listener) ou à la reconnexion du transport :

1. `SELECT * FROM pairs WHERE self=? AND established=1 ORDER BY last_ack
   DESC LIMIT 1`.
2. Si `last_ack` dans la fenêtre de grâce (**15 min**, alignée sur l'expiry
   binome ; configurable `PAIR_REJOIN_GRACE_MS`) → renvoyer un message
   `kind:'rejoin'` sur le même `pairId` et la même session ; ACK sous
   `PAIR_ACK_TIMEOUT_MS` → `last_ack` rafraîchi, paire reprise.
3. Hors grâce ou timeout → nouvelle tentative ×2 (backoff 5 s/30 s) puis
   `established=0` + `comms.jsonl` event `pair_expired` ; prochain `join`
   crée un nouveau `pairId`.
4. Jamais deux paires `established=1` pour le même couple `(self, peer)` :
   le join marque les anciennes `established=0`.

### FR-3.5 — Fallback `list_acp_sessions` sans extension IDE

`chat-id.js`/`acp-inject.js` : si le feed sessions de l'extension (WS :7477)
est indisponible > 3 s → sondage direct :

- `opencode acp session/list --json` (spawn stdio, timeout 5 s, parse JSON) ;
- hub agy : `agy-hub.js` interroge son endpoint sessions (transport hub
  déjà existant).

Fusion dédoublonnée par `sessionId`, cache 5 s, marquage `source:
'extension'|'opencode'|'agy-hub'`. Dès que le WS revient → source extension
redevient prioritaire (pas de flip-flop : hysteresis 10 s).

### FR-3.6 — Commandes et UI de l'extension

- Commandes palette : `Hephaistos: Join Binome` (picklist peer + via),
  `Hephaistos: Kill Task` (picklist tâches `in_progress` →
  `update_task failed` via outil MCP), `Hephaistos: Rejoin Last Pair`.
- Status bar : item `⧉ pair:<peer> (<pairId court>)` quand paire
  established ; cliquable → `Rejoin Last Pair`.
- WebView « Tasks » : tree temps réel des tâches par statut via WS :7477
  (le bridge broadcaste déjà les snapshots — le panel s'y abonne, boutons
  kill/retry inline).
- Reconnexion WS client : backoff exponentiel 1 s → ×2 → plafond 30 s +
  jitter ±20 %, infini ; indicateur status bar `disconnected` grisé.

## Spécifications

### Protocole heartbeat

```
wrapper spawn :
  t0      → POST /tasks/:id/heartbeat {pid, phase:'start'}
  t+30sn  → POST /tasks/:id/heartbeat {pid}
  exit    → POST /tasks/:id/heartbeat {pid, phase:'end'} puis update_task
```

`task_heartbeat` (tool MCP miroir) : `{task_id:int, pid:int?}` →
`UPDATE tasks_todo SET last_heartbeat=<now_iso> WHERE id=? AND
status='in_progress'` ; retour `{beat:true}` ou `{beat:false,
reason:'not_in_progress'}` (zéro erreur : un heartbeat tardif n'est pas une
faute). Premier beat d'une tâche → `task_events(event='heartbeat_start',
detail='pid=N')`.

### Format event reaper (comms.jsonl + WS `kind:'task'`)

```json
{"ts":"2026-10-18T14:03:11Z","kind":"reaper","source":"ws-bridge",
 "task_id":512,"agent":"kilo-1","reason":"heartbeat_timeout",
 "last_heartbeat":"2026-10-18T13:47:55Z","action":"failed"}
```

### Algorithme rejoin (pseudo)

```js
const pair = lastEstablished(self);              // FR-3.4.1
if (!pair || age(pair.last_ack) > GRACE) return; // pas de paire vivante
for (const wait of [0, 5000, 30000]) {
    await sleep(wait);
    const ack = await sendAndWait(pair, {kind:'rejoin'}, ACK_TIMEOUT);
    if (ack) { touch(pair.pairId); return broadcast('pair_rejoined', pair); }
}
expire(pair.pairId);                             // established=0 + event
```

### API extension (VSCode)

```ts
commands.registerCommand('hephaistos.joinBinome',    joinFlow);
commands.registerCommand('hephaistos.killTask',      killFlow);
commands.registerCommand('hephaistos.rejoinLastPair',rejoinFlow);
statusBarItem.text = pair ? `⧉ ${pair.peer}` : '⧉ —';
// WebViewProvider 'hephaistos.tasksView' : abo WS wss clients :7477,
// messages {type:'snapshot', tasks:[...]} déjà émis par bridge.js
```

### Flux WS consommés (existant, à documenter dans le panel)

`snapshot` (poll 2 s), `comms` (tail jsonl), `pair`, `reaper` (nouveau).

## Plan de test

- `node --check` sur chaque fichier modifié (bridge.js, binome.js,
  comms.js, chat-id.js, acp-inject.js, extension.ts out).
- Heartbeat : spawn factice (worker `sleep`) → `last_heartbeat` avance
  toutes les 30 s ; kill -9 du worker → tick stoppe ; reaper (>10 min, ou
  `ORCH_REAPER_TIMEOUT_MS=60000` en test) → `failed` + event visible dans le
  feed monitor.
- Pairs : join ACK → ligne `pairs` `established=1` ; kill process, relance
  bridge dans la grâce → `pair_rejoined` ; hors grâce → `pair_expired`.
- Fallback sessions : extension arrêtée → `list_acp_sessions` répond via
  `opencode`/`agy-hub` avec `source` correcte ; extension revenue → bascule.
- Extension : `tsc`/build vsix, commandes visibles palette, status bar,
  WebView reçoit les snapshots, WS coupé → reconnect backoff observé.
- Schéma : `cargo check -p hphe-kit` (migration `pairs` côté Rust) ;
  propagation canonique → `servers` ; `PRAGMA table_info(pairs)` sur la DB
  runtime ; `fix-report-2026-10-18.md`.

## Critères d'acceptation

- [ ] Toute tâche `in_progress` sans heartbeat > 10 min passe `failed` avec
      event `reaper` dans comms.jsonl et diffusé WS.
- [ ] Aucun faux reap sur worker vivant qui heartbeate (marge : seuil
      reaper ≥ 3× période de tick).
- [ ] Paires persistées (pairId, self, peer, via, established, created_at,
      last_ack) ; rejoin automatique dans la grâce 15 min ; expiration
      propre hors grâce.
- [ ] `list_acp_sessions` fonctionne extension absente (sondage opencode +
      agy hub) avec marquage de source.
- [ ] Extension : 3 commandes palette opérationnelles, status bar pair,
      WebView tasks live, reconnect WS backoff ≤ 30 s.
- [ ] Bridge : connexion poll toujours read-only ; écritures reaper
      isolées ; `node --check` propre sur tous les fichiers touchés.
- [ ] Propagation canonique → `servers\hephaistos2-kit` vérifiée.

## Risques

- **Faux positif reaper** : worker long sans tick (wrapper non déployé) →
  mitigation : seuil 10 min ≫ 30 s, fallback pid_alive Rust, rollout
  wrapper avant activation reaper (flag `ORCH_REAPER=1` opt-in la première
  semaine).
- **Double fauchage Rust/JS** : partition stricte — Rust gère pid-mort, JS
  gère heartbeat-timeout ; event `reaped` distinct de `reaped`/`ghost`.
- **Écriture DB depuis le bridge** : WAL + `busy_timeout` + requêtes
  ciblées ; si corruption/contention observée → basculer option B (MCP).
- **pairs.sqlite vs comms.jsonl** : divergence possible — la table est
  source de vérité pour `established`, comms.jsonl reste le journal.
- **Flip-flop source sessions** : hysteresis 10 s + priorité extension.
- **Sondage `opencode acp` coûteux** : spawn toutes les 5 s max, timeout
  dur, désactivable `ACP_PROBE=0`.
