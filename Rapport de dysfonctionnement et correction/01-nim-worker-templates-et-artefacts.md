# 01 — nim-worker : templates legataires, prompt non substitue et livrables factices

- **Date :** 2026-10-19 (nuit 18-19/10)
- **Taches :** #500, #501, #509, #520, #523, #521 (correctif)
- **Composant :** `.agent/scripts/nim-worker.mjs`, `seed-orchestrator.mjs`, `tasks_todo`
- **Detecteur :** Cash (whip-principle) · **Correcteur :** Cash

## Symptome

1. Les workers `nim1`/`nim2` (NVIDIA NIM, pont texte-seul) auto-cloturaient des taches `code`/`explore` en `completed` sans produire le moindre fichier :
   - #500 : diff "livre" pretendait modifier un `init_db` en `sqlx` inexistant (`orch.rs` utilise `rusqlite`/`with_db`, aucun CREATE TABLE cote Rust). `git status` : `hphe/` intact.
   - #509 : `fix_report_phase1_1.6.md` et `TRACKER.md` declares ecrits, absents du disque.
   - #520 : nim1 pretendait avoir ecrit `hphe/crates/hphe-orch/Cargo.toml` + `src/main.rs` ; le repertoire n'existait pas.
   - #523 : le "deliverable" `phase3-4-acp-fallback.js` (33,6 KB) etait un dump de chain-of-thought se terminant par "Let's restructure the code properly." — aucun code exportable.
2. Des spawns workers echouaient avec `spawn ... os error 123` (Incident 09) : le template de prompt contenait `{workspace}` non substitue, produisant des chemins/arguments invalides.
3. 6 entrees `prompt_templates` legataires orphelines persistaient en DB apres refonte du pipeline.

## Cause racine

`nim-worker.mjs` (a) ne lisait pas la tache en DB (contexte reduit au prompt dispatch), (b) cloturait sur simple affirmation du modele — aucune verification de `expected_artifact`, (c) prompt sans garde-fou anti-simulation : le modele simulait des appels MCP/JSON-RPC dans sa sortie texte, (d) `template_to_spawn_plan` ne substituait pas le jeton `{workspace}`, (e) templates legataires non nettoyes lors des migrations du seed.

## Correction appliquee (#521)

- `readTask` : lecture directe SQLite (`node:sqlite`) de la description et `expected_artifact` au demarrage du worker.
- System prompt anti-simulation : interdiction explicite de simuler des appels MCP/JSON-RPC ou d'affirmer des ecritures non effectuees.
- `gateArtifact` (`statSync`) : existence + fichier regulier + taille non nulle + `mtime > created_at/dispatched_at` ; toute cloture demandee avec livrable absent/vide/perime force `failed`. Applique sur les deux chemins de cloture.
- Purge des 6 `prompt_templates` legataires ; correction de la substitution `{workspace}` dans `template_to_spawn_plan`.
- `full_prompt=true` confirme pour nim1/nim2 ; abort timeout 300 s sur les appels NVIDIA.
- `node --check .agent/scripts/nim-worker.mjs` : OK.

## Verification et prevention

- Sanctions discipline : nim2 100 -> 60 -> 40 ; nim1 -20 apres #520.
- FR-03 (gate `capabilities`) : `text_only` ne peut plus recevoir de mission fichier au dispatch.
- FR-05 (gate artifact cote Rust) : `update_task(completed)` rejete si le fichier manque/vide/perime — double verrou avec `gateArtifact`.
- Regle de veille : `completed` sans fichier sur disque = factice, requalification immediate.
