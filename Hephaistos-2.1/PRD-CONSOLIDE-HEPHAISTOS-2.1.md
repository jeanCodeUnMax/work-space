# PRD CONSOLIDE — Hephaistos 2.1 : orchestrateur fiable, veille reactive et auto-injection

Statut : consolide post-operation de nuit · Date : 2026-10-19 · Cible : `hephaistos2-kit` (canonique `C:\Program Files\Projet-complet`)
Auteurs : Tango (orchestrateur en chef), Cash/Luna (architecte technique, whip-principle)

Ce document consolide le `PRD.md` initial avec TOUTES les modifications effectivement livrees et deployees durant la nuit du 18-19/10/2026 : gates Rust FR-01 a FR-09, fallback ACP FR-10, durcissement `nim-worker.mjs`, watchdog reactif PowerShell, routage `[agycascade:<uuid>]`, obligation documentaire des incidents et auto-injection permanente via `project_init`.

---

## 1. Objectif

Rendre les echecs silencieux impossibles, a trois niveaux :

1. **Dispatch** : un dispatch invalide est refuse avant spawn (model/provider requis, provider active, capabilities compatibles).
2. **Completion** : un livrable manquant, vide ou anterieur au dispatch est rejete ; un worker fige est reape.
3. **Continuite** : la paire binome survit au restart IDE ; le watchdog detecte queue vide, worker gelee, DB inerte, bridge mort et reveille Tango ; chaque dysfonctionnement est archive en Markdown.

## 2. Exigences fonctionnelles livrees

### Phase 1 — Gates au dispatch (Rust, `hphe-kit/src/orch.rs` + `hphe-mcp/src/tools/kit.rs`)

| ID | Exigence | Etat |
|---|---|---|
| FR-01 | `dispatch_task` refuse `model`/`provider` vide ou absent avant tout spawn | Livre |
| FR-02 | `dispatch_task` refuse un provider `enabled=0` dans `provider_prefs` | Livre |
| FR-03 | `agents.capabilities` (JSON `["fs_read","fs_write","text_only","acp","hub"]`) ; le dispatch refuse une mission fichier a un agent `text_only` | Livre |
| FR-04 | Tools MCP `discipline_agent` / `agent_status` portant la logique d'`agent-discipline.mjs` | Livre |

### Phase 2 — Integrite des livrables (Rust)

| ID | Exigence | Etat |
|---|---|---|
| FR-05 | Gate de completion `expected_artifact` : fichier absent, vide, non regulier ou `mtime <= dispatch` -> `update_task(completed)` rejete | Livre, valide live (rejet absent/ancien, accepte fichier frais) |
| FR-06 | `verify_task` auto a la completion d'une tache `code`/`debug`/`refactor`/`test`, reviewer `fs_read` different de l'executant, anti-boucle via `verified_by` | Livre |
| FR-07 | Circuit breaker provider : `model_health` compte les echecs consecutifs ; 3 echecs -> `provider_prefs.enabled=0` + `disabled_at` + event ; reactivation auto apres cooldown 15 min dans `pick_model` | Livre |

### Phase 3 — Supervision JS, heartbeat et persistance

| ID | Exigence | Etat |
|---|---|---|
| FR-08 | Heartbeat worker : colonne `tasks_todo.last_heartbeat`, tool `task_heartbeat`, beat initial au spawn, tick 30 s par le bridge tant que le PID vit et que le log progresse (`log=` dans l'event dispatched) ; reaper : heartbeat > 10 min ou PID mort -> `failed` + event `comms.jsonl` | Livre |
| FR-09 | Table `pairs` + tools `pair_save`/`pair_get` ; `comms.js` (`pairSave`/`pairGet` via `node:sqlite`) ; `binome.js` persiste a l'etablissement, restaure dans `pair()` et sert de fallback dans `send()` | Livre, valide (`restored:true` sans handshake) |
| FR-10 | Fallback `list_acp_sessions` direct : `listAcpSessionsDirect()` dans `devin-hub.js` lit `state.vscdb` (cles `windsurf.acp.sessioninfo.session.*`) quand le WS :7477 ne repond pas en 1,5 s | Livre (544 sessions inventoriees hors bridge) |

### Phase 4 — CLI `hphe-orch`

| ID | Exigence | Etat |
|---|---|---|
| FR-12 | `hphe-orch` : sous-commandes list/dispatch/kill/verify/status/discipline, `--json`, via `hphe-kit` en lib (pas de spawn stdio) | Spec livree (`.agent/deliverables/phase4-hphe-orch.md`), implementation en attente |

## 3. Durcissement des workers (#521 — `nim-worker.mjs`)

Le pont texte-seul `nim-worker.mjs` produisait des livrables factices (4 cas averes : diffs hallucines `sqlx`/`init_db`, fichiers pretendus ecrits absents du disque, chain-of-thought dump livre a la place de code). Corrections appliquees :

- **readTask SQLite** : le worker lit la description et `expected_artifact` directement en DB au demarrage, sans dependre du prompt.
- **Prompt anti-simulation** : contexte systeme interdisant la simulation d'appels MCP/JSON-RPC et l'affirmation d'ecritures non effectuees.
- **gateArtifact** : la cloture verifie existence, type fichier regulier, taille non nulle et fraicheur (`mtime > created_at`/`dispatched_at`) ; un livrable absent/vide/perime force `failed` au lieu de `completed`, applique sur les deux chemins de cloture (avec et sans deliverable).
- `full_prompt=true` pour `nim1`/`nim2` (seed confirme) ; timeout abort 300 s sur les appels NVIDIA.
- Purge des 6 `prompt_templates` legataires et correction de la substitution `{workspace}` dans `template_to_spawn_plan` (Incident 09 — `spawn ... os error 123`).

## 4. Veille reactive et reveil Tango (watchdog)

`.agent/skills/reactive-orchestrator/watchdog.ps1` — daemon PowerShell actif 24/7 :

- **Cadence** : snapshot toutes les `IntervalSeconds` (30-60 s) via `System.Timers.Timer` + reveil immediat par `FileSystemWatcher` sur `.agent/comms.jsonl` (events `Changed`/`Created`).
- **Sondes** : transitions de statut taches (`taskStatuses`, `wokenTasks`), taches `in_progress` stales (>30 min) et critiques (>90 min), dependances non resolues, agent assigne inactif, `pending` stales, collisions `expected_artifact`, CPU (CIM `Win32_PerfFormattedData_PerfOS_Processor`, alerte si >=90 % sans worker 5 min), processus workers (`cargo`, `rustc`, `hermes`, `kilo`, `ollama`, `node`/`nim-worker.mjs`), pulse DB via mtime `orchestrator.db`/`-wal` (jamais de requete SQL directe), `hphe_health` via pipe, bridge WS :7477, hub AGY, inventaire ACP (sonde `acp-list` toutes les 5 min).
- **Reveil** : les alertes dedupliquees sont aggregees en notes et poussees a Tango par Connect-RPC (`agy-hub.js send <cascade> --model <modele>`) ; event `agy_wake_sent`/`agy_wake_failed` logue.
- **Etat durable** : `watch-state.json` recharge au boot, offset `comms.jsonl` persiste, ecriture atomique (`.tmp` + `Move-Item -Force`).
- **Journal** : JSONL structure dans `.agent/logs/reactive-orchestrator-watchdog.jsonl` (events `snapshot`, `alert`, `wakeup`, `agy_wake_sent`, `watch_started`, `snapshot_failed`).

## 5. Routage `[agycascade:<uuid>]` (orchestrator-monitor)

Les titres de taches prefixes `[agycascade:<uuid>]` routent le resultat vers la cascade Antigravity designee. Le monitor propage le uuid a travers dispatch -> completion -> wake, ce qui permet au watchdog et aux helpers de distinguer une tache non routee (`(non rout.)`) d'une tache routee et de decider du reveil Connect-RPC.

## 6. Obligation documentaire : Rapport de dysfonctionnement et correction

- **Repertoire canonique** : `Rapport de dysfonctionnement et correction/` a la racine du workspace — tout dysfonctionnement d'orchestration, livrable factice, panne worker, contournement de gate ou correction kit est consigne en `.md` (strictement sans emoji : symptome, cause racine, correctif, prevention) + `INDEX-RAPPORTS.md` maintenu.
- **Regle** : `.agent/rules/rapport-dysfonctionnement.md`, reaffirme dans les skills `reactive-orchestrator`, `systematic-debugging` et `hephaistos2-kit` (section 9).
- **Archiviste dedie** : agent Bleubite (acp/devin-cli/equal-level, tache #527), appuye par les workers Cloud pour la transcription.

## 7. Politique de dispatch — priorite workers Cloud CLI

L'orchestrateur ne code pas lui-meme : verification et dispatch uniquement. `dispatch_task` cible en priorite les workers Cloud CLI (`nim1`, `nim2` — NVIDIA NIM, `capabilities=["text_only"]`, livrables en `.agent/deliverables/`) pour les taches `docs`/`explore`/spec, les agents ACP (`fs_read`/`fs_write`/`cmd`) pour les taches fichiers, afin de ne pas saturer les collaborateurs ACP. Providers tombes : circuit breaker FR-07 ; providers jamais testes : probe avant selection ; `hermes`/`ollama-cloud` gels recurrents (incidents 04, 508/524) => timeouts et reaper obligatoires.

## 8. Auto-injection permanente (NFR)

- **Tache VS Code** : `.vscode/tasks.json` embarque `Watchdog Hephaistos` (`runOptions.runOn=folderOpen`, `isBackground=true`) — le watchdog demarre a l'ouverture du workspace.
- **`project_init`** (`hphe-kit`, expose via `hphe-mcp`) : tout workspace initialise recoit automatiquement, de facon idempotente (jamais d'ecrasement) : `.agent/skills/reactive-orchestrator/watchdog.ps1`, `.agent/rules/rapport-dysfonctionnement.md`, `.vscode/tasks.json` (fusion de la tache watchdog) et `Rapport de dysfonctionnement et correction/`.
- **Supervision extension** : `orchestrator-monitor` demarre et supervise le watchdog au `activate()` (respawn avec backoff) quand le workspace contient le skill.

## 9. Exigences non fonctionnelles

- Rust-first ; JS limite au pont IDE et aux workers ; PowerShell limite au watchdog.
- Migrations additives uniquement (`ALTER TABLE`, `CREATE TABLE IF NOT EXISTS`) via `ensure_schema()` dans `with_db`.
- Fail-closed : aucun chemin ne permet `completed` sans preuve ; aucun dispatch sans provider actif + capabilities.
- Observabilite : chaque refus/bascule/alerte ecrit un event (`comms.jsonl` et/ou watchdog JSONL).
- Process MCP stale : les gates n'ont d'effet qu'apres recyclage des process `hphe-mcp.exe` (incident 05) — le deploiement impose une rotation des sessions MCP.
