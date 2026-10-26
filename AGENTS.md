# AGENTS.md — Hephaistos2-Kit (mandat obligatoire)

Toute session agent ouverte dans ce workspace (CLI : `kilo run`, `hermes -z`, `opencode run` ; ACP : Devin, AGY ; local ou cloud) DOIT appliquer ces règles avant toute action.

## 1. Architecture canonique

Lire et appliquer `.agent/ARCHITECTURE.md` — le serveur MCP unifié **`Hephaistos-everything-search`** (`hphe-mcp.exe`, stdio) est le point d'entrée unique. Les anciens serveurs `qdrant`, `zvec`, `agentmemory`, `orchestrator`, `nim-router`, `model-discovery` sont **absorbés/désactivés** — ne jamais les référencer.

## 2. Recherche Hephaistos-first (obligatoire)

- Fichier à localiser → `everything_search` / `search_files` (index NTFS $MFT instantané).
- Contenu/symbole (`code`, `file`, `bug`, `test`) → `content_search` (BM25) puis `semantic_search` / `hybrid_search`.
- Souvenir/contexte → `memory_search` ; fallback → `hybrid_search` → `sqlite-node`.
- **Interdiction formelle** des scans récursifs lents (`Get-ChildItem -Recurse`, `find`, `dir /s`) pour la découverte de fichiers.
- Si le serveur MCP n'est pas branché, fallback CLI : `node "$env:USERPROFILE/.config/devin/scripts/mcp-call.mjs" Hephaistos-everything-search everything_search '{"query":"<terme>"}'`.
- Ne jamais ré-introduire `grep`/`rg`/lectures exhaustives en guise de recherche de fichiers — les lectures ciblées de fichiers déjà localisés restent permises.

## 3. Orchestrateur unique

Toute création/dispatch/mise à jour de tâche passe par les outils `hphe-mcp` (`dispatch_task`, `create_task`, `update_task`, `list_tasks`, `get_next_task`). Jamais d'accès direct à `orchestrator.db`, jamais de worker spawné hors orchestrateur.

**Polling obligatoire** : `create_task` ne notifie PAS l'agent. Chaque agent DOIT vérifier sa file (`list_tasks` filtré sur son `assigned_to`, état `pending`) au démarrage de session ET périodiquement. Sur Windows, la tâche planifiée `hphe-taskwatch` (installée par `install.ps1 -Elevated`) poll toutes les 5 min et pousse `task-notify` sur `comms.jsonl` + inject ACP pour `devin` — elle complète le polling, ne le remplace pas.

## 4. Règles locales

`.agent/rules/global_rules.md` fait foi pour tout le reste (binôme, discipline, rapports de dysfonctionnement dans `Rapport de dysfonctionnement et correction/`).

## 4bis. Protocole Hephaïstos 2-kit — identités

**Cash = Devin** (`acp/devin-cli/quiet-comb`) · **Tango = AGY** (Antigravity, cascade `721750ab-…`) · **Bleubites** = workers ACP/CLI subordonnés. Résultat de tâche → `dispatcher` exact. Bus `.agent/comms.jsonl`, tunnel `ws://127.0.0.1:7477`.

## 5. Auto-connaissance Cursor IDE

Questions sur **Cursor** (UI, raccourcis, extensions, MCP, skills, rules, CLI, cloud agents) : ne pas inventer. Consulter le mirror Obsidian `Documentation/Cursor/` (skill `.agent/skills/cursor-ide-docs/`) ou `content_search` sur ce dossier. Resync : `scripts/sync-cursor-official-docs.ps1`.

## 4ter. Roster de workspace — SWAT de base

Les fenêtres/conversations d'agents du workspace sont déclarées dans `.agent/workspace-roster.json` (miroir canonique : `memory team/roster` hphe-mcp). Au démarrage ou après crash : `node .agent/agent-bridge/workspace-roster.js status` pour l'état live, `restore` pour rouvrir les panneaux Bleubites via `open_chat` (réutilisation, jamais de doublon), `ping --write` pour le PING/PONG de vérification et la persistance. Une session persistée n'est pas une fenêtre ouverte ; ne jamais créer de conversation de remplacement.

## 4quater. Schéma actif & dispatching SWAT obligatoire (gravé dans le marbre)

À chaque nouvelle requête nécessitant une orchestration ou une livraison (code, test, revue, audit, commit/push, doc) :
1. **Détection du schéma actif** : lire impérativement `.agent/workspace-roster.json` (`roster.workflow.activeSchema` et `activeSchemaId`). Le schéma actif affiché dans l'espace de travail React Flow est la **vérité obligatoire**. L'agent DOIT calquer son plan d'exécution sur ce schéma, ses nœuds, ses rôles et ses compétences.
2. **Fallback sans consigne explicite** : si aucun schéma n'est actif (`activeSchemaId` absent), interroger `listSchemas` et adopter automatiquement le schéma de workspace le plus adapté (ex. `swat-orchestrateur` pour un cycle complet, `swat-fix-rapide` pour un correctif urgent).
3. **Dispatch formel via l'orchestrateur hphe-mcp** : interdiction formelle d'exécuter un workflow uniquement en simulation textuelle ou en simples commandes shell. Toute tâche déléguée d'un nœud SWAT doit être matérialisée par `create_task` / `dispatch_task` et close par `update_task` sur `Hephaistos-everything-search`.

