# Audit de conformite du code Hephaistos 2.1

Date : 2026-10-19
Tache : #541
Auditeur : Bleubite 2, session `acp/devin-cli/scrawny-thorn`
Destinataires : Luna (`acp/devin-cli/maple-lizard`) et Tango
References : `Hephaistos-2.1/PRD-CONSOLIDE-HEPHAISTOS-2.1.md`, `Hephaistos-2.1/TRACKER.md`, et `Hephaistos-2.1/PRD.md` pour le detail initial de FR-11.
Portee : FR-01 a FR-12, sections 3 a 8 du PRD consolide, auto-injection, extension 0.0.60, binaire hphe-orch et controles demandes.
Type : audit de conformite, sans modification du code produit.

## Conclusion

La livraison est partiellement conforme. Les principaux composants sont presents : les gates de dispatch, heartbeat/reaper, persistance de paire, fallback ACP, watchdog, extension 0.0.60 et CLI hphe-orch sont reperes dans les sources. Le binaire deploye est identique au binaire release du workspace.

La conformite stricte n'est toutefois pas acquise :

1. FR-05 ne rejette pas tous les artefacts invalides et ne compare pas leur date a celle du dispatch. Le gate de `nim-worker.mjs` ne complete pas ces controles.
2. FR-04 n'applique pas les transitions disciplinaires documentees et l'ancien script `agent-discipline.mjs` reste un client SQLite direct, non un client du tool MCP.
3. `project_init` peut remplacer un `tasks.json` existant illisible comme JSON strict, notamment un fichier VS Code JSONC, par une liste de taches vide.
4. Le controle `node --check` de tous les fichiers `.js`/`.mjs` echoue sur un livrable texte portant l'extension `.js`.
5. Les commandes de pairage et l'etat de paire de FR-11 du PRD initial ne sont pas exposes par l'extension auditee.

## Constats prioritaires

### C1 - FR-05 n'est pas fail-closed

Gravite : haute.

Dans `hphe/crates/hphe-kit/src/orch.rs:451-501`, `verify_expected_artifact` verifie `Path::exists()` puis compare le `mtime` a `tasks_todo.created_at`. Le controle ne verifie ni `metadata.is_file()` ni une taille non nulle. Un dossier ou un fichier vide peut donc satisfaire ce gate. En outre, un artefact cree apres la creation de la tache mais avant son dispatch peut satisfaire la comparaison, meme s'il precede le travail.

La meme lacune existe dans `nim-worker.mjs:47-68` : `gateArtifact` verifie existence et taille non nulle, mais ne verifie ni le type fichier regulier ni la fraicheur. Le worker ferme ensuite la tache par un `UPDATE` SQLite direct dans `nim-worker.mjs:70-78`, sans passer par `tool_update_task`; le gate Rust et ses eventuels traitements de completion sont ainsi contournes pour cette voie.

Cela contredit le FR-05 consolide (fichier regulier, non vide, `mtime` posterieur au dispatch) et l'exigence NFR fail-closed. Recommandation : enregistrer l'instant du dispatch, partager un validateur unique qui exige un fichier regulier non vide et un `mtime` strictement posterieur a ce timestamp, et faire passer la completion par l'API d'orchestration.

### C2 - FR-04 n'applique qu'une partie de la logique disciplinaire

Gravite : haute.

`tool_discipline_agent` dans `hphe/crates/hphe-kit/src/orch.rs:1634-1669` ajuste et journalise le score, mais ne calcule pas les etats `probation`, `quarantine` ou `euthanized`, et ne desactive pas `agents.active` sous le seuil 20. `tool_agent_status` retourne score/config/statut actif, sans statut disciplinaire distinct (`orch.rs:1672-1701`).

La logique de reference est encore presente dans `.agent/scripts/agent-discipline.mjs:34-63,66-96`, ou les sanctions et la desactivation sont appliquees directement a SQLite. Le script n'est pas devenu un client du tool MCP comme demande par le PRD initial. Les outils MCP existent, mais le critere « portant la logique d'agent-discipline.mjs » est incomplet.

Recommandation : porter les transitions et la desactivation/re-activation dans le tool Rust, exposer leur resultat dans `agent_status`, puis convertir le script en simple client MCP.

### C3 - `project_init` peut perdre des taches VS Code existantes

Gravite : haute.

Dans `hphe/crates/hphe-kit/src/memory.rs:180-197`, l'echec de `serde_json::from_str` est ignore et remplace le document par `{"version":"2.0.0","tasks":[]}`. L'ecriture qui suit remplace alors `tasks.json`; les commentaires JSONC, permis dans les fichiers de configuration VS Code mais refuses par `serde_json`, ou un fichier momentanement invalide peuvent faire perdre les taches personnalisees preexistantes. Ce comportement contredit la promesse de fusion idempotente sans ecrasement du PRD consolide, section 8.

Recommandation : traiter les erreurs de parsing comme une erreur non destructive, ou utiliser un parseur JSONC et sauvegarder explicitement le document avant toute migration.

### C4 - FR-11 : fonctions de supervision presentes, fonctions de paire non trouvees

Gravite : moyenne.

L'extension cree un `StatusBarItem` qui affiche l'etat WebSocket et watchdog (`extension.ts:23-29,154-160`) et demarre/supervise le watchdog avec backoff (`extension.ts:909-939`). Le fallback `agyHubFromProcess` est present (`extension.ts:668-695`). Le manifeste annonce bien la version `0.0.60`.

En revanche, les commandes `Join Binome` et `Rejoin Last Pair`, et un indicateur d'etat de paire demandes par FR-11 du PRD initial (`Hephaistos-2.1/PRD.md:40`), ne figurent ni dans les commandes enregistrees dans `extension.ts:31-85` ni parmi les commandes contribuees dans `package.json`. Le StatusBarItem indique WS/WD, pas le statut de la paire. Le sous-ensemble d'auto-supervision de la section 8 du PRD consolide est present; FR-11 complet tel que defini dans le PRD initial ne l'est pas.

## Matrice FR-01 a FR-12

| Exigence | Verdict | Constat et preuve |
|---|---|---|
| FR-01 | Conforme au code | `tool_dispatch_task` refuse model/provider vides avant l'insertion et le spawn (`hphe/crates/hphe-kit/src/orch.rs:1477-1540`). |
| FR-02 | Conforme au code | Le dispatch lit `provider_prefs.enabled` et refuse la valeur 0 avant le spawn (`orch.rs:1520-1536`). |
| FR-03 | Conforme au code avec reserve de configuration | `check_capabilities` refuse les capacites insuffisantes; les capacites `text_only` ne satisfont ni `fs_read` ni `fs_write` (`orch.rs:221-263`). Un agent sans capacites configurees reste volontairement permissif. |
| FR-04 | Partiel | Les tools MCP sont enregistres (`hphe/crates/hphe-mcp/src/tools/kit.rs:149-160,417-418`), mais les transitions disciplinaires et l'arret sous score 20 ne sont pas portees dans Rust; voir C2. |
| FR-05 | Non conforme | Le gate Rust compare a `created_at` et n'exige ni fichier regulier ni contenu non vide; le gate NIM omet type/fraicheur et ferme directement en SQLite. Voir C1. |
| FR-06 | Presence statique confirmee, validation live non etablie | `maybe_spawn_verify` cree une revue pour les types concernes, evite la boucle et cherche un reviewer `fs_read` distinct (`orch.rs:507-563`). Aucun test dedie de ce comportement n'a ete trouve dans les tests inspectes. |
| FR-07 | Conforme au code, test cible non trouve | Trois derniers enregistrements `model_health` indisponibles coupent le provider et journalisent l'evenement (`orch.rs:566-603`); le cooldown de 15 minutes reactivera le provider dans `pick_model` (`orch.rs:885-918`). |
| FR-08 | Conforme statiquement | Colonne et beat initial Rust, heartbeat bridge toutes les 30 secondes et reaper au-dela de 600 secondes sont presents (`orch.rs:76-80,1595-1597,1773-1897`; `extensions/orchestrator-monitor/ws-bridge/bridge.js:457-504`). Les tests bridge executables ont passe. |
| FR-09 | Conforme statiquement | Table `pairs`, tools `pair_save`/`pair_get` et persistance/reprise dans le pont binome sont presents (`orch.rs:82-100,1926-1970`; `.agent/agent-bridge/comms.js`; `.agent/agent-bridge/binome.js`). Aucun test Rust cible n'a ete trouve. |
| FR-10 | Conforme statiquement | `listAcpSessions` tente le bridge 1,5 s puis lit `state.vscdb` via `listAcpSessionsDirect` (`.agent/agent-bridge/devin-hub.js:174-221`). |
| FR-11 | Partiel | Extension 0.0.60, demarrage watchdog, backoff, indicateur WS/WD et fallback hub confirmes; commandes de join/rejoin et statut de paire du PRD initial absents. Voir C4. |
| FR-12 | Conforme pour le livrable CLI; documentation contradictoire | `hphe-orch` appelle `hphe-kit` directement, fournit `--json` et les codes 0/1/2 (`hphe/crates/hphe-orch/src/main.rs:1-19,153-185`). `--help` du binaire deploye expose les sous-commandes. Le PRD consolide indique encore « implementation en attente » a sa ligne 49, contrairement au TRACKER, section Phase 4. |

## Verification des sections 3 a 8

| Section | Verdict | Preuve et limite |
|---|---|---|
| 3. Durcissement worker | Partiel | `readTask`, prompt anti-simulation, timeout et ecriture d'artefact sont presents dans `.agent/scripts/nim-worker.mjs`; le gate d'artefact ne verifie pas completement le contrat FR-05 et la cloture modifie directement SQLite. |
| 4. Watchdog/reactivite | Presence confirmee | `.agent/skills/reactive-orchestrator/watchdog.ps1` contient les sondes et le canal de reveil; la tache VS Code et l'auto-start extension sont presents. Pas de test end-to-end du watchdog lance pendant cet audit. |
| 5. Routage cascade | Presence confirmee | Le parseur de tag `agycascade` et le routage de reveil sont dans `extensions/orchestrator-monitor/src/extension.ts`; la propagation est documentee dans le PRD. |
| 6. Reporting | Conforme pour la politique et le depot | `.agent/rules/rapport-dysfonctionnement.md`, le repertoire canonique et son index existent. Le present rapport est ajoute a l'index. |
| 7. Politique de dispatch | Presence statique confirmee | Selection agent/provider, capabilities et circuit breaker sont implementes dans `hphe-kit/src/orch.rs`; pas de test live de selection fournisseur realise dans cet audit. |
| 8. Auto-injection | Partiel | `.vscode/tasks.json` contient `Watchdog Hephaistos` avec `runOn=folderOpen` et `isBackground=true`; `project_init` fusionne la tache et scaffold les fichiers, mais le parsing destructif des JSONC/JSON invalides doit etre corrige (C3). |

## Audit des livrables et tests

- `node --check` sur les 48 fichiers `.js` et `.mjs` du workspace : 47 passent; `.agent/deliverables/phase3-4-acp-fallback.js` echoue car son contenu est du texte narratif, pas du JavaScript. Les 47 autres fichiers passent lorsque ce livrable texte est exclu. Le depot ne satisfait donc pas litteralement le controle « tous les .js ».
- `cargo test --workspace` avec `CARGO_BUILD_JOBS=1` : 197 tests passes, 0 echec. Le premier essai parallele a echoue sous pression memoire; la relance sequentielle a termine avec succes.
- `npm run test:bridge` : 2 tests passes, 0 echec.
- `npm run verify:vsix` : passe pour `orchestrator-monitor-0.0.60.vsix`, 456 entrees dont 19 fichiers `ws`.
- Binaire `hphe-orch.exe` : `--version` et `--help` fonctionnent. SHA-256 du binaire release local et du binaire deploye dans `C:\Program Files\servers\hephaistos2-kit\extension\server\` identique : `674afe52a32aa5f567e0efb35e687820dbb130193c3b441cffc5749d9c09757c`.
- Aucun test Rust dedie aux gates FR-01 a FR-09 ou au scaffold `project_init` n'a ete trouve dans les suites inspectees; le passage des tests workspace ne remplace donc pas ces tests de regression.

## Livrable Cloud associe #543

`.agent/deliverables/audit-conformite-2.1.md` existe, mais son contenu ne peut pas servir de preuve d'audit : il date l'audit du 2025-08-28, pointe vers des fonctions et chemins absents de la version inspectee, affirme que le repertoire canonique de rapports manque alors qu'il existe, et declare conformes des exigences sans rapport avec celles du PRD. Il contredit aussi les sources sur `project_init` et FR-12. Ce livrable doit etre corrige ou remplace par son auteur; il n'a pas ete modifie dans le cadre de la tache #541.

## Recommandations

1. Corriger le gate FR-05 dans Rust et NIM, puis ajouter des tests pour l'artefact absent, vide, dossier, preexistant avant dispatch et fichier frais.
2. Migrer la logique disciplinaire restante vers les tools MCP et retirer les mutations SQLite directes du script client.
3. Rendre la fusion de `tasks.json` non destructive en presence de JSONC ou d'une erreur de parsing.
4. Completer FR-11 si le contrat du PRD initial reste applicable, ou mettre explicitement a jour le PRD et le TRACKER pour reduire son perimetre.
5. Remplacer le livrable Cloud #543 invalide et renommer ou retirer le fichier texte `.agent/deliverables/phase3-4-acp-fallback.js` apres accord de son proprietaire.
6. Ajouter des tests de regression dedies aux gates d'orchestration et au scaffold `project_init`.

---

Fin du rapport.
