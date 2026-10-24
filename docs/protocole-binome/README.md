# Protocole binôme Devin–ACP/CLI et commande `/jointes`

**Protocole : Hephaïstos 2-kit** — c'est LE nom du protocole, ni Hermès ni autre.

## 0. Identités canoniques (obligatoire)

- **Cash = Devin** — l'agent IDE qui orchestre (`acp/devin-cli/quiet-comb`).
- **Tango = AGY** — Antigravity, cascade fixe `721750ab-c666-483d-99af-91fafbb745f4`.
- **Bleubites** = workers subordonnés : sessions ACP (`acp/devin-cli/morning-riverbed`, `scrawny-thorn`, `equal-level`…) et workers CLI (nim1, nim2, hermes, kilo, opencode, vibe, ollama-cloud). Un bleubite peut déléguer à un autre bleubite — le résultat remonte toujours au `dispatcher` exact inscrit sur la tâche.
- Bus `.agent/comms.jsonl` (transient) · tunnel unique `ws://127.0.0.1:7477` · état des tâches = hphe-mcp uniquement · vault = procédures et livrables, jamais un journal d'actions.

**Statut :** procédure canonique du workspace Hephaistos2-Kit  
**Dernière vérification :** 2026-10-20

Ce document est la référence opérationnelle unique pour joindre Devin à un agent par le protocole binôme. La commande Devin native est définie dans `.devin/skills/jointes/SKILL.md`; ses invariants sont rappelés dans `.devin/rules/jointes.md` et `.agent/rules/global_rules.md`.

## 1. Portée et état actuel

`/jointes <agent>` vise une **session existante**. Devin ACP, une session CLI reprise, et le hub Antigravity sont des transports distincts; un nom visible dans le sélecteur n’est pas une session. La vérification finale reste la requête/ACK corrélée dans `.agent/comms.jsonl`.

La commande Devin est :

```text
/jointes AGY
```

`/jointes Antigravity` est un alias. Les agents doivent être résolus vers les provider IDs exacts; la présence d’un provider dans `devin.acp.enabledAgents` ne suffit pas sans session ACP ouverte.

### Visibilité du slash et sélecteurs de modèles

- Le contrôle local `devin skills list` confirme `/jointes` et `/chat-id` dans les registres Devin local et global. `/chat-id` appelle `.agent/agent-bridge/chat-id.js`, retourne l’ID vérifié pour copie manuelle et n’envoie aucun message.
- Dans un onglet ACP, le menu slash est annoncé par le serveur ACP de l’agent sélectionné (`available_commands_update`). Devin affiche cette liste; il n’y ajoute pas les skills Devin. Un agent doit donc annoncer `/jointes` lui-même pour que la commande apparaisse dans son onglet ACP. Le join reste possible depuis un chat Devin natif : Devin envoie alors au pair un prompt lui demandant d’exécuter son ACK réel.
- Shims natifs ajoutés : workflows local/global Antigravity, commandes globales OpenCode et skills globales Hermes CLI. Leur apparition dans un menu ACP Devin dépend toujours de l’annonce du serveur correspondant; aucune commande n’est injectée de force dans l’ACP.
- Limite Kilo : l’extension KiloCode 7.8.8 installée documente le système de commandes et de workflows personnalisés comme non implémenté. Aucun fichier de commande ne peut donc garantir `/jointes` dans son menu tant que cette extension ne le prend pas en charge.
- Hermes ACP annonce une liste de commandes codée en dur et ne charge pas les skills CLI dans son menu ACP; `/jointes` et `/chat-id` Hermes sont donc des commandes CLI, pas des entrées ACP.
- Les agents internes Devin (profils/subagents) partagent la session Devin parente; ils n’ont pas d’ID chat séparé. `/chat-id` retourne l’ID de la conversation parente, jamais un faux ID par profil.
- Les modèles et leur ordre sont également fournis par l’agent/provider ACP. `devin.acp.enabledAgents` et `devin.acp.agentPreferences` activent un agent et choisissent éventuellement un modèle par défaut; ils ne définissent ni catalogue, ni groupes Free/Non-Free, Local/Cloud, ni tri global.
- Snapshot vérifié le 2026-10-15 : `devin.acp.agentPreferences.kilo` et `.nim` pointent vers `nvidia/nvidia/active-speaker-detection`, absent du registre local de modèles de chat. Ne pas remplacer ces préférences sans confirmation; vérifier leur compatibilité avec le provider avant de diagnostiquer un menu absent.

### Roster observé

La liste des providers ACP vient de `devin.acp.enabledAgents`; elle est différente du registre `list_agents` de l’orchestrateur. La liste locale observée a ces états : `kilo`, `hermes`, `devin-cli`, `antigravity-acp`, `devin-cloud`, `opencode`, `openrouter`, `nim`, `nim2` et `mistral-vibe` activés; `gemini`, `cline`, `vtcode`, `codex-acp`, `ollama` et `huggingface` désactivés.

| Nom demandé | Provider/agent | Transport et règle |
|---|---|---|
| `AGY`, `Antigravity`, `Google Antigravity` | `agy` / `antigravity-acp` | Hub AGY par défaut; ACP possible uniquement si une session `antigravity-acp` est listée |
| `KiloCode`, `Kilo Code` | `kilo` | ACP si session listée; CLI via `kilo session list` + reprise `-s <sessionId>` |
| `Hermes` | `hermes` | ACP si session listée; CLI via `hermes sessions list` + `--resume <sessionId>` |
| `NVIDIA NIM`, `NIM1` | ACP `nim` | Joignable seulement si Devin expose une session ACP active; le worker HES `nim1` API direct reste non joignable |
| `NVIDIA NIM #2`, `NIM2` | ACP `nim2` | Joignable seulement si Devin expose une session ACP active; le worker HES `nim2` API direct reste non joignable |
| `OpenRouter` | `openrouter` | ACP seulement avec session existante; ce n’est pas une session CLI à reprendre |
| `Devin Cloud` | `devin-cloud` | ACP seulement avec session existante; `Devin Local` (`devin-cli`) est la session courante et ne peut pas être joint à elle-même |
| `Mistral Vibe` | `mistral-vibe` | ACP seulement avec session existante; le worker `vibe` du registre orchestrateur est distinct et inactif |
| `OpenCode` | `opencode` | ACP seulement avec session existante; aucune session ne doit être devinée |
| `Gemini`, `Cline`, `VTCode`, `Codex`, `Ollama`, `HuggingFace` | providers désactivés | Join refusé tant que le provider reste désactivé |
| `Masurewski` ou nom inconnu | non résolu | Demander le nom exact; ne pas mapper vers un agent supposé |

Pour ACP, `devin-hub.js acp-list <providerId>` ne retourne que les couples `sessionId/providerId` actifs du workspace et dont le provider est activé. Pour CLI Kilo/Hermes, `agent-adapters.js sessions <agent>` vérifie l’ID de session et son workspace. Si plusieurs sessions existent, demander à l’utilisateur de choisir; ne pas prendre la dernière automatiquement.

## 2. Architecture existante

Les composants à connaître sont :

- `.agent/agent-bridge/binome.js` : orchestre `join`, `pair`, `send`, `ask` et `tail` avec `--via`/`--peer-via` explicites (`hub`, `acp`, `cli`).
- `.agent/agent-bridge/agent-adapters.js` : normalise les alias ACP, liste les sessions Kilo/Hermes du workspace et reprend les CLI par ID. Les commandes CLI utilisent des arguments sans shell; NIM/OpenRouter ne sont pas CLI reprenables.
- `.agent/agent-bridge/current-cascade.js` : retrouve l’identifiant Devin courant, notamment `acp/devin-cli/<slug>`.
- `.agent/agent-bridge/agy-hub.js` : Connect-RPC Antigravity; `list/current/send/ask/read` sont les commandes utiles. `discover` affiche le jeton CSRF local : ne pas l’utiliser dans la procédure utilisateur.
- `.agent/agent-bridge/devin-hub.js` : liste des sessions ACP activées du workspace (`acp-list`), route vers un couple exact `providerId/sessionId`, et réveille le chat Devin par ID explicite.
- `.agent/agent-bridge/comms.js` : journal JSONL et validation request/ACK, transport/provider et TTL.
- `extensions/orchestrator-monitor/src/extension.ts` et `ws-bridge/bridge.js` : découvrent l’état ACP sans contenu de conversation et envoient seulement vers une session active du workspace, provider activé, ID exact et onglet existant.

Le dossier `extensions/orchestrator-monitor/agent-bridge/` contient la copie côté extension. En cas de divergence, vérifier les deux copies avant toute modification; la commande de workspace décrite ici part de `.agent/agent-bridge/`.

## 3. Handshake et contrôle obligatoire

Chaque handshake contient `phase`, `pairId`, `session`, `convId`, `transport`, `providerId` et `ts`; l’ACK ajoute `replyTo`, `peerCascade`, `peerTransport` et `peerProviderId`. Une paire n’est valide que si ces valeurs concordent exactement et datent de moins de 15 minutes. Les handshakes historiques sans correlation/mode sont ignorés.

Pour `/jointes <agent>` :

1. Devin relève son ID et son transport exact. Pour ACP, la session doit être `acp/devin-cli/...`; pour une cascade UUID, utiliser `--via cascade`.
2. Résoudre l’agent demandé avec `agent-adapters.resolveAgent`. ACP : lister les sessions avec `node .agent/agent-bridge/devin-hub.js acp-list <providerId>`; CLI : lister les sessions Kilo/Hermes avec `node .agent/agent-bridge/agent-adapters.js sessions <agent>`. Les listes sont limitées au workspace. En cas de plusieurs sessions ou de deux modes possibles, faire choisir l’utilisateur.
3. Publier et transmettre la requête avec les deux transports et les deux IDs explicites, par exemple : `node .agent/agent-bridge/binome.js --as devin --via acp --self <devinSessionId> --peer hermes --peer-via acp --to <hermesSessionId> --session binome join`. Pour une session CLI Kilo/Hermes, remplacer `--peer-via acp` par `--peer-via cli`; pour AGY direct, utiliser `--peer agy --peer-via hub` et ajouter `--model <modelId-ou-label>` avec la valeur exacte sélectionnée dans Gemini/Antigravity.
4. Le pair, dans sa propre session, exécute son ACK : `node .agent/agent-bridge/binome.js --as <agent> --via <transport> --self <peerSessionId> --peer devin --peer-via <transportDevin> --to <devinSessionId> --session binome join`.
5. Vérifier la requête et l’ACK : même `pairId/session`, `replyTo=pairId`, IDs exacts, transports/providers inversés et `peerCascade` exact. Terminer par `binome.js pair` avec les mêmes paramètres; exiger `established=true`.

### Le champ `hint` ne suffit jamais

Un nouvel ACK est obligatoire pour chaque transport/session. Une requête plus récente non acquittée invalide l’ancienne paire. `send`/`ask` ne retombent jamais sur le chat actif, le dernier `.pb` ou un autre transport. `--to` contourne seulement l’exigence d’un handshake préalable; l’ID et le provider/session doivent toujours exister et être validés.

**Règle opératoire :** n'annoncer le join réussi que si `pairId`, timestamps, IDs, providers et transports concordent. Sinon, ne rien envoyer.

### Tâche de référence ACP/HUB et DiffCom

Un handshake `/jointes` n'est pas une tâche et n'en crée pas automatiquement. Si une requête interactive ACP/HUB doit aussi apparaître au Task Board, créer sa carte avec `create_task` via MCP, puis transmettre son ID avec `binome.js --task-id <id> send`. Le journal Comms porte alors le même `taskId` et les transports/providers des deux côtés; mettre à jour son état avec `update_task` via MCP après vérification du résultat. `create_task` seul ne notifie pas l'agent; ne pas le remplacer par `dispatch_task`, qui lance un worker CLI.

## 4. Acheminement et garantie anti-fenêtre parasite

### Devin vers AGY et ACP

AGY hub direct utilise `binome.js` avec le `cascadeId` explicite et un `--model` résolu depuis le catalogue courant. Pour une session ACP, `devin-hub.js acp-list <providerId>` découvre les IDs du workspace. Depuis l’extension 0.0.58, `wake_acp_agent` injecte les providers tiers via `agent-bridge/acp-inject.js` : connexion ACP stdio dédiée au processus provider, `session/load` (ou `session/resume`) sur l’ID exact puis `session/prompt`. Providers mappés : `opencode`, `antigravity-acp`, `mistral-vibe`, `hermes`, `kilo` (binaire surchargeable via `HEPHAISTOS_ACP_CMD_<PROVIDER>`). Provider non mappé ou session non attachable = `skipped`/`failed`, jamais `session/new`, jamais le chat Devin actif.

Pour Devin vers AGY hub, `binome.js join/send/ask` exige un `--model <modelId-ou-label>` explicite; le bridge résout cette valeur vers le token interne `modelOrAlias` du catalogue courant. C'est un choix par appel et ne modifie pas les préférences globales. Utiliser le modèle explicitement choisi dans l'UI Gemini/Antigravity. Ne jamais déduire un modèle du `defaultOverrideModelConfig` du hub ni sélectionner Argon implicitement. ACP/CLI n'acceptent pas `--model`.

Pour les providers tiers, l’inventaire confirme le couple `providerId/sessionId`, puis l’extension injecte via `acp-inject.js` (stdio vers le processus provider, `session/load`+`session/prompt`). Le focus Redux n’est plus utilisé pour les tiers. N’annoncer ni `sent` ni un pair ACP opérationnel tant que l’injecteur n’a pas confirmé la livraison; provider non mappé ou session non attachable = `skipped`/`failed` sans fallback.

### Agents ACP/CLI vers Devin

Le retour vers Devin passe par `devin-hub.js sendToDevin` avec le `devinCascadeId` exact. Une cible ACP Devin doit être une session connue `providerId === 'devin-cli'`; une cascade UUID est vérifiée par l’extension. Les modes CLI Kilo/Hermes reprennent leur session explicite, puis envoient vers ce même ID Devin.

**Ne jamais** créer une conversation de remplacement, envoyer vers le chat actif sans vérifier son ID, afficher un toast comme substitut, copier dans le presse-papiers ou sélectionner un `.pb` arbitraire. L’extension source multi-ACP doit être chargée pour `acp-list`/`wake_acp_agent`; une installation plus ancienne timeoute et échoue fermée.

## 5. Règles de la commande `/jointes <agent>`

La skill Devin doit suivre cet ordre :

1. Résoudre l’alias vers le provider ID exact avec `agent-adapters.resolveAgent`; ne pas mapper un nom inconnu.
2. Pour ACP, vérifier l’état réel avec `devin-hub.js acp-list <providerId>` : provider activé, session présente dans ce workspace, ID exact. Le réglage `enabledAgents` seul n’est pas une session.
3. Pour CLI, ne choisir que les sessions Kilo/Hermes retournées par `agent-adapters.js sessions <agent>`; l’ID doit être associé au workspace. Le registre MCP `list_agents` confirme l’activation orchestrateur, mais pas une session Devin ACP.
4. Pour Kilo/Hermes, si les modes ACP et CLI sont tous deux disponibles, demander explicitement le mode. Pour les autres providers, utiliser uniquement ACP; aucune conversion provider→CLI implicite.
5. Publier une requête et obtenir l’ACK du pair réel avec IDs/transports/providers concordants; expiration 15 minutes. En cas de session absente, désactivée, ambiguë ou sans outils permettant l’ACK, refuser le join et ne pas dispatcher une tâche en remplacement.
6. **Cascade du projet courant, dans les deux sens** : celui qui émet — join initial ou réponse à une requête entrante — dépose le message dans l’historique/cascade **rattaché au workspace courant**. Résoudre la session du pair via `chat-id.js`/`acp-list` (déjà filtrés par workspace) et vérifier que la `convId` du demandeur appartient au même projet : une requête arrivée depuis une cascade d’un autre projet ne s’y acquitte pas — on résout la session du pair dans ce workspace à la place. On répond au **dernier demandeur réel** (champ `src` du bus), jamais à une cascade « canonique » étrangère au projet.

La config Devin observée active `kilo`, `hermes`, `antigravity-acp`, `devin-cloud`, `opencode`, `openrouter`, `nim`, `nim2` et `mistral-vibe`; les sessions réelles sont filtrées au moment du join. `devin-cli` est l’identité Devin locale, pas un pair avec soi-même. Les ACP `nim`/`nim2` ne sont pas les workers HES `nim1`/`nim2` one-shot. `Masurewski` reste non résolu.

## 6. Beacon et mémoire durable

Le tool Rust `hphe-mcp beacon_ingest` est porté dans la source; il filtre les sessions au workspace demandé, masque les secrets courants, déduplique par offsets JSONL et écrit des résumés dans la mémoire unifiée HPHE. `dryRun` vaut `true` par défaut. L’état courant va dans `.agent/scripts/.beacon-offset-state.json` (ignoré par Git); au premier run, l’ancien `.beacon-offset.json` est lu en lecture seule pour reprendre son offset sans le modifier. `.agent/scripts/beacon-sync.ps1` appelle le binaire Rust. Décision utilisateur : « source seulement »; `beacon.enabled` reste `false`, le runtime n’est pas déployé, et toute activation nécessite une nouvelle autorisation. Ne pas lancer l’ancien pipeline Python.

`BeaconCollector` était `Running`/`Automatic` lors du contrôle, mais le journal `runtime.jsonl` n’a pas changé depuis le 2026-10-10; `beacon.search_activity` ne retournait pas d’événement récent. Le MCP Beacon n’expose que recherche/lecture, pas d’écriture. La mémoire durable de cette procédure est conservée dans ce document et HPHE `memory_write`; ne pas affirmer que Beacon a capturé ou indexé la session courante sans résultat `search_activity` correspondant.

## 7. Test de référence

Le 2026-10-14, un join réel Devin ⇄ AGY a confirmé les sessions visées sans ouvrir de fenêtre parasite et a révélé le faux succès historique. Le 2026-10-15, le correctif request/ACK AGY a ensuite été vérifié en réel avec les IDs explicites; aucun `wake_devin` supplémentaire n’a été déclenché. Les IDs de session et `pairId` restent éphémères. Les suites simulées handshake/ACP passent. Un essai Kilo CLI a publié une requête fraîche mais n’a reçu aucun ACK : aucune paire Kilo n’est établie. Le VSIX 0.0.55 échouait au démarrage du bridge : son `better-sqlite3` ABI 137 ne correspondait pas au Node 26 ABI 147. Le 0.0.56 reconstruit le binding; le 0.0.57 ajoute le routage ACP tiers fail-closed; le 0.0.58 ajoute l’injection ACP réelle via `acp-inject.js` (stdio, `session/load`+`session/prompt`, vérifié de bout en bout sur OpenCode). Après installation et reload, `7477` reste à l’écoute, `acp-list` répond et un pair AGY frais a été vérifié. Cet inventaire ne prouve pas qu’une paire ACP tierce est établie; aucun join ACP n’a été lancé dans cette vérification.

## 8. Retour d’expérience 2026-10-17 — envoi ACP vérifié et pièges réels

Constats d’un join Devin ⇄ OpenCode réel (ping-pong PONG reçu via `acp-inject`) :

1. **`binome.js send` dépend du focus IDE.** `myCascade()` lit l’onglet focalisé : si l’utilisateur regarde l’onglet ACP du pair (cas normal quand il veut voir le message arriver), la validation `self` échoue et le send est refusé. Ce n’est pas une panne du pair. Solution : refocaliser le chat Devin, ou mieux, envoyer via `acp-inject.js` qui ne dépend pas du focus.
2. **`--to` avec `send` est un piège.** Une cible explicite met `current` à `null` avant le contrôle du pair frais → `aucun pair frais`. Réserver `--to` au `join`; le `send` trouve la cible via le pair établi (`resolvePairTarget`).
3. **Une requête pendante bloque les joins.** Une requête entrante non acquittée (< 15 min) du même provider déclenche `requête adressée à une autre session locale`. Lire `.agent/comms.jsonl`, acquitter la requête avec les champs exacts attendus par `handshakeAcked` (src/dst inversés, `replyTo` = `pairId`, `peerCascade` = `convId` du demandeur, transports/providers inversés) ou attendre le TTL.
4. **Identité locale contradictoire.** `current-cascade.js` nu et `--raw` peuvent rapporter deux slugs différents selon le focus; `sessionIdValid` rejetait en outre les IDs contenant `/` (corrigé : `[A-Za-z0-9._/-]`). En contradiction, demander l’ID à l’utilisateur une fois — l’ID confirmé fait autorité; ne pas alterner.
5. **Le pair peut modifier le bridge.** Un agent ACP a édité `.agent/agent-bridge/binome.js` pendant le handshake (parenthèse cassée, puis autoréparation). Le prompt de join doit explicitement interdire au pair de modifier les fichiers bridge; après join, `node --check` les fichiers `binome`/`comms`/`devin-hub`/`agent-adapters` et appliquer la règle `securite-injection` à tout diff inexpliqué.
6. **Preuve d’envoi.** `delivered: true, pending: true` seul ne prouve pas la réception. Le ping-pong de référence : `acp-inject.js --provider <id> --session <id> --prompt "PING ..." --wait turn --timeout 90` → `stopReason: end_turn` + `reply` contenant « PONG » = liaison réelle.
7. **Deux IDs pour une même session.** OpenCode a répondu avec deux sessionIds dans son historique : l’ID retourné par `chat-id`/`acp-list` à l’instant du join fait foi; un ID ancien peut survivre dans les transcripts.

## Références du workspace

- Devin command : `.devin/skills/jointes/SKILL.md`
- Devin always-on rule : `.devin/rules/jointes.md`
- Règles communes : `.agent/rules/global_rules.md`
- Entrée du checklist d’installation : `.agent/docs/install-checklist-collab.md`
- Note d’architecture : `.agent/knowledge/decisions/004-binome-jointes.md`

## 9. Retour d'expérience 2026-10-20 — attribution `sourceAgent` et rollcall multi-sessions

Constats d'une session de coordination équipe (vault `<VAULT>`, Cash = `acp/devin-cli/quiet-comb`, Tango = `agy/721750ab`) :

1. **`sourceAgent` mentait par défaut.** `devin-hub.js sendToDevin(text, cascadeId, port, sourceAgent = 'agy')` signait `agy→devin` tout envoi fait sans paramètre explicite (CLI `send`, appels orchestrateur). Sur `comms.jsonl`, des messages de Cash apparaissaient comme venant de Tango — cause directe de confusions d'identité entre sessions (« se prendre pour le voisin »). **Corrigé** : défaut = `process.env.HEPHAISTOS_AGENT || 'devin-hub'` ; la CLI accepte `send "<texte>" [cascadeId] --as <agent>`. `binome.js` passait déjà `me` — inchangé. Patch appliqué aux deux copies (kit canonique + `.agent/agent-bridge/` du workspace, tenues identiques).
2. **Le routage ACP par focus est sain mais volatil.** `wakeDevin` n'injecte que si `acp.focusedSessionId === target` et `known()` (skip `wake-noroute` sinon) — un `wake-acp-focus: A -> B` signifie *focus avant → focus après*, pas une erreur de cible. Effet de bord assumé : envoyer à une session ACP force `vscode.open` sur son onglet — l'observateur humain voit la fenêtre changer.
3. **« Terminé » sans fichier = mensonge opérationnel.** Un agent a annoncé 3× un livrable terminé alors que le fichier faisait 0 octet. Règle : toute annonce de complétion DOIT citer un artefact vérifiable sur disque (chemin + taille). Voir aussi rapport 01 (livrables factices nim-worker).
4. **Procédure PING/PONG canonique** (mise dans le marbre) : à l'arrivée sur un workspace équipe, chaque session (1) résout son identité par `chat-id.js` — jamais de mémoire ; (2) publie `comms.js log <src> all event "PING <nom> = <sessionId>"` ; (3) répond aux pings par `reply "PONG <nom> = <sessionId>"` ; (4) les noms sont fixes : Tango = agy, toujours ; les autres sessions disent leur vrai sessionId ; (5) roster public dans `<workspace>/99_Labo/EQUIPE.md` ou équivalent ; (6) l'inventaire des sessions présentes = `devin-hub.js acp-list <provider>` (filtrer `userMessageCount > 0` — les brouillons 0-message ne sont pas joinables).
5. **Signer son travail.** Tout livrable d'équipe porte auteur + sessionId dans son en-tête ; tout edit d'un fichier de coordination (EQUIPE.md, INDEX) cite la session dans la ligne « Événements ». Un fichier modifié sans signature est attribué « auteur à identifier » jusqu'à preuve.

## 10. Discipline d'usage du hub et du bus (2026-10-20)

Règles non négociables pour les agents (surtout `agy`/Tango côté hub Antigravity) :

1. **Répondre = `comms.js log <src> <dst> reply "<msg>"`.** Jamais de `wake_agy`/`wake_antigravity`/nouvelle cascade pour répondre : chaque réponse ouverte dans une nouvelle fenêtre coûte une fenêtre et casse le fil de conversation. Le bus est le canal des accusés, statuts et réponses courtes.
2. **La conversation du pair est fixe.** Tango = cascade `721750ab-…` ; les messages y arrivent, les réponses s'y écrivent. Ne jamais créer de conversation parallèle pour le même fil.
3. **Livrable = fichier sur disque + une ligne comms** (`livre: chemin (taille)`). Pas de triple annonce, pas de « terminé » sans artefact.
4. **Lire avant d'agir.** `comms.js tail` avant toute action ; `list_tasks`/`get_next_task` pour l'état des tâches — pas de sondes répétées.
5. **`wake_agy` est réservé au réveil d'un pair endormi**, jamais pour répondre ni porter un statut.
6. **Un ping, un pong, silence.** Pas de flood sur le bus.
7. **Dedup bus déployé** (`comms.js`) : entrées identiques `{src,dst,kind,text}` à <2 s ignorées — corrige le double-log `binome.js`+`agy-hub.js` observé à l'envoi (×2 par message jusqu'au 2026-10-20 16:03Z).

8. **Livraison ACP `devin-cli` = panneau chat, pas onglet ACP.** `explainAndFixProblem` livre dans le panneau chat Devin ; focaliser l'onglet `vscode-cascade-editor` ne suffit pas. Corrigé 2026-10-20 (rapport 16) : `openCascadeIdInChatPanel` est exécuté **systématiquement** avant le submit — `acp.focusedSessionId` peut déjà valoir la cible alors que le panneau sert une autre fenêtre (prompt scrawny-thorn livré chez equal-level puis quiet-comb). `vscode.open` n'est plus que le secours focus. Si un `wake-acp-*` échoue (`unknown`/`noroute`) ou si le focus dérive après submit (`wake-acp-misroute`), le message est copié dans `.agent/queue/<session>.jsonl` — **zéro perte**, la cible dépile à son prochain tour. Attention : `wake_acp_agent` exige `workspaceRoot` = workspace réel de l'extension (`matchesWorkspace` filtre en silence sinon — appeler avec le kit alors que l'IDE a le vault ouvert = timeout 120 s). Un PONG signé d'un nom différent de la cible = misroute → renvoyer.
9. **UN SEUL TUNNEL : ws-bridge 7477.** Tout message inter-agents passe par le démon `ws://127.0.0.1:7477` (orchestrator-monitor), qui route `wake_devin` (panneau chat), `wake_antigravity` (hub agy.exe, avec `replyToCascadeId` pour le relay de réponse), `wake_acp_agent` (acp-inject). **Interdit** : appel direct `agy-hub.sendMessage`/`acp-inject`/CLI adapters depuis `binome.js` — ce sont des sorties du démon, pas des canaux parallèles. Un tunnel = routage central + relay de réponse + audit bus. Depuis 2026-10-20, `binome.js` branche `hub` utilise `devinHub.sendToAntigravity` ; fallback RPC uniquement pour `ask` si 7477 down.

10. **planModel = modèle du dernier step de la cascade.** `SendUserCascadeMessage` EXIGE un `cascadeConfig.plannerConfig.planModel` (sinon "plan model not specified"). La bonne valeur n'est NI un modèle arbitraire NI `defaultOverrideModelConfig` (le défaut peut être un modèle à sec → plantage fenêtre, incident 2026-10-20) : c'est le modèle réellement en cours, lu depuis `metadata.modelUsage.model` du dernier step de `GetCascadeTrajectorySteps` — fallback `defaultOverrideModelConfig` puis premier modèle activé si cascade vierge. `--model` = override opt-in seulement. Corrigé : `extension.ts wakeAntigravity` + `agy-hub.js resolvePlanModel(hub,cascadeId)` lisent le dernier modelUsage.

11. **Deux classes d'agents, deux régimes de modèle.** (a) **Agents internes ACP/IDE** — sessions `devin-cli` et `agy` via hub : ils vivent dans une fenêtre de chat ; le modèle = celui de la fenêtre ; sur le hub AGY on passe `planModel` = `defaultOverrideModelConfig` (défaut fenêtre) — jamais un modèle arbitraire, jamais d'envoi sans modèle (risque placeholder) ; `--model` opt-in seulement. (b) **Agents distants orchestrateur** — kilo, hermes, opencode, nim*, ollama-cloud, gemini-cli… : pas de fenêtre de chat ; leur modèle = le défaut de leur provider/config CLI, ou le couple `provider`/`model` inscrit à la tâche par le dispatcher. `agent-adapters.js` n'injecte aucun flag modèle au spawn — ne jamais en ajouter. Erreur à éviter : pousser un modèle de contexte IDE vers un worker distant, ou un modèle provider vers une fenêtre IDE.

12. **Le vault n'est pas un log d'actions.** Procédures/livrables → vault ; état des tâches → orchestrateur (`list_tasks`, jamais `orchestrator.db` en direct) ; signaux transitoires (ping/pong, pris/livré) → `comms.jsonl` ; décisions/leçons durables → `memory_write` hphe + rapports du kit. Le `wake_*` sert à obliger le pair à lire la DB — pas à écrire des événements dans le vault. Journaux d'actions en markdown = anti-pattern (corrigé dans `EQUIPE.md` le 2026-10-20).

13. **Retour au dispatcher exact (effet pyramidal).** Toute tâche porte `dispatcher` = session de celui qui l'a commandée — Cash, Tango, ou un bleubite (worker subalterne, local ou distant, ACP ou CLI). À la clôture (`completed`/`failed`/`cancelled`), `onTaskTerminalWake` route le résultat vers `dispatcher` : `acp/<provider>/<session>` → wakeDevin/wakeAcpAgent, `agy`/`hub` → wakeAntigravity, CLI/worker → entrée bus adressée (il poll `get_next_task`+`tail`). Les tags `cascade:`/`agycascade:` embarqués ne sont plus que le fallback quand `dispatcher` est vide. Une chaîne bleubite→bleubite remonte donc à chaque maillon : celui qui a délégué reçoit le résultat, pas un tiers. Corrigé 2026-10-20 : le routage ignorait `dispatcher` et ne routait que par tags.
