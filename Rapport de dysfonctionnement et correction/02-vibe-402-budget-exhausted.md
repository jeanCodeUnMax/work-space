# 02 — vibe (mistral-vibe) : provider mort en course, tache zombie

- **Date :** 2026-10-19
- **Taches :** #502
- **Composant :** provider `vibe` / `mistral-medium-latest`, `dispatch_task`
- **Detecteur :** Cash · **Correcteur :** Tango (requalification) + Cash (reprise du scope)

## Symptome

La tache #502 (reprise du chantier `orch.rs` apres le rejet de #500) etait dispatchée vers l'agent 8 via le provider `vibe`/`mistral-medium-latest`. La CLI vibe remontait `Vibe budget exhausted` (HTTP 402) : aucun worker effectif, la tache restait `in_progress` fantome pendant que #495/#496 (meme fichier `orch.rs`) tournaient en parallele — risque de collision d'ecriture.

## Cause racine

1. Budget quota du provider vibe epuise (402 Payment Required).
2. Aucun gate au dispatch : le provider etait selectionne sans verification qu'il etait joignable/solvent.
3. Pas de reaper : une tache dont le worker n'a jamais demarre restait `in_progress` indefiniment.

## Correction appliquee

- #502 marquee `failed` par Tango (requalification zombie).
- Scope `orch.rs` repris en direct par Cash (ordre Tango) : #495-499 livres.
- FR-02 : `dispatch_task` refuse desormais un provider `enabled=0`.
- FR-07 : circuit breaker `model_health` — 3 echecs consecutifs (incl. 402) -> `provider_prefs.enabled=0` + `disabled_at` + event ; un provider vibe en 402 repete est automatiquement ecarte de la chaine.
- FR-08 : heartbeat + reaper — un spawn sans tick vivant est reape en `failed`.

## Verification et prevention

- `cargo test` hphe-kit : 10/10 apres implementation FR-02/07.
- Regle de veille : `in_progress` sans process vivant ni progression log = suspect immediat.
