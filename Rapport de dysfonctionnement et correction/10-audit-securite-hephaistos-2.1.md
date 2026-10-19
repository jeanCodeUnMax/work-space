# 10 - Audit de securite Hephaistos 2.1

**Date** : 2026-10-19
**Taches** : #540 (auditeur principal), #542 (appui Cloud nim1)
**Composant** : transverse (hphe-kit/orch.rs, memory.rs, hphe-orch/main.rs, nim-worker.mjs, agent-bridge/*.js, ws-bridge/bridge.js, extension.ts, watchdog.ps1)
**Detecteur** : Tango (dispatch audit), revue manuelle Bleubite 1 (acp/devin-cli/equal-level)
**Gravite** : moyenne (aucun critique, ecarts de durcissement)

---

## Symptome

Mission : audit de securite complet du code livre dans la nuit pour Hephaistos 2.1, selon cinq controles obligatoires : injection shell, eval/code obfusque, parametrisation SQLite, fuites de secrets, path traversal. Le rapport ci-dessous consolide les constats preuves a l'appui (references fichier:ligne verifiees), les ecarts trouves et les corrections recommandees.

## Perimetre et methode

Fichiers audites : `hphe/crates/hphe-kit/src/orch.rs` (~2100 lignes), `hphe/crates/hphe-kit/src/memory.rs`, `hphe/crates/hphe-orch/src/main.rs`, `hphe/crates/hphe-mcp/src/tools/kit.rs`, `.agent/scripts/nim-worker.mjs`, `.agent/agent-bridge/` (binome.js, comms.js, devin-hub.js, chat-id.js, acp-inject.js), `extensions/orchestrator-monitor/ws-bridge/bridge.js`, `extensions/orchestrator-monitor/src/extension.ts`, `.agent/skills/reactive-orchestrator/watchdog.ps1`. Methode : grep exhaustif des motifs dangereux puis lecture des sites d'appel pour qualifier chaque occurrence.

## Constats conformes

**1. Injection shell : ZERO.** Toute creation de processus est en argv pur, aucune chaine interpretee par un shell :
- `orch.rs` : `run_spawn_plan` utilise `Command::new(&file).args(&argv)` avec flags `CREATE_NO_WINDOW | DETACHED_PROCESS` (l.1189-1204) ; `resolve_cmd_shim` (l.1131-1154) extrait la cible reelle du shim `.cmd` et l'execute sans interpretation shell ; utilitaires `git`/`tasklist`/`wmic`/`taskkill` invoques en argv constant.
- JS/TS : `extension.ts` `execFileSync('powershell', [...])` (l.675), `spawn('node', [bridgePath])` (l.876), `spawn(pwsh, [...])` (l.916) ; `devin-hub.js` `execFileSync(process.execPath, [script, '--json'])` (l.80) ; `chat-id.js` `execFileSync` argv (l.20,49) ; `acp-inject.js` `spawn(spec.cmd, spec.args)` (l.100). Aucun `exec`/`execSync`/`shell:true`.
- `watchdog.ps1` : aucun `Invoke-Expression`/`iex`/`Start-Process` ; invocations par operateur `&` avec splatting d'arguments.

**2. eval / code obfusque : ZERO.** Aucun `eval`, `new Function`, `String.fromCharCode` assemble, ni blob encode dans le perimetre.

**3. Secrets : ZERO fuite materielle.** `NVIDIA_API_KEY(_2)` lues en env-only (nim-worker.mjs l.102), `ORCH_MONITOR_TOKEN` env (devin-hub.js l.54, bridge.js l.272), token CSRF Connect-RPC extrait de la cmdline `agy.exe` (extension.ts l.682) et utilise en header uniquement (l.705). Scans des logs `.agent/*.log`, `.agent/comms.jsonl`, `.agent/logs/*.jsonl` et du repertoire de rapports : aucun materiel de cle en clair (motifs `nvapi-`, `Bearer <token>`, `KEY=<valeur>`).

## Ecarts constates

**F1 (moyen) — SQL interpolee dans `tool_list_tasks`** : `hphe/crates/hphe-kit/src/orch.rs` l.667-676 construit `sql += &format!(" AND status = '{}'", s.replace('\'', "''"))`. La valeur `status` est controlee par l'appelant ; l'echappement manuel `''` est correct pour SQLite (pas d'echappement backslash) mais viole l'exigence "requetes 100% parametrees". `assigned_to` n'est interpole qu'apres parse `i64` (numerique, sur). Correction requise : lier `status` via `params![]` sur colonne dynamique `WHERE status = ?N`.

**F2 (moyen) — `gateArtifact` sans confinement de chemin** : `.agent/scripts/nim-worker.mjs` l.50-68 resout `expected_artifact`/`writtenPath` en `isAbsolute ? artifact : join(cwd, artifact)` puis `statSync` existence+taille. Aucun `resolve`/`starts_with(workspace)` : un `expected_artifact` absolu ou traversant (`..\..\Windows\win.ini`) pointant vers un fichier preexistant satisfait le gate et permet une cloture `completed` factice.

**F3 (moyen-bas) — `verify_expected_artifact` accepte tout chemin existant** : `orch.rs` l.454-505 teste `Path::new(ea).exists()` sur la valeur brute (absolu ou `..`), sans canonicalize ni confinement. Mitigation reelle : le controle `mtime > created_at` (l.486-503) rejette les fichiers preexistants non modifies depuis le dispatch, ce qui reduit mais n'elimine pas l'ecart (un fichier hors workspace modifie apres dispatch reste accepte).

**F4 (moyen) — `project_init` ecrit hors racine** : `hphe/crates/hphe-kit/src/memory.rs` l.224-243 prend `args["workspace"]` tel quel et `scaffold_workspace` (l.202-222) y ecrit `.agent/skills/.../watchdog.ps1`, `.vscode/tasks.json` et le repertoire de rapports. Aucune canonicalization ni allowlist : primitive d'ecriture vers n'importe quel chemin absolu fourni par l'appelant MCP. Frontiere de confiance loopback/stdio, mais ecart direct a l'exigence n.5 de la mission.

**F5 (bas) — comparaison de token non timing-safe** : `bridge.js` l.302 `tok === BRIDGE_TOKEN`. Sur WS loopback le risque est marginal ; recommander `crypto.timingSafeEqual`.

**F6 (info) — confiance au contenu du shim `.cmd`** : `resolve_cmd_shim` execute le dernier token quote de la ligne `%*` ; un shim corrompu pourrait pointer ailleurs. Acceptable : les shims vivent dans le repertoire toolchain npm (protege OS), pas d'entree reseau.

**F7 (info) — extraction `file:` en lecture libre** : nim-worker.mjs l.93 lit tout chemin `file:<path>` dans le prompt ; lecture aux privileges du worker, conforme au design, mais a borner au workspace par coherence avec F2.

## Incident connexe : livrable d'appui #542 non fiable

`.agent/deliverables/audit-securite-2.1.md` (nim1, #542, completed) declare 14 lignes PASS avec preuves fabriquees : numeros de ligne et mecanismes inexistants (SHA-256 dans `verify_expected_artifact`, `spawn('cmd',['/c',script])` dans binome.js qui ne contient aucun spawn, `sqlite3.Database` dans comms.js qui ne touche pas SQLite, `Start-Process` et `node --check` dans watchdog.ps1, middleware de protection `.agent/agent-bridge/*`). Recurrence du mode d'echec documente (#509/#520-523) : sortie text_only sans lecture des fichiers. Ce livrable est classe NON AUTHORITATIF ; le present rapport fait seul foi.

## Correction appliquee

Durcissement applique post-audit (commit nuit 2, tache #548) :

- **F1** : `tool_list_tasks` (orch.rs) — `status` et `assigned_to` lies via `params_from_iter`/`?`, interpolation SQL supprimee.
- **F2** : `gateArtifact` (nim-worker.mjs) — confinement `realpath`/`relative` sous la racine de la tache (`workspace` DB sinon cwd) + fichier regulier non vide + `mtime > created_at`.
- **F3** : `verify_expected_artifact` (orch.rs) — `canonicalize` + `starts_with(workspace)` quand la tache porte un workspace ; exige fichier regulier non vide.
- **F4** : `project_init`/`scaffold_workspace` (memory.rs) — `confine_workspace` borne le scaffold ; ajout `check_project_id` (charset `[A-Za-z0-9_-]` <=64) sur les 6 call-sites `projectId` (anti-traversal `store_path`).
- **F5** : `bridge.js` — `crypto.timingSafeEqual` avec controle de longueur pour l'auth WS.
- **F7** : `file:` dans nim-worker.mjs — lecture confinee au cwd (meme borne realpath/relative).
- Gouvernance : livrable #542 classe non fiable (preuves fabriquees) — voir section dediee.

Verification : `cargo check --workspace` vert, `node --check` vert sur nim-worker.mjs et bridge.js.

## Verification

- Greps de controle rejoues : `eval|new Function|execSync|exec\(|shell:\s*true|Invoke-Expression|Start-Process` -> zero occurrence d'execution dangereuse dans le perimetre.
- Tous les sites `Command::new`/`spawn`/`execFileSync` verifies un a un : argv uniquement.
- `node --check` : deja valide sur les JS modifies cette nuit ; aucun JS nouveau n'a ete ajoute par cet audit.
- Scan fuites : zero materiel `NVIDIA_API_KEY(_2)`, `ORCH_MONITOR_TOKEN`, CSRF dans logs/comms/rapports.

## Prevention

1. Faire passer `tool_list_tasks` en bindings complets (F1) et ajouter un test de non-regression injectant `status="pending' OR '1'='1"`.
2. Imposer `canonicalize` + `starts_with(workspace_root)` a tout chemin d'artifact ou de scaffolding (F2/F3/F4) ; rejeter absolu non confine et `..`.
3. Ajouter `crypto.timingSafeEqual` a la comparaison de token bridge (F5).
4. Regle permanente : tout livrable `text_only` produisant des verdicts PASS doit citer des lignes verifiees sur disque ; contre-verification obligatoire avant usage (le mode d'echec #542 le demontre encore).
5. Etendre le gate FR-05 : le rapport d'audit compte comme artifact, sa presence fichier est verifiee, mais le contenu factice reste un risque humain/averifie.

---

*Audit mene par Bleubite 1 (acp/devin-cli/equal-level) pour #540. Le livrable #542 est reference mais non probant.*
