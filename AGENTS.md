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


## 4quinquies. Visibilité des chats Bleubites — GRAVÉ DANS LE MARBRE (2026-11-04)

**Le webview hephaistos-chats ne surveille que `workspaceFolders[0]/.agent/chats/sessions.json`.** Une injection ACP est un client stdio séparé : elle écrit le store, exécute les outils, mais ne notifie PAS le panneau ouvert. Conséquences obligatoires :

1. **Toujours injecter depuis le workspace qui possède les sessions** (`--cwd C:/data-sys/hephaistos2-kit`) — un inject depuis un autre root échoue `session introuvable`.
2. **Synchroniser le store vers le workspace où l'utilisateur regarde** : `node .agent/scripts/sync-sessions.mjs` (watcher fs, debounce 250 ms, miroir sessions.json src → dst).
3. **Rendu** : si le panneau n'affiche rien après sync → `workspace-roster.js restore` (réouverture = rechargement depuis le disque).
4. Preuve de livraison = `delivered:true` + fichier écrit + ligne bus `comms.jsonl` — jamais la déclaration du modèle ni le silence du panneau.

## 4sexies. Sub-agents internes INTERDITS — GRAVÉ DANS LE MARBRE (2026-11-05)

**Il est INTERDIT à Devin de lancer ses propres sub-agents (`run_subagent`, `subagent_*`, ou tout équivalent interne/invisible) sauf demande EXPLICITE de l'utilisateur.**

1. **Toute exécution déléguée visible** passe par les Bleubites : fenêtres `hephaistos-chats` (inject via `acp-inject.js --provider hephaistos`, sessions résolues par `.agent/workspace-roster.json`) ou par l'orchestrateur `hphe-mcp` (`dispatch_task` pour les workers CLI).
2. **Un sub-agent interne est invisible** pour l'utilisateur : rien dans les chats, rien sur le bus, aucune preuve observable. C'est une violation de la règle de livraison vérifiable.
3. **Concils inclus** : les advisors sont les sessions Bleubites de `.agent/council/advisors.json` via `.agent/council/supervise.mjs` — jamais des sub-agents.
4. En cas de besoin d'un sub-agent interne → demander l'autorisation explicitement, ne jamais l'assumer.

## 🪟 VISIBILITÉ DU CONCILE SWAT & HEPHAISTOS-CHATS (GRAVÉ DANS LE MARBRE - 2026-11-12)
- Le webview Hephaistos-Chats surveille EXCLUSIVEMENT `workspaceFolders[0]/.agent/chats/sessions.json`.
- En cas de non-affichage des actions d'un agent dans sa fenêtre respective :
  1. Synchroniser immédiatement `sessions.json` depuis le workspace maître (`C:/data-sys/hephaistos2-kit/.agent/chats/sessions.json` -> `.agent/chats/sessions.json`).
  2. S'assurer que `.agent/agent-bridge/node_modules` est rattaché par jonction NTFS vers `C:/data-sys/hephaistos2-kit/.agent/agent-bridge/node_modules`.
  3. Exécuter impérativement `node .agent/agent-bridge/workspace-roster.js restore` pour forcer le rechargement des webviews existantes (aucun doublon de chat).
  4. Lancer le miroir automatique en arrière-plan : `node .agent/scripts/sync-sessions.mjs`.
  5. Preuve de fonctionnement = sessions.json écrit + statut `open-requested` sur chaque session dans le retour du roster.
