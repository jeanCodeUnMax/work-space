# PRD — Hephaistos 2.1 : orchestrateur fiable par construction

Statut : draft · Date : 2026-10-18 · Cible : `hephaistos2-kit` (canonique `C:\Program Files\Projet-complet`)

## 1. Objectif

Rendre les échecs silencieux impossibles : un dispatch invalide est **refusé**, un livrable manquant est **détecté**, un provider mort est **écarté automatiquement**, un pair binôme **survit** à un crash IDE. Le tout dans le binaire Rust existant, sans nouvelle couche de services.

## 2. Périmètre

**In scope** : hphe-mcp (Rust), orchestrator.db (migrations additives), ws-bridge, agent-bridge, extension orchestrator-monitor, nouveau CLI `hphe-orch`.
**Out of scope** : refonte des transports ACP/CLI existants, protocole A2A (reporté — voir FEASIBILITY), refonte du modèle de données agents, UI complète de supervision.

## 3. Exigences fonctionnelles

### Phase 1 — Gates au dispatch (Rust)

| ID | Exigence | Critère d'acceptation |
|---|---|---|
| FR-01 | `dispatch_task` refuse `model`/`provider` vide ou absent avant tout spawn | Dispatch `{}` → erreur JSON-RPC explicite, aucun process lancé |
| FR-02 | `dispatch_task` refuse un provider `enabled=0` dans `provider_prefs`, même si forcé | Dispatch vers provider éteint → refus avec position de la chaîne dans le message |
| FR-03 | Colonne `agents.capabilities` (`fs_read`,`fs_write`,`text_only`,`acp`,`hub`) ; dispatch refuse une mission à `expected_artifact` fichier vers un agent `text_only` | nim1/nim2 (`text_only`) + mission fichier → refus immédiat |
| FR-04 | Tools MCP `discipline_agent` / `agent_status` portant la logique d'`agent-discipline.mjs` (score 100 → probation/quarantine/euthanized, `agents.active=0` < 20) | Toute mutation de score passe par l'outil MCP ; le script .mjs devient un client de l'outil |

### Phase 2 — Intégrité des livrables (Rust)

| ID | Exigence | Critère d'acceptation |
|---|---|---|
| FR-05 | `dispatch_task` accepte `expected_artifact` (chemin/glob) ; `update_task(completed)` refusé si fichier absent ou mtime < dispatch (sauf `text_only`) | Worker « complète » sans écrire → update rejeté, tâche reste visible |
| FR-06 | `verify_task` auto vers agent `reviewer` quand un livrable est validé ; anti-boucle (verify ne cascade pas) | Chaque livrable accepté produit une carte de revue QC |
| FR-07 | Circuit breaker : `model_health` compte les échecs consécutifs par provider (402/503/timeout/auth) ; seuil 3 → `enabled=0` temporaire + timestamp ; réactivation après cooldown 15 min ; hystérésis anti-flapping | 3 échecs → provider écarté de la chaîne, event émis ; provider transitoire 503 unique non pénalisé |

### Phase 3 — Supervision JS + extension

| ID | Exigence | Critère d'acceptation |
|---|---|---|
| FR-08 | Heartbeat : wrapper de spawn écrit un tick DB toutes 30 s ; reaper ws-bridge : `in_progress` sans heartbeat > 10 min → `failed` + event `comms.jsonl` | Tuer le process worker → la tâche passe `failed` seule, plus de fantôme |
| FR-09 | Table `pairs` (pairId, self, peer, via, established, timestamps) ; `binome.js` persiste le join ; rejoin auto à la reconnexion | Crash IDE → pair restauré sans re-handshake manuel |
| FR-10 | Fallback `list_acp_sessions` : si aucun client extension sur le bus, sonder les providers directement (`opencode acp session/list`, hub agy) | `chat-id` répond même extension IDE absente |
| FR-11 | Extension : commandes `Join Binome` / `Kill Task` / `Rejoin Last Pair`, status bar du pair, WebView tasks temps réel (:7477), reconnexion WS avec backoff | Join possible sans focaliser l'onglet ; le bus survit à un reload fenêtre |

### Phase 4 — CLI

| ID | Exigence | Critère d'acceptation |
|---|---|---|
| FR-12 | `hphe-orch` : sous-commandes `list/dispatch/kill/verify/status/discipline`, sortie `--json`, écritures via MCP uniquement | Pilotage orchestrateur complet depuis cron/CI/agent shell |

## 4. Exigences non fonctionnelles

- **Rust-first** : toute logique nouvelle dans `hphe-kit`/`hphe-mcp` ; JS limité au pont IDE.
- **Migrations additives** : `ALTER TABLE ... ADD COLUMN`, nouvelles tables — jamais DROP ni réécriture de données.
- **Pas de régression** : les 58 outils existants répondent à l'identique pour les entrées valides.
- **Vélocité** : aucun réseau ni process supplémentaire au démarrage du serveur ; gates = lectures SQLite locales.
- **Observabilité** : chaque refus/verify/bascule écrit un event dans `comms.jsonl` (existant).

## 5. Risques

| Risque | Mitigation |
|---|---|
| Recompile `hphe-mcp.exe` tue les sessions MCP | Fenêtre calme, `.old` conservé, redémarrage contrôlé |
| Heartbeat = faux positif sur worker long sans tick | Seuil 10 min généreux ; heartbeat émis par le spawn wrapper, pas le modèle |
| Circuit breaker éteint un provider sur erreur transitoire | Seuil 3 consécutifs + cooldown + event audit |
| `verify_task` en boucle | `verified_by` renseigné → verify n'engendre jamais de verify |

## 6. Mesures de succès

- 0 tâche `completed` sans livrable vérifié sur disque.
- 0 dispatch accepté vers provider désactivé ou sans modèle.
- 0 tâche `in_progress` > 15 min sans heartbeat.
- Pair binôme restaurée après crash sans intervention.
