# Rapport d'Analyse Comparative : Architecture Hephaistos2-Kit vs Gouvernance Avancee (SLP / DGP)

Date : 28 Octobre 2026
Projet : hephaistos2-kit
Auteur : Antigravity / Devin (Hermes Core)
Destinataire : Boss
Document de reference : orchestration_annalyse_restructuration/synthese_orchestration_et_protocoles_multi_agents.md

---

## 1. Contexte et Objectifs de l'Analyse

La premiere synthese a extrait trois avancees conceptuelles majeures pour les systemes multi-agents :
1. **SLP (Semantic Library Protocol)** : Communication compacte par adressage semantique et reference a une memoire partagee.
2. **Synchronisation Differentielle & Bibliotheque Cognitive** : Coordination par commits/diffs Git et standardisation de protocoles methodologiques (OODA, 5 Pourquoi, STRIDE, TDD...).
3. **DGP (Delegation Governance Protocol)** : Verrouillage technique de l'orchestrateur pour empecher le syndrome du "travailleur solitaire", via separation stricte des permissions outillees, machine a etats finis et watchdog externe.

L'objectif du present rapport est de confronter rigoureusement ces concepts a l'architecture industrielle existante de **Hephaistos2-Kit**, a la gestion de ses espaces de travail, au fonctionnement de l'extension **hephaistos-chats** (UI React Flow, fenetres Bleubites, transport ACP/CLI) et a l'orchestration des cellules **SWAT**.

Cette analyse evalue les benefices, les risques, la faisabilite technique, la complexite d'implementation et les defauts potentiels pour chaque brique candidate.

---

## 2. Etat des Lieux de l'Architecture Hephaistos2-Kit

L'ecosysteme Hephaistos2-Kit repose aujourd'hui sur une architecture solide, orientee performance et gouvernance machine modeste :

### 2.1. Cœur Rust Unifie (hphe-mcp - 58 Outils Natifs)
- **Recherche NTFS ultra-rapide** (< 50 ms sur 6,4M entrees) via `hphe-indexd.exe` et le named pipe `\\.\pipe\hphe-index`.
- **Moteur de recherche hybride** : Tantivy (BM25 plein-texte) et USearch (vecteurs HNSW 2048D).
- **Orchestration SQLite** : `orchestrator.db` gerant les taches (`create_task`, `dispatch_task`, `list_tasks`, `update_task`), les agents enregistres et les dependances.
- **Routage multi-modeles NIM** : Sondes live sur Ollama, OpenRouter `:free` et NVIDIA NIM.
- **Systeme de fichiers borne** : Outils `fs_*` avec restriction stricte par `.mcp-access` et allowlists.

### 2.2. Extension hephaistos-chats & Orchestration SWAT
- **Graphe d'Orchestration React Flow** : Visualisation et persistance des flux SWAT (`workflow.activeSchema` et `activeSchemaId` dans `.agent/workspace-roster.json`).
- **Fenetres Bleubites (`chat-*`)** : Workers outilles dedies avec boucle locale (`acp-server.mjs`) confinés a la racine du projet (`fs_write_text_file`, `fs_read_text_file`).
- **Transports ACP vs CLI strictement cloisonnes** :
  - Mode ACP (interactif/binome) : `acp-inject.js` pour les Bleubites, `devin-hub.js` pour Devin, avec Mutex Single-Flight (TTL 120s).
  - Mode CLI (headless) : `dispatch_task` spawnant jusqu'a 2 workers d'arriere-plan en classe de priorite `BELOW_NORMAL_PRIORITY_CLASS`.
- **Bus evenementiel et telemetrie** : Bus local `.agent/comms.jsonl`, WebSocket `:7477`, telemetrie Beacon et Second Cerveau Obsidian (`f:\doc_Obsidian\Doc`).

---

## 3. Analyse Comparative par Composant

---

### Composant A : Protocole de Communication Compacte par Reference (SLP)

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Lors de chaque hop SWAT, l'orchestrateur ou `workflowRunner.ts` injecte dans `acp-inject.js` un prompt de tache en langage naturel complet. Chaque appel renvoie l'integralite de l'historique et des regles au provider distant.
- **Probleme constate** : Saturation des quotas TPM (notamment sur les tiers gratuits comme Groq a 8 000 TPM ou NVIDIA NIM), erreurs 413, et latences de generation elevees.
- **Proposition SLP** : Remplacer l'injection verbeuse par une trame structuree pointant vers des identifiants de skills ou de procedures pre-charges dans le Second Cerveau Obsidian ou la memoire KV (`memory_write` / `memory_read`).

#### Pour :
- Reduction drastique de la consommation de tokens entrants sur les API tierces.
- Elimination quasi-totale des pannes liees aux limites TPM (413 ResourceExhausted).
- Reproductibilite stricte des consignes : deux agents recevant l'ID `0x000005` executent exactement la meme procedure sans derivation semantique.

#### Contre :
- Les petits modeles open-source/gratuits (Gemma, Nemotron-Nano) ont besoin d'un prompt d'amorcage clair. Si la procedure n'est pas presente dans leur contexte immediat, ils ne savent pas comment l'appliquer.
- Necessite un resolveur local dans `acp-server.mjs` qui va chercher le document correspondant a l'ID avant l'appel d'inference.

#### Complexite de Restructuration :
- **Moyenne**.
- Modification ciblee de `acp-server.mjs` et de `acp-inject.js` pour resoudre une table d'index (`protocol_catalog.json` ou memoire Hephaistos) avant l'envoi du tour.

#### Verdict Hephaistos :
**FAVORABLE AVEC ADAPTATION**. Ne pas utiliser du binaire brut de 3 octets (inadapte aux LLMs textuels), mais un **catalogue JSON d'URIs de skills** (ex. `hphe://skills/audit-securite-v1`). L'agent recoit l'URI et le resolveur local injecte uniquement les 300 tokens de consignes requises.

---

### Composant B : Synchronisation Differentielle Git (Commits / Diffs) et Worktrees

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Tous les agents travaillent frequemment dans le meme repertoire physique (`process.cwd()`). La transmission de livrable s'effectue par ecrasement de fichiers ou lecture directe. Bien que `list_worktrees` et `worktree_cleanup` soient presents dans `hphe-mcp.exe`, ils sont sous-exploites dans les flux SWAT de `hephaistos-chats`.
- **Probleme constate** : Risques de conflits d'ecriture concurrents si deux workers modifient des fichiers proches, difficultes pour le Reviewer d'isoler precisement ce qui vient d'etre produit par le Codeur.
- **Proposition Git Diffs** : Obliger chaque agent SWAT de codage a travailler dans un `git worktree` dedie et ne transmettre au nœud suivant (Reviewer) que son hash de commit ou son `git diff`.

#### Pour :
- Isolation totale des espaces de travail : zero ecrasement accidental entre agents.
- Revue de code ultra-performante : le Reviewer n'a pas a scanner tout le projet ; il analyse uniquement le diff (`git diff HEAD~1`).
- Tracabilite native de l'historique de chaque agent dans le graphe Git.

#### Contre :
- Overhead I/O a la creation de worktrees sur disques lents ou gros repositories.
- Complexification de la resolution des merges en fin de pipeline si les branches divergent trop.
- Les modeles modestes ont parfois des difficultes a parser des diffs unifies complexes (chunks Hunk `@@ ... @@`).

#### Complexite de Restructuration :
- **Moyenne a Faible**.
- Le binaire Rust `hphe-mcp` integre deja `list_worktrees` et les commandes Git. Il suffit d'activer l'isolation worktree dans `workflowRunner.ts` lors du demarrage d'un nœud SWAT de type "Codeur".

#### Verdict Hephaistos :
**TRES FAVORABLE (PRIORITAIRE)**. L'activation des worktrees pour les nœuds de codage SWAT regle instantanement le probleme de pollution du workspace et fournit au nœud de revue une preuve verifiable immediate.

---

### Composant C : Bibliotheque de Protocoles Cognitifs Decouples (Methode / Profondeur / Restitution)

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Dans `workspace-roster.json`, un nœud de workflow est defini par `role: "Comfy-Inventaire"` et `task: "Inventorie les modeles ComfyUI..."`. La consigne melange le but metier, la methode d'analyse et le format de rendu.
- **Proposition** : Decoupler la configuration du nœud en parametres orthogonaux :
  * `method`: `FIVE_WHYS` | `OODA` | `STRIDE` | `TDD` | `INVENTORY`
  * `depth`: `QUICK` | `STANDARD` | `DEEP`
  * `output_style`: `CONCISE` | `DETAILED` | `DIFF_ONLY`
  * `evidence`: `FILE_HASH` | `TEST_LOG` | `NONE`

#### Pour :
- Clarte structurelle absolue sur le canvas React Flow.
- L'utilisateur peut piloter finement la rigueur d'un agent (ex. passer un Auditeur de `depth: STANDARD` a `depth: DEEP`) sans reecrire son prompt.
- Standardisation des formats de sortie, facilitant grandement le parsing par le nœud aval.

#### Contre :
- Necessite d'enrichir le composant React Flow (`CustomNode.tsx`) dans l'extension `hephaistos-chats` pour afficher ces selecteurs dans l'inspecteur d'agent.
- Risque de sur-parametrage si les modeles sous-jacents ne sont pas assez fins pour distinguer `QUICK` de `STANDARD`.

#### Complexite de Restructuration :
- **Moyenne**.
- Mise a jour du schema de validation `.agent/workspace-roster.json` et ajout des champs dans l'interface de l'extension.

#### Verdict Hephaistos :
**FAVORABLE**. Permet de transformer les nœuds React Flow en modules d'execution industriels au lieu de simples boites a texte.

---

### Composant D : Verrouillage de l'Orchestrateur et Separation Stricte des Pouvoirs (DGP)

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Tango (AGY) et Devin (Cash) possedent la totalite des outils (`fs_write_*`, `write_file`, `edit_file`, terminal). En situation de travail, meme lorsqu'une cellule SWAT de 3 Bleubites est ouverte, l'orchestrateur se met tres frequemment a coder lui-meme les fichiers.
- **Constat utilisateur (Boss)** : "Ton orchestrateur, au bout de cinq minutes c'est lui qui fait le travail tout seul... on est tout le temps en train de le relancer : Fais-toi aider !"
- **Proposition DGP** : Supprimer purement et simplement les outils d'ecriture de code et d'execution terminale du profil d'outils de l'orchestrateur. Ne lui laisser que les outils de gouvernance : `create_task`, `dispatch_task`, `update_task`, `acp-inject`, `read_status`, `accept_result`.

#### Pour :
- **Regle le probleme a 100%** : l'orchestrateur ne peut physiquement plus contourner la delegation. Le prompt cesse d'etre une supplication pour devenir une contrainte de systeme d'exploitation.
- Respect absolu de la hierarchie Hephaistos : Orchestrateur = Cadrage / Arbitrage / Dispatch ; Bleubites/Workers = Execution technique.
- Reduction de la charge mentale de l'utilisateur qui n'a plus a jouer au gendarme.

#### Contre :
- En cas de blocage d'un worker ou pour un mini-correctif d'une virgule, l'orchestrateur ne peut pas intervenir directement sans passer par un agent executant.
- Necessite que l'outillage de dispatch soit parfaitement fluide et exempt de timeouts (si le dispatch echoue, l'orchestrateur est paralyse).

#### Complexite de Restructuration :
- **Faible**.
- Dans la configuration MCP (`mcp_config.json` ou profil de demarrage de l'agent), il suffit de definir un profil `orchestrator-role` qui masque les outils `fs_write_*`, `write_file`, `edit_file`.

#### Verdict Hephaistos :
**INDISPENSABLE ET CRUCIAL**. C'est la solution definitive au probleme vecu au quotidien par Boss. L'orchestrateur doit etre prive des outils d'ecriture dans le workspace des lors qu'un flux SWAT est actif.

---

### Composant E : Machine a Etats Finis (FSM) et Preuves d'Execution Verifiables

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Le passage de relais entre noeuds repose essentiellement sur l'evenement `stopReason: end_turn` renvoye par `acp-inject.js`. Or, comme l'indique la doc de `bleubite-dispatch` : "un delivered/pending ou une reponse textuelle n'est PAS une preuve". Un modele peut repondre "J'ai termine l'audit" sans avoir execute le moindre outil de lecture ou d'analyse.
- **Proposition DGP** : Automatiser la transition d'etat par verification materielle :
  * Transition Codeur -> Reviewer : conditionnee par l'existence d'un commit non-vide ou d'un fichier modifie avec `size > 0` valide par `fs_get_info`.
  * Transition Reviewer -> Sentinelle : conditionnee par la presence d'un rapport contenant un verdict normalise (`GO` / `NO-GO`).
  * Cloture de tache : impossible de passer en `completed` sans `expected_artifact` present sur disque.

#### Pour :
- Elimination totale des hallucinations de fin de tache ("C'est bon j'ai fait" alors que rien n'est ecrit).
- Securite industrielle : les faux positifs ne passent plus la barriere de validation.
- Parfaite synergie avec les outils `fs_get_info` et `reconcile_tasks` de `hphe-mcp`.

#### Contre :
- Si un worker produit un artefact avec un nom legerement different ou dans un sous-dossier imprevu, le pipeline peut se bloquer en attente de preuve.
- Necessite un moteur de validation rigide dans `workflowRunner.ts`.

#### Complexite de Restructuration :
- **Moyenne**.
- Ajout d'une etape d'assertion dans `workflowRunner.ts` et dans l'outil MCP `update_task` avant d'accepter le statut `completed`.

#### Verdict Hephaistos :
**TRES FAVORABLE**. Transforme l'orchestration Hephaistos en un veritable moteur d'integration continue autonome.

---

### Composant F : Watchdog Externe de Vivacite

#### Confrontation avec l'existant Hephaistos :
- **Existant** : Il existe deja un embryon de surveillance avec `schtasks /query /tn hphe-taskwatch` (toutes les 5 minutes) et les commandes `reconcile_tasks` / `reap_ghosts` dans `hphe-mcp`.
- **Probleme constate** : Un intervalle de 5 minutes est trop long pour une session de developpement interactive. Si un agent Bleubite freeze sur un timeout NIM ou un rate limit Groq, l'orchestrateur attend passivement ou abandonne.
- **Proposition Watchdog** : Un composant d'arriere-plan leger (integre dans `hphe-indexd` ou dans le bridge WebSocket `:7477`) avec un battement de coeur a 30 secondes :
  * Detecte les sessions ACP bloques depuis plus de 90 secondes.
  * Verifie que les taches `running` dans `orchestrator.db` emettent bien des tool_calls.
  * Emet immediatement un evenement `{kind: "worker_stalled", sessionId: ...}` sur `comms.jsonl` pour forcer l'orchestrateur a reagir.

#### Pour :
- Reactivite immediate : detection des pannes en 30s au lieu de 5 a 10 minutes.
- Nettoyage automatique des verrous orphelins (single-flight lock ACP).
- Protection contre l'effet de gel du tandem Tango/Cash.

#### Contre :
- Attention a la consommation de ressources en arriere-plan (doit rester sous la regle "gouvernance machine modeste" : <1% CPU).

#### Complexite de Restructuration :
- **Faible**.
- Implementation dans le bridge Node (`agent-bridge/watcher.js`) ou directement dans le demon Rust `hphe-indexd`.

#### Verdict Hephaistos :
**FAVORABLE**. Complete et dynamise le dispositif existant de `hphe-taskwatch`.

---

## 4. Tableau Synthetique : Avantages, Inconvenients et Risques

| Composant | Avantages Majeurs | Inconvenients / Risques | Complexite | Priorite Hephaistos |
| :--- | :--- | :--- | :--- | :--- |
| **SLP (Adressage Semantique)** | Economie drastique de tokens, fin des erreurs 413 TPM sur modeles free | Necessite un resolveur local de templates | Moyenne | Phase 2 (Optimisation) |
| **Git Diffs & Worktrees** | Isolation totale des agents, zero conflit, revue par diff chirurgical | Gestion des branches et merges | Faible / Moyenne | **Phase 1 (Immediat)** |
| **Protocoles Cognitifs Types** | Standardisation des nœuds React Flow, pilotage fin (Methode/Profondeur) | Schema de workflow plus rigide | Moyenne | Phase 2 (Amelioration UI) |
| **Verrouillage Orchestrateur (DGP)** | **Eradication du syndrome solitaire**, delegation obligatoire a 100% | L'orchestrateur ne peut pas faire de hotfix direct | Faible | **Phase 1 (Immediat)** |
| **FSM & Preuves d'Execution** | Elimination des livrables factices et des fausses validations | Rejet strict si chemin d'artefact imprevis | Moyenne | **Phase 1 (Immediat)** |
| **Watchdog 30s** | Debloquage automatique des pannes reseau / modeles en 30s | Legere charge de polling asynchrone | Faible | Phase 2 (Fiabilisation) |

---

## 5. Plan de Restructuration Recommande pour Hephaistos2-Kit

Pour integrer les meilleurs apports de la synthese sans desequilibrer l'architecture eprouvee d'Hephaistos, la restructuration doit s'operer en deux temps :

### Etape 1 : Le "Verrou d'Orchestration" (Chirurgical et Immediat)
1. **Profilage des Permissions de l'Orchestrateur** :
   Dans l'IDE / tandem, limiter les outils mis a disposition de l'orchestrateur en mode SWAT : retirer `write_file`/`edit_file` et conserver uniquement les outils MCP Hephaistos de pilotage (`create_task`, `dispatch_task`, `update_task`, `acp_inject`, `read_status`).
2. **Assertion de Preuve Materielle dans `update_task`** :
   Modifier l'outil MCP `update_task` pour qu'un passage au statut `completed` exige obligatoirement un chemin de fichier reel sur disque verifie par `fs_get_info` (`size > 0`).

### Etape 2 : L'Industrialisation SWAT (Extension & Worktrees)
1. **Activation des Worktrees par defaut pour les Codeurs SWAT** :
   Brancher l'outil existant `hphe-mcp` (`list_worktrees`) dans `workflowRunner.ts` pour que chaque Bleubite de code opere sur un worktree clone, isolant sa production.
2. **Typage des Nœuds React Flow** :
   Ajouter dans `workspace-roster.json` et dans l'inspecteur UI les trois selecteurs decouples : Methode, Profondeur et Preuve attendue.
3. **Resolveur de Skills Compacts (SLP)** :
   Plutot que d'injecter des pages de consignes, `acp-inject` injecte l'identifiant du skill et le serveur ACP local fournit l'extrait strict de 300 tokens requis.

---

## 6. Conclusion Strategique

L'analyse revele une remarquable complementarite entre les idees formulees dans la synthese et l'architecture industrielle d'Hephaistos2-Kit :
- **Hephaistos possede deja l'infrastructure lourde** (moteur Rust ultra-rapide, named pipe NTFS, bus WebSocket, base orchestrateur, gestion des fenetres multi-agents).
- **Ce qui lui manquait, c'etait la contrainte negative d'execution** : tant que l'orchestrateur a le droit d'ecrire, il prefere ecrire que deleguer.

L'adoption des principes du DGP (Delegation Governance Protocol) — en commencant par retirer a l'orchestrateur ses droits d'ecriture directe et en exigeant des preuves materielles par Git/FS a chaque transition — constitue le levier le plus puissant pour transformer Hephaistos d'un systeme d'assistance multi-agents en une veritable usine logicielle autonome et inarretable.
