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

## Réattribution dynamique des Bleubites (providers + modèles)

- **Commande canonique** à lancer AVANT chaque mission SWAT et APRES chaque changement de roster/provider :
  `node .agent/scripts/swat-bind.mjs --name <schema>` (ex. `--name swat-obsidian`). Équivalent API bridge : `POST http://127.0.0.1:7478/swat/bind` `{ "name": "<schema>" }` (token `ws-bridge` habituel).
- Toujours faire `--dry` d'abord pour inspecter les bindings (provider + model + modelFixed par rôle).
- Le script attribue workers ET modèles **à l'usage** : pool = membres `chat-*` du roster ∩ sessions ouvertes, un provider distinct par rôle selon la chaîne `provider_prefs` (orchestrator.db), rotation persistée dans `.agent/state/swat-bind.json`.
- Modèles tirés des catalogues **live** : `available_models` hphe-mcp (ex-model-discovery) + `GET /v1/models` pour omniroute/groq/xai ; cache `.agent/state/model-catalog.json` (TTL 5 min). Un modèle hors catalogue est réparé à l'attribution (`modelFixed: true`).
- Providers pilotables par acp-server : `nim, nim2, omniroute, ollama, openrouter, groq` (DRIVABLE ; `devin-cli`/`antigravity-acp` exclus — identités ACP, pas des Bleubites interchangeables). Le provider `grok` (api.x.ai direct) est retire — team sans credits ; Grok se consomme via les modeles omniroute `pol/grok`, `pol/grok-large`, `pollinations/grok`, `pollinations/grok-large` (necessitent une clef pollinations gratuite dans OMNIROUTE, sinon 401).
- OmniRoute : privilégier les canaux gratuits vérifiés (`groq/`, `cf/`, `cloudflare-ai/`, `ddgw/`, `openrouter/*:free`) ; `auto/*`, `gemini/`, `mistral/` BYOK et les image/vidéo sont exclus (cf. `OMNI_CHANNEL_RANK`/`OMNI_BAD` dans le script).
- Ne JAMAIS binder pendant un run actif (`/swat/bind` refuse si une mission tourne — évite `Schema modifie pendant le run`).
- Knobs : `SWAT_BIND_ROTATE_MODELS=1` force la rotation des modèles même valides ; `SWAT_BIND_PROVIDERS` restreint le set ; `SWAT_BIND_CATALOG_TTL_MS` ajuste le cache.

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
- Orchestration de workflows n8n : `lister_workflows` → `GET :7478/n8n/workflows` (inventaire via l'API n8n serveur-side, clé `N8N_API_KEY` ou `.agent/n8n-api.key` gitignorée ; renvoie id, nom, triggers, webhookPath, `callable`, `callableContract`). `executer_workflow` → `POST :7478/n8n/workflows/{workflowId}/invoke` — allowlist serveur `N8N_CALLABLE_WORKFLOWS` dans `bridge-api.mjs`, le secret webhook reste côté passerelle ; non-allowlisté → 403 ; chaque appel tracé (`kind: workflow-invoke`). Ne jamais invoquer un workflow à effets externes (Telegram, mail) sans demande explicite.
- Outils MCP (`mcp_hephaistos`) : passerelle `supergateway` sur `http://127.0.0.1:8767/mcp` (stdio → Streamable HTTP devant le shim mcp-mux). 14 outils exposés : recherches (`everything_search`, `content_search`, `hybrid_search`, `semantic_search`, `memory_search`, `hphe_health`) + orchestrateur (`list_agents`, `agent_status`, `suggest_agent`, `list_tasks`, `get_next_task`, `create_task`, `dispatch_task`, `update_task`). Pérennisée au démarrage via `Startup\hphe-mcp-gateway.vbs` → `.agent\scripts\hphe-mcp-gateway.cmd` (relance manuelle : exécuter le `.cmd` ; log `.agent/mcp-gateway.log`). Loopback sans auth — comme hphe-rest.
- L'agent exécute la version **publiée** du workflow (`workflow_history`), pas le brouillon `workflow_entity.nodes` — tout patch DB doit viser les deux. Le paramètre requis `{missionId}` dans l'URL rend un test isolé du nœud outil impossible (`PartialExecutionToolExecutor` → `Required at missionId` est attendu).
- Après modification du bridge, redémarrer `hphe-bridge-api` ; après publication CLI d'un webhook, redémarrer n8n.

## Missions SWAT Telegram

- Schema `swat-telegram` (`schema-mvr09niq-8yor8`) : entry `acp/devin-cli` Orchestrateur-Flux + workers `chat-*` Redacteur-Telegram puis Relecteur-Modo (verdict `GO` + texte final). Les Bleubites n'ont que des outils fs_* : **aucun worker ne peut envoyer** — l'envoi est fait par n8n apres la mission.
- Workflow `Hephaistos2-Kit - Telegram SWAT` (`Z07C5VZbpHaSwdxn`), source `.agent/agent-bridge/n8n-telegram-swat-workflow.json`. Entree `POST /webhook/hephaistos-telegram` (Header Auth `Hephaistos Bridge`), contrat `{instruction|text, chat?, missionId?}` — pipeline : bind `swat-telegram` -> mission `hephaistos-swat-missions` -> verdict GO/NO-GO du Relecteur -> envoi via `swat-telegram-hub` seulement si GO.
- Envoi unique : `SWAT - Telegram Hub` (`RAp6qBCMGOcauYmK`, webhook `swat-telegram-hub`) route `action` (send/send-file/image/pin/unpin/poll/delete/edit/admins/members/stats/chat/topics/history/read/search/updates) + `chat` parametrable vers le proxy `:5680`. Les workflows `SWAT - Telegram Post` et `SWAT - Telegram Image` sont desactives — sous-ensembles en dur du Hub, ne pas les reactiver.
- Pont CLI : `node .agent/flux/telegram.mjs <action> [--chat X] [--text T]` (chemin `swat-telegram-hub` par defaut, override `N8N_TELEGRAM_PATH`).
- Commandes `/` du bot `Moi_Hermes_bot` (menu ~60 commandes expose) : inventaire via `node .agent/flux/telegram-commands.mjs [--json]` ; invocation via `action:botcmd` du Hub. **Le nom "Hermes" du bot est une persona Telegram — il n'est PAS gere par l'application `hermes.exe`.**

## Bot Hermes — workflow n8n (repondeur + taches de groupe)

- Workflow `Hephaistos2-Kit - Hermes Bot` (`BJFnZVJpzQxQKCb6`), source `.agent/agent-bridge/n8n-hermes-bot-workflow.json` — gere le bot `Moi_Hermes_bot` **sans l'application Hermes** : trigger 20 s -> `POST :7478/tg/poll` (route bridge : mutex + dedup `message_id` persistant dans `.agent/state/tg-seen.json`, appelle `updates --json` en interne — consomme l'offset `getUpdates`) -> `Router messages` (ignore les messages du bot, filtre `from` + Telegram n'echo pas les envois du bot) -> `Mode ?` (switch : `llm` | `hub` | fallback `send`).
- Questions libres -> **noeud AI Agent** (`@n8n/n8n-nodes-langchain.agent` v3.1, persona Hermes) + **OpenAI Chat Model** branche sur la credential `OmniRoute (env)` (`4IwKxCZi0dRMavS5`, `http://127.0.0.1:20128/v1`, modele `groq/openai/gpt-oss-120b`, route free). Erreur agent -> fallback `POST :7478/llm` (bridge : chaine `provider_prefs` — nim2 > nim > omniroute > ollama... — clefs lues cote serveur, jamais dans le workflow).
- **Outils MCP** : noeud `MCP Hephaistos` (`mcpClientTool`, SSE `http://127.0.0.1:8400/sse`) expose a l'agent les outils selectionnes `memory_search`, `memory_read`, `memory_write` + recherches Hephaistos — la memoire unifiee `agentmemory` est donc accessible au bot (projectId `caverne` impose par le prompt ; les ecrits sont verifies dans `F:\Sqlite-DB\agentmemory\caverne\agentmemory\data.json`). Passerelle : `supergateway` stdio `hphe-mcp.exe` -> SSE, durable via tache planifiee `hphe-mcp-sse` (script `.agent/scripts/hphe-mcp-sse.cmd`, log `%USERPROFILE%\.n8n\hphe-mcp-sse.log`). Second noeud `MCP Beacon (mux)` (`mcpClientTool`, `httpStreamable` -> `http://127.0.0.1:8767/mcp`, passerelle `.agent/scripts/hphe-mcp-gateway.cmd`) : whitelist lecture seule `beacon__search_memory/get_memory/get_memory_context/search_activity/summarize_activity/get_activity_event/list_activity_filters/candidates_list` — aucun outil d'ecriture du mux (kaggle/rea/puppeteer) n'est expose au bot de groupe.
- **Memoire session** : `Memoire session` (`memoryBufferWindow` v1.4, `sessionIdType: customKey`, cle par chat+auteur Telegram) pour le court terme ; la memoire unifiee passe par les outils MCP.
- Taches de groupe : slash `/poll Q | A | B` `/membres` `/admins` `/stats` `/topics` ET **langage naturel deterministe** (Router, pas de LLM -> pas d'hallucination) : « liste les membres », « admins », « stats », « derniers messages », « infos du groupe » -> `Action Hub` ; « epingle ca » / « desepingle ca » / « supprime ca » **en reponse** a un message -> `pin`/`unpin`/`delete` (champ `reply_to` = id entier). Outil `actions_telegram` (`toolWorkflow` -> sous-workflow `TGtoolb35e356f1a35`) expose a l'agent : poll, image, send-file, read, history, search, chatinfo, members, admins, stats, topics — jamais pin/unpin/delete/edit (reserves au canal reponse+admin). Whitelist + `chat` force a `caverne` dans `Valider action`.
- **ACL** : `from_id` Telegram (ajoute a `_norm` du CLI, source `C:\Program Files\servers\cli-anything-telegram\...`) identifie l'expediteur ; `ADMIN_IDS={630047399}` (Ibn lascard, createur) dans le Router + prompt — moderation et `memory_write` reserves a l'admin, refus poli sinon. Les actions `pin`/`unpin`/`delete`/`edit` du Hub exigent `--id` (et `--yes` pour delete) ; elles echoueront tant que `Moi_Hermes_bot` n'est pas admin du groupe avec les droits correspondants (a accorder dans Telegram par le createur).
- **Un seul consommateur `updates` a la fois** — `getUpdates` consomme l'offset cote serveur : ne jamais lancer un autre poller (ex : `.agent/flux/telegram-respond.legacy.mjs`, DEPRECATED) en parallele, sinon il vole les messages du workflow. Le poll passe uniquement par `/tg/poll` (le mutex du bridge serialise les fires concurrents du trigger, cause des doubles reponses corrigee). `getWorkflowStaticData` n'est PAS disponible dans le sandbox Code de cette version n8n — le dedup vit dans le bridge.

## Vérifications diagnostic, worker NIM et passerelle native

- `.env` doit être UTF-8 : un commentaire Windows-1252 peut faire échouer l'import de `webdriver_manager`/`python-dotenv` et empêcher le démarrage du connecteur Colab. Une réparation d'encodage conserve une sauvegarde ignorée par Git et ne journalise aucune valeur.
- Un chemin cité dans un prompt n'est pas un contrat de livrable. Pour une tâche formelle, seul `expected_artifact` autorise la destination du worker NIM ; contrôler le confinement avant toute écriture. Lire et clôturer les tâches via les outils canoniques, jamais par SQLite direct.
- Régression JS : `node --test .agent/scripts/nim-worker-contract.test.mjs .agent/agent-bridge/diagnostics.test.mjs .agent/agent-bridge/bridge-api-swat.test.mjs .agent/agent-bridge/binome-handshake.test.cjs`.
- Depuis `hphe/` : `cargo test -p hphe-kit --lib` et `cargo test -p hphe-mcp --bin hphe-rest`. Compilation native : `cargo build --release -p hphe-mcp --bin hphe-mcp --bin hphe-rest`.
- La sonde REST utilise une connexion IPC distincte et bornée pour ne pas attendre le verrou des requêtes normales. Les processus MCP stdio déjà ouverts conservent leur ancien code après remplacement de l'exécutable : distinguer installation sur disque et rechargement des clients persistants.
- Une erreur Google `401 deleted_client` signifie que le client OAuth a été supprimé côté Google. Réparer un encodage local ou relancer l'authentification ne restaure pas ce client ; ne jamais présenter ces actions comme une réparation OAuth.

## Audit SWAT — comment verifier l'usage reel

- `GET /swat` (bridge, Bearer) : schema actif, graphe workers, digest.
- `GET /swat/audit?limit=N` : dernier etat par mission (state, roles, taskIds) — source `.agent/comms.jsonl` (`swat-status`).
- `GET /missions/<missionId>` : etat detaille d'une mission (live ou dernier etat persiste).
- `POST /tools/call` `list_tasks` : chaque etape SWAT = tache orchestrateur tracee (jamais d'acces direct a `orchestrator.db`).
- Rapports : `.agent/reports/diagnostic-*-final.json` ; execs n8n : `execution_entity` par workflowId.
- Garde-fous du runner : schema non actif = 409, worker non `chat-*` refuse, divergence roster/session = erreur, digest modifie = abort, une seule mission a la fois, pas de rejeu post-restart.
- Healthcheck (`hphe-architecture-healthcheck`, 5 min) -> transition non-ok -> declenche le diagnostic SWAT via `hephaistos-diagnostic-async`.
- 2026-11-16 : purge de 61 taches failed/cancelled via `delete_task` (canal MCP) ; `swatTool` maxBuffer porte a 16 Mo (la sonde `orchestrator-task-state` debordait a ~2,7 Mo). Publication n8n : la version executee suit `activeVersionId` + `workflow_published_version`, pas `versionId` seul ; un node webhook sans champ `webhookId` est enregistre sous un chemin prefixe.
## Concile SWAT (mode council)

- Graphe `mode: council` (schema-mvpjbchn-ijt6c) : chairman = `acp/devin-cli/ionian-helicopter` (non injectable : l'appelant synthetise), 6 membres `chat-*` (Premiers-Principes, Expansionniste, Executeur, Empirique, Contrariant, Outsider).
- `POST /swat/start` accepte tout schema du catalogue (`schemaGraphFor`) — pas seulement le schema actif. Missions paralleles autorisees si aucune session worker en commun (collision -> 409). Avec le schema council : run auto-pilote — ronde 1 parallele (reponses isolees), ronde 2 parallele (peer-review anonymisee Membre A-F), puis `phase: done`. `wait` (ms, max 600000) bloque la reponse HTTP jusqu'au resultat.
- `/swat/next` et `/swat/step` refusent les runs council ; suivi via `GET /missions/:id` -> `council.replies`, `council.reviews`, `council.chairmanPrompt` (prompt de synthese pret pour le chairman).
- Parallelisme : `acp-inject` accepte `lockKey` (lock par session, pas par provider). Echec membre tolere ; moins de 3 reponses ronde 1 = mission failed.
- Workflow n8n `Hephaistos2-Kit - Concile SWAT` (`hpheConcileSwat`) : `POST /webhook/hphe-concile` (headerAuth) `{question|objective, missionId?, wait?}` -> `POST /swat/start` (wait<=540000) -> renvoie le missionStatus complet. Re-POST avec le meme missionId = poll (replay). Export : `.agent/agent-bridge/n8n-concile-workflow.json`.
- Insertion manuelle n8n : un workflow actif exige `workflow_entity.active=1` + `activeVersionId` + `workflow_published_version` + `workflow_history` (versionId doit exister la, sinon 'no activeVersion nodes') + `webhook_entity` (avec `webhookId` du node) + `shared_workflow`.
