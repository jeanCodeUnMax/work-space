# Concil LLM — Transcript complet

**Date** : 2026-11-05
**Mode** : sub-agents Devin (5 advisors → 5 peer-reviews anonymisés → chairman Devin)

## Question brute

> « realise un concil sur comment obliger un orchestrator a suivre/engeuler/pousser/obliger ses agents »

## Question cadrée (contexte Hephaistos2-Kit)

Orchestrateur unique `hphe-mcp` (58 outils MCP, stdio) : `create_task`/`dispatch_task`/`update_task`/`list_tasks`/`get_next_task` sur `orchestrator.db`. Workers = CLI (kilo, hermes, opencode, omniroute) + chats ACP « Bleubites ». Lois gravées : canal unique infra = hphe-mcp ; routeur unique = orchestrateur ; aucun worker hors orchestrateur ; pas d'accès direct SQLite.
État : `create_task` ne notifie PAS l'agent → polling obligatoire, complété par `hphe-taskwatch` (5 min, task-notify sur `.agent/comms.jsonl` + inject ACP devin). `dispatch_task` spawne réellement le CLI. Preuve = `delivered:true` + fichier écrit + ligne bus. Hub `ws://127.0.0.1:7477`, roster `workspace-roster.json`.
Problème : agents oublient de poller, stagnent en `pending`, déclarent des succès non vérifiés, s'auto-dispatchent.
**Question** : quels mécanismes FORCENT les agents à suivre / exécuter / prouver / rendre compte — push, relances automatiques, vérification, escalade — sans violer la loi du canal unique ?

---

## Réponses des conseillers

### Contrarian (Response C)

Le vrai défaut : ce système repose sur l'obéissance d'agents dont on sait déjà qu'ils désobéissent. Empiler des mécanismes de forcing ne change rien si le forçage transite par les mêmes agents défaillants.
1. **La preuve de livraison est auto-signée.** `delivered:true`, fichier, ligne bus — les trois sont produits par le worker. Un menteur écrit un stub et coche les cases. La preuve doit être émise par l'orchestrateur (hash d'artefact, test de validation côté serveur).
2. **Le push n'existe pas.** hphe-mcp est stdio : on ne pousse pas vers un processus mort. `task-notify` sur comms.jsonl reste un fichier à poller — le polling est déplacé, pas supprimé. Seul `dispatch_task` a un levier : processus fils surveillable (exit code, artefacts). Les tâches `create_task` resteront orphelines.
3. **Relances automatiques = fork bomb.** `dispatch_task` spawne de vrais CLIs ; boucle mal bornée + timeout = N processus brûlant des tokens. Dead-letter après 2 relances, puis escalade — jamais de 3ᵉ engueulade.
4. **Escalade vers qui ?** Vers devin/AGY — mêmes LLMs, mêmes oublis. Il faut une sortie vers l'humain (notification OS), pas une ligne jsonl de plus.
5. **« Aucun worker hors orchestrateur » est une règle markdown, pas un mécanisme.** Tant que c'est une consigne et non une capacité refusée (écriture tâches réservée, credentials scopés), ce sera violé.
6. **Canal unique = SPOF.** hphe-mcp down ou orchestrator.db lockée : plus de forcing — et interdiction d'inspecter la base. Qui surveille `hphe-taskwatch` ?
Recommandation : l'orchestrateur détient tout le cycle de vie (spawn → watchdog → exit code → validation serveur), relances bornées, escalade hors-boucle. Le reste est du théâtre de conformité.

### First Principles Thinker (Response E)

Vous posez la mauvaise question. « Forcer » un LLM = anthropomorphisme : un agent n'a ni mémoire durable ni conscience du devoir — on ne discipline pas un processus éphémère, on conçoit un système où sa fiabilité n'a pas d'importance. Bonne question : *comment rendre la déclaration de l'agent sans valeur, et le fait observable tout-puissant ?*
Une tâche n'est pas un message, c'est un **bail (lease)** : TTL + heartbeat + transition conditionnée à une preuve. Le code l'a déjà à moitié : `verify_expected_artifact` (orch.rs:483) refuse `completed` sans fichier non vide postérieur au dispatch ; `task_heartbeat` + `reconcile_dead_tasks` fauchent les workers gelés >600 s. **Le vrai défaut : tout cela est optionnel** — `expected_artifact` nullable, heartbeat au bon vouloir du wrapper, ACP encore sur polling.
Trois corrections structurelles, zéro « engueulade » :
1. **Gate obligatoire** : `create_task` sans `expected_artifact` vérifiable → rejeté.
2. **Bail expirant universel** : `assigned`/`in_progress` sans heartbeat → `failed` puis **redispatch automatique** vers un autre worker. L'escalade n'est pas un rappel moral, c'est un requeue.
3. **Autorité, pas règles** : auto-dispatch bloqué par ACL (`dispatch_task` réservé à devin/agy), pas par des phrases dans un prompt.
La fiabilité émerge quand mentir coûte plus cher que livrer.

### Expansionist (Response B)

Ce n'est pas une couche de discipline — c'est le kernel d'un agent OS, et les primitives existent : `watchdog.ps1` détecte stale/critical/pending_stale + wake ACP ; `discipline_agent`/`agent_status` maintiennent un score /100 (probation <80, quarantaine <50, euthanasia <20 + flag `active`) ; `supervise.mjs` fait dispatch→verify→failover. Pièce manquante = boucle fermée : brancher alertes watchdog → `discipline_agent` transforme chaque anomalie en conséquence automatique.
Coup de génie : **le score comme variable de routage** — `provider_prefs` + score disciplinaire = marché de réputation ; les bons mangent, les euthanized sont reroutés. Plus besoin d'engueulade : l'économie le fait.
Livraison : `expected_artifact` existe → rendre `update_task(completed)` contractuel (refus sans artefact vérifié mtime/hash + heartbeat) — le « succès déclaré non vérifié » devient techniquement impossible.
Adjacent caché : euthanized → respawn = flotte auto-réparatrice auto-scalée ; table discipline → KG → routing prédictif ; dead-letter → `flux/telegram.mjs` = escalade humaine. Vous livrez un scheduler de processus pour agents.

### Outsider (Response A)

Vous avez construit une file où le travailleur doit *se souvenir* d'aller chercher du travail. Aucune queue normale ne marche ainsi (SQS, Celery, cuisine de restaurant) : on pousse le travail, ou le worker reste branché en permanence. Le polling « n'oubliez pas » est une rustine sur un défaut de conception.
Bizarre : `create_task` ne notifie pas alors que `dispatch_task` sait spawner. **Fusionnez** : toute création passe par le chemin qui notifie/spawne. L'agent qui « oublie de poller » disparaît par construction.
« Engueuler » une machine ? On lui enlève la possibilité d'échouer silencieusement : heartbeat obligatoire → tâche reprise, timeout de visibilité, retry, réassignation, escalade humaine en dernier. `hphe-taskwatch` = embryon à généraliser en lease/heartbeat **dans l'orchestrateur** (respecte le canal unique).
Preuve : ne jamais croire la déclaration — le livrable vérifiable (fichier + hash + test) EST la preuve, vérifiée avant clôture. Rendez la triche structurellement impossible.

### Executor (Response D)

80 % de la machine existe — le chantier c'est du câblage, pas du neuf.
**Jour 1 — watchdog acteur** (zéro Rust). `watchdog.ps1` détecte tout mais reste « observe et alerte ». Ajouter un moteur de nudges via `Invoke-McpJson` (canal unique intact) :
- **Push pending** : inject ACP câblé en dur sur `devin` (watchdog.ps1:491) → généraliser : résolution de session via `workspace-roster.json` pour Bleubites (`acp-inject.js`), `dispatch_task` pour CLI (vrai push = spawn).
- **Échelle de relance** (`nudge_count` dans `watch-state.json`) : nudge → nudge+`discipline_agent -10` → `update_task failed` → `dispatch_task` re-route (`pick_agent_by_skill`, circuit breaker FR-07) → rapport `Rapport de dysfonctionnement et correction/` + alerte humain bus.
**Jour 2 — preuve.** FR-05 (`expected_artifact`) et FR-06 (`verify_spawned`) existent si déclarés → watchdog re-vérifie tout `completed` : artefact absent ou ligne bus manquante → `update_task in_progress` + sanction.
**Jour 3 — auto-dispatch.** Colonne `dispatcher` : toute tâche dont dispatcher ∉ {devin, agy, orchestrateur} → `discipline_agent` + annulation.
Heartbeat/reaper (FR-08, reconcile 60 s, rest.rs:283) tourne déjà. Plus tard : 4ᵉ passe reconcile pour `pending` assignée > N min. On commence par UN fichier : `watchdog.ps1`.

---

## Peer reviews (anonymisation : A=Outsider, B=Expansionist, C=Contrarian, D=Executor, E=FirstPrinciples)

### Review 1 (lens contrarian)
- Plus forte : **C** — seule à démonter la prémisse (forcer via les mêmes agents = boucle), preuves auto-signées, push impossible sur stdio, escalade interne bouclant, canal unique = SPOF. B seconde (connaissance code, boucle fermée) mais optimiste.
- Angle mort : **D** — vérifie fichiers/bus que le worker peut fabriquer ; suppose l'inject ACP Bleubites fonctionnel ; qui surveille le watchdog ?
- Tous ont raté : **fencing/idempotence** — worker « mort » juste lent → deux processus sur la même tâche, concurrence sur artefact/bus. Il faut des **fencing tokens** (epoch par dispatch, rejet des écritures d'epoch périmé).

### Review 2 (lens first-principles)
- Plus forte : **C** — véritable first-principles, falsifie les prémisses. D (plan 3 jours) et E (lease+gate+ACL) excellents compléments.
- Angle mort : **A** — théorie générique de queues ; heartbeat/reaper/artifact existent déjà ; « fusionner create/dispatch » ne réveille pas une session ACP morte.
- Tous ont raté : existence ≠ correction (artefact non vide peut être faux → **validation sémantique** : tests, revue) ; agent = conversation éphémère (redispatch vers session close inutile) ; **idempotence des effets de bord** (commits/pushes dupliqués).

### Review 3 (lens expansionist)
- Plus forte : **B** — expansionniste ET ancrée code (discipline_agent, provider_prefs, expected_artifact) : marché de réputation, flotte auto-réparatrice = upside maximal.
- Angle mort : **A** — « fusionner create/dispatch » impossible pour les Bleubites ACP (sessions stdio déjà ouvertes, non spawnables).
- Tous ont raté : **fencing/epoch** (zombie réassigné qui écrase l'artefact du remplaçant) ; **effets de bord non-fichiers** (git push, appels API : ni vérifiables ni annulables → clés d'idempotence, transactions compensables) ; **budget tokens** des respawns en boucle.

### Review 4 (lens outsider)
- Plus forte : **C** — falsifie les prémisses ; preuves produites par le suspect. E meilleure synthèse mais moins incisive.
- Angle mort : **B** — marché de réputation sur entrées corrompues : si les preuves sont falsifiables, les scores le sont → routage qui récompense les tricheurs.
- Tous ont raté : **résurrection tardive** (worker « mort » qui écrit après redispatch → fencing tokens) ; effets idempotents ; **test d'acceptation défini à `create_task` par le dispatcher, jamais par le worker**.

### Review 5 (lens executor — vérification code effectuée)
Claims vérifiés dans `hphe-kit/src/orch.rs` et `watchdog.ps1` : `verify_expected_artifact` (l.483, optionnel), `reconcile_dead_tasks` + heartbeat 600 s (l.1973), seuils discipline (l.1795), `watchdog.ps1:491` câblé sur devin, **aucune ACL sur `dispatch_task`** — tous exacts.
- Plus forte : **D** — seule exécutable lundi : chemins/lignes précis, 3 jours, zéro Rust, canal unique respecté. B brillante stratégiquement mais c'est un chantier.
- Angle mort : **A** — « pousser le travail » impossible vers ACP ; ignore heartbeat/reaper/gate existants.
- Tous ont raté : **test par injection de faute** (tuer un worker, vérifier reap→redispatch→preuve) ; métriques pour calibrer les seuils ; **idempotence** des re-dispatchs.

---

## Synthèse du Chairman

### Où le concil est d'accord
- **La discipline morale est un leurre** : on ne « force » pas un LLM, on rend la triche structurellement impossible (convergence C+E+A). La bonne question : rendre la déclaration sans valeur, le fait observable tout-puissant.
- **La preuve doit être émise côté serveur**, jamais auto-signée par le vérifié.
- **~80 % de la machine existe déjà** : `expected_artifact`/`verify_expected_artifact`, `task_heartbeat`/`reconcile_dead_tasks` (600 s), `discipline_agent` (score /100), `watchdog.ps1`, `supervise.mjs`, colonne `dispatcher`, circuit breaker FR-07. Le défaut = tout est optionnel ou non câblé.
- **L'escalade = requeue/redispatch vers un autre worker** (pas un rappel moral), bornée (×2) → dead-letter → sortie vers l'humain.

### Où le concil s'affronte
- **Où vit le bail ?** E/A : dans l'orchestrateur Rust (lease universel) — D : dans `watchdog.ps1` (nudge ladder, zéro Rust). D exécutable lundi, E structurel à terme.
- **`create_task` vs `dispatch_task`** : A veut fusionner (tuer le polling par construction) — C/reviewers : impossible pour les Bleubites ACP (sessions ouvertes, non spawnables). Deux classes de transport coexistenables.
- **Réputation → routage** (B) vs scores falsifiables tant que preuves auto-signées (reviewer 4). Le marché de réputation n'est viable qu'APRÈS la preuve serveur.
- **SPOF** : seul C souligne que hphe-mcp/taskwatch eux-mêmes ne sont pas surveillés.

### Angles morts attrapés par la revue croisée
1. **Fencing tokens / epoch** (3 reviewers indépendants) : worker « mort » qui se réveille après redispatch = double livraison, écrasement d'artefact. Epoch par dispatch, rejet des writes/update_task d'epoch périmé.
2. **Effets de bord non-fichiers** : `git push`, appels API — ni vérifiables ni annulables → clés d'idempotence + transactions compensables.
3. **Validation sémantique** : fichier non vide ≠ contenu correct → critère d'acceptation défini à `create_task` par le dispatcher.
4. **Le forçage non testé est du théâtre** : injection de faute (tuer un worker → vérifier reap→redispatch→preuve) + métriques de calibration.
5. **Budget tokens** des boucles de respawn (seul C l'effleure).

### Recommandation
Ne pas ajouter de pression morale — convertir le cycle de vie en **bail vérifié côté serveur** :
1. **Gate** : `create_task` exige `expected_artifact` + critère d'acceptation → sinon rejet.
2. **Lease** : heartbeat + TTL + **epoch fencing** sur toute tâche ; `reconcile` fauche → redispatch auto vers agent actif suivant (×2 max → dead-letter → notification humaine OS/Telegram, jamais un autre agent en terminus).
3. **Preuve contractuelle** : `update_task(completed)` refusé sans artefact vérifié serveur (mtime/hash) — validation sémantique quand définie.
4. **Autorité** : ACL — `dispatch_task` restreint à devin/agy/orchestrateur ; audit de la colonne `dispatcher`.
5. **Watchdog acteur** : échelle de nudges (inject ACP résolu par roster / re-spawn CLI → discipline −10 → fail+re-route → rapport + alerte humain).
6. **Réputation** : score discipline → `provider_prefs` — seulement après que les preuves sont vérifiées serveur.
7. **Test du forçeur** : fault injection périodique.

### La chose à faire en premier
Modifier **`watchdog.ps1`** : généraliser l'inject ACP au-delà de `devin` (résolution via `workspace-roster.json` + `acp-inject.js`) et y ajouter l'échelle de relance bornée. Un fichier, zéro Rust, tout via `Invoke-McpJson` — canal unique intact.
