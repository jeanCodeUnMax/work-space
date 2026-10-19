# 09 — spawn workspace : os error 123 (chemin/template non substitue)

- **Date :** 2026-10-19
- **Taches :** incident transverse dispatch (corrige dans le lot #521 + purge templates)
- **Composant :** `template_to_spawn_plan`, templates `prompt_templates`, spawn worker
- **Detecteur :** Tango/Cash · **Correcteur :** Cash (#521) + purge des 6 templates legataires

## Symptome

Des spawns de workers echouaient avec `spawn ... os error 123` — code Win32 `ERROR_INVALID_NAME` : le nom de fichier, de repertoire ou le libelle de volume est incorrect. Le process worker ne demarrait meme pas ; la tache pouvait rester `in_progress` sans process.

## Cause racine

`template_to_spawn_plan` interpolait le template de spawn sans substituer le jeton `{workspace}`. La ligne de commande resultante contenait le litteral `{workspace}` (accolades invalides dans un chemin Windows), rejetee par `CreateProcessW` avec `os error 123`. Aggrave par 6 entrees `prompt_templates` legataires obsoletes encore actives en DB, dont certaines portaient d'autres jetons non substitues.

## Correction appliquee

- Correction de `template_to_spawn_plan` : substitution systematique de `{workspace}` par la racine workspace resolue avant construction de la cmdline.
- Purge des 6 `prompt_templates` legataires ; `seed-orchestrator.mjs` rendu idempotent (pas de reinsertion des templates obsoletes, preservation de `capabilities`/`full_prompt`).
- Les plans de spawn restants n'utilisent que des arguments tableaux (pas d'interpolation shell).

## Verification et prevention

- `node --check` sur les scripts modifies ; les spawns ulterieurs (#515-#523) ont demarre normalement (PIDs observes).
- Regle : tout template de spawn doit resoudre ses jetons avant `spawn()` ; un echec `os error 123` = signature d'interpolation non substituee.
