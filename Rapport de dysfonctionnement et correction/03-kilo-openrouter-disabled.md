# 03 — kilo -> openrouter : dispatch vers provider desactive + agent inconnu

- **Date :** 2026-10-19
- **Taches :** #503
- **Composant :** `dispatch_task`, table `provider_prefs`, agents
- **Detecteur :** Cash · **Correcteur :** Cash (FR-01/FR-02)

## Symptome

La tache #503 etait dispatchée vers kilo/openrouter alors que le provider openrouter etait `enabled=0` dans `provider_prefs`. Le dispatch echouait en cascade avec egalement une erreur `User not found` (agent cible non enregistre). La tache restait bloquee.

## Cause racine

Avant la Phase 1, `dispatch_task` ne validait ni l'existence du provider dans `provider_prefs`, ni son etat `enabled`, ni l'agent cible. Le dispatch etait optimiste : toute combinaison invalide produisait un echec tardif ou un spawn impossible plutot qu'un refus explicite.

## Correction appliquee

- #503 marquee `failed`.
- FR-01 : refus de tout dispatch avec `model`/`provider` vide ou absent, erreur JSON-RPC explicite, aucun process lance.
- FR-02 : refus d'un provider `enabled=0`, avec position de la chaine dans le message d'erreur.
- Gate capabilities FR-03 : verification agent existant + capacites avant acceptation.

## Verification et prevention

- Validation live : dispatch vers provider desactive -> rejet immediat.
- `cargo check`/`cargo test` verts ; deploye dans la release Phase 1.
