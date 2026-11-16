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

## Livraison des extensions — VSIX obligatoire

Dans ce projet, les extensions utilisées sont installées depuis un **VSIX**. Modifier les sources ou compiler ne met PAS à jour l’extension active. Ne jamais supposer une jonction vers les sources.

Pour chaque correction d’extension destinée à l’utilisateur :
1. Identifier l’IDE cible et vérifier la version réellement installée avant intervention.
2. Incrémenter la version du `package.json` et synchroniser le lockfile, sans créer automatiquement de commit ni de tag.
3. Exécuter la compilation et les tests pertinents, puis générer un VSIX portant cette version. Exclure les anciens VSIX et leurs archives du paquet.
4. Installer ce VSIX dans l’IDE réellement utilisé. Pour Devin Desktop : `devin-desktop --install-extension "<chemin-du-vsix>"` ; ne pas utiliser par défaut le CLI d’un autre IDE.
5. Vérifier la version déployée avec `devin-desktop --list-extensions --show-versions` (ou l’équivalent de l’IDE cible).
6. Recharger l’extension/la fenêtre pour activer la nouvelle version. Si ce rechargement ne peut pas être effectué par l’agent, le dire explicitement et indiquer `Developer: Reload Window` ; ne jamais prétendre qu’il a eu lieu.
7. Vérifier le comportement corrigé dans l’interface après rechargement. Les tests automatisés ne prouvent ni l’activation de la nouvelle version ni le résultat du clic utilisateur.

Le compte rendu distingue obligatoirement : **sources modifiées**, **tests passés**, **VSIX généré**, **version installée vérifiée**, **rechargement effectué ou restant**, **validation dans l’interface effectuée ou restante**. Toute étape bloquée ou restante doit être annoncée ; ne pas présenter une compilation seule comme une livraison terminée. Aucun commit/push sans demande.

## 5. Auto-connaissance Cursor IDE

Questions sur **Cursor** (UI, raccourcis, extensions, MCP, skills, rules, CLI, cloud agents) : ne pas inventer. Consulter le mirror Obsidian `Documentation/Cursor/` (skill `.agent/skills/cursor-ide-docs/`) ou `content_search` sur ce dossier. Resync : `scripts/sync-cursor-official-docs.ps1`.

## 4ter. Roster de workspace — SWAT de base

Les fenêtres/conversations d'agents du workspace sont déclarées dans `.agent/workspace-roster.json` (miroir canonique : `memory team/roster` hphe-mcp). Au démarrage ou après crash : `node .agent/agent-bridge/workspace-roster.js status` pour l'état live, `restore` pour rouvrir les panneaux Bleubites via `open_chat` (réutilisation, jamais de doublon), `ping --write` pour le PING/PONG de vérification et la persistance. Une session persistée n'est pas une fenêtre ouverte ; ne jamais créer de conversation de remplacement.

## 4quater. Schéma actif & dispatching SWAT obligatoire (gravé dans le marbre)

À chaque nouvelle requête nécessitant une orchestration ou une livraison (code, test, revue, audit, commit/push, doc) :
1. **Détection du schéma actif** : lire impérativement `.agent/workspace-roster.json` (`roster.workflow.activeSchema` et `activeSchemaId`). Le schéma actif affiché dans l'espace de travail React Flow est la **vérité obligatoire**. L'agent DOIT calquer son plan d'exécution sur ce schéma, ses nœuds, ses rôles et ses compétences.
2. **Fallback sans consigne explicite** : si aucun schéma n'est actif (`activeSchemaId` absent), interroger `listSchemas` et adopter automatiquement le schéma de workspace le plus adapté (ex. `swat-orchestrateur` pour un cycle complet, `swat-fix-rapide` pour un correctif urgent).
3. **Dispatch formel via l'orchestrateur hphe-mcp** : interdiction formelle d'exécuter un workflow uniquement en simulation textuelle ou en simples commandes shell. Toute tâche déléguée d'un nœud SWAT doit être matérialisée par `create_task` / `dispatch_task` et close par `update_task` sur `Hephaistos-everything-search`.

## Diagnostic Hephaistos2-Kit

- SWAT `swat-diagnostic-hephaistos` : schema `schema-mwi80bsc-5frlh`, quatre workers dedies (Runtime-Comms, Roster-Identites, Architecture, Synthese). Selectionner explicitement ce schema avant lancement ; un changement de schema pendant le run provoque un arret, jamais un fallback.
- Workflow n8n `hpheDiagnosticSwat`, nom `Hephaistos2-Kit - diagnostic architecture`, source `.agent/agent-bridge/n8n-diagnostic-workflow.json`. Webhook authentifie `POST /webhook/hephaistos-diagnostic` sur n8n, credential `Hephaistos Bridge`.
- Sondes et rapports : `.agent/agent-bridge/diagnostics.mjs`, preuves et analyses separees dans `.agent/reports/diagnostic-<uuid>-final.json`. Les verdicts mesures ne peuvent pas etre remplaces par une opinion agent. Execution SWAT completed ne signifie pas architecture healthy.
- Tests : `node --test .agent/agent-bridge/diagnostics.test.mjs .agent/agent-bridge/bridge-api-swat.test.mjs`. Les versions installees ne prouvent pas le rechargement ou le comportement GUI. Les contraintes donnees aux agents ne constituent pas une sandbox.

## Missions SWAT dynamiques dans n8n

- Workflow existant : `vyvBFDvUdt1hcFl9`, source `.agent/agent-bridge/n8n-swat-workflow.json`. Mettre à jour cet ID, ne pas multiplier les imports anonymes.
- Entrée publiée : `POST http://127.0.0.1:5678/webhook/hephaistos-swat-missions`, Header Auth via la credential `Hephaistos Bridge`. Ne jamais écrire son secret dans un workflow ou un exemple.
- Contrat : `missionId` unique et stable pour les retries, `swatId` exact, `objective`, `inputs`, `constraints`, `expectedDeliverable`. L'exemple manuel est distinct de l'entrée dynamique.
- Catalogue canonique : `GET http://127.0.0.1:7478/swats`. Suivi authentifié : `GET /missions/<missionId>` sur la même passerelle. Historique des états : événements `swat-status` corrélés dans `.agent/comms.jsonl`.
- Le runner lit le schéma actif et ses dépendances ; `swatId` différent du schéma actif est refusé. Sélectionner explicitement le schéma via les outils du roster ou l'extension, jamais de fallback ni de remplacement de session. Support actuel : graphes acycliques avec workers `chat-*` existants, pas les conciles ni les workers ACP natifs.
- `constraints` est une consigne transmise aux agents, pas un sandbox ni une autorisation d'action destructive. Une réponse textuelle et un état `completed` ne prouvent pas qu'un artefact demandé existe.
- Vérification : `node --test .agent/agent-bridge/bridge-api-swat.test.mjs`, puis mission réelle par Webhook avec contrôle du résultat et des IDs de tâches. Le CLI `n8n execute --id=...` choisit le trigger de sous-workflow sans données si présent : un rejet de mission vide est attendu, pas un test manuel complet.
- Après modification du bridge, redémarrer sa tâche `hphe-bridge-api` hors exécution. Après import/publication CLI d'un Webhook, n8n doit être redémarré pour charger les routes publiées. Ne pas prétendre à une validation UI sur la seule base de tests CLI/HTTP.

## Agent IA n8n (passerelle conversationnelle)

- Workflow `sy2KbjC2J9Xy52oj`, nom `Hephaistos2-Kit - Agent IA n8n`, source `.agent/agent-bridge/n8n-agent-workflow.json`. Agent enregistré : `n8n-agent-ia` (orchestrateur, type service).
- Entrée canonique : **`POST http://127.0.0.1:7478/agent` `{prompt}`** — façade de la bridge, auth = token `ws-bridge` habituel ; l'auth n8n est injectée côté passerelle et chaque appel est tracé dans `comms.jsonl` (`kind: agent-call`). Entrée directe : `POST http://127.0.0.1:5678/webhook/hephaistos-agent` (Header Auth `Hephaistos Bridge`).
- Outils de consultation : `catalogue_swats`, `statut_mission` (`missionId` exact requis), `lancer_diagnostic` (prérequis : schéma actif `swat-diagnostic-hephaistos`), `lister_sessions` (fenêtres ACP ouvertes).
- Outils d'action (sur demande explicite uniquement) : `lancer_mission` → webhook `hephaistos-swat-missions` qui pilote la mission de bout en bout (`/swat/start` + boucle `/swat/next`), `interroger_agent` → `/ask`, `reveiller_agent` → `/wake`. Le schéma dédié `swat-action-directe` (`schema-mwiivx72-r74a4`) n'emploie que des workers `chat-*` — les nœuds `acp/*` natifs hors entry font échouer le runner (`Transport worker non pris en charge`).
- Outils MCP (`mcp_hephaistos`) : passerelle `supergateway` sur `http://127.0.0.1:8767/mcp` (stdio → Streamable HTTP devant le shim mcp-mux). 14 outils exposés : recherches (`everything_search`, `content_search`, `hybrid_search`, `semantic_search`, `memory_search`, `hphe_health`) + orchestrateur (`list_agents`, `agent_status`, `suggest_agent`, `list_tasks`, `get_next_task`, `create_task`, `dispatch_task`, `update_task`). Pérennisée au démarrage via `Startup\hphe-mcp-gateway.vbs` → `.agent\scripts\hphe-mcp-gateway.cmd` (relance manuelle : exécuter le `.cmd` ; log `.agent/mcp-gateway.log`). Loopback sans auth — comme hphe-rest.
- L'agent exécute la version **publiée** du workflow (`workflow_history`), pas le brouillon `workflow_entity.nodes` — tout patch DB doit viser les deux. Le paramètre requis `{missionId}` dans l'URL rend un test isolé du nœud outil impossible (`PartialExecutionToolExecutor` → `Required at missionId` est attendu).
- Après modification du bridge, redémarrer `hphe-bridge-api` ; après publication CLI d'un webhook, redémarrer n8n.

## Vérifications diagnostic, worker NIM et passerelle native

- `.env` doit être UTF-8 : un commentaire Windows-1252 peut faire échouer l'import de `webdriver_manager`/`python-dotenv` et empêcher le démarrage du connecteur Colab. Une réparation d'encodage conserve une sauvegarde ignorée par Git et ne journalise aucune valeur.
- Un chemin cité dans un prompt n'est pas un contrat de livrable. Pour une tâche formelle, seul `expected_artifact` autorise la destination du worker NIM ; contrôler le confinement avant toute écriture. Lire et clôturer les tâches via les outils canoniques, jamais par SQLite direct.
- Régression JS : `node --test .agent/scripts/nim-worker-contract.test.mjs .agent/agent-bridge/diagnostics.test.mjs .agent/agent-bridge/bridge-api-swat.test.mjs .agent/agent-bridge/binome-handshake.test.cjs`.
- Depuis `hphe/` : `cargo test -p hphe-kit --lib` et `cargo test -p hphe-mcp --bin hphe-rest`. Compilation native : `cargo build --release -p hphe-mcp --bin hphe-mcp --bin hphe-rest`.
- La sonde REST utilise une connexion IPC distincte et bornée pour ne pas attendre le verrou des requêtes normales. Les processus MCP stdio déjà ouverts conservent leur ancien code après remplacement de l'exécutable : distinguer installation sur disque et rechargement des clients persistants.
- Une erreur Google `401 deleted_client` signifie que le client OAuth a été supprimé côté Google. Réparer un encodage local ou relancer l'authentification ne restaure pas ce client ; ne jamais présenter ces actions comme une réparation OAuth.

