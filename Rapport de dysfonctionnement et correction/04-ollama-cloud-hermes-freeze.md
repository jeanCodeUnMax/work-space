# 04 — ollama-cloud/hermes : processus vivant mais gelee (2 occurrences)

- **Date :** 2026-10-19
- **Taches :** #508, #524
- **Composant :** `hermes.exe` via provider `ollama-cloud` (`gpt-oss:120b-cloud`, `nemotron-3-ultra:cloud`)
- **Detecteur :** Cash · **Correcteur :** Cash (kill + requalification + reprise scope)

## Symptome

Deux dispatches consecutifs sur le chemin `ollama-cloud` + `hermes -z --yolo` ont produit la meme signature de gel :

| Tache | PID | Symptome mesure |
|---|---|---|
| #508 | 24592 | CPU (Kernel+User) = 0, RSS ~4,5 MB, zero ecriture log, aucun diff apres ~11 min en `in_progress` |
| #524 | 13824 | CPU = 0, RSS ~4,4 MB, aucune progression apres ~8 min |

Le process existe (vivant au sens PID) mais ne calcule rien : blocage probable de la connexion Ollama Cloud sans timeout applicatif.

## Cause racine

`hermes.exe` lance en mode `-z` headless se bloque sur l'appel au provider cloud (connexion ou prompt interactif non couvert par `--yolo`) sans timeout interne. L'orchestrateur ne distinguait pas "worker vivant" de "worker fige" : le statut DB restait `in_progress` tant que le PID existait.

## Correction appliquee

- Kill des deux PID ; #508 et #524 marquees `failed` ; scopes repris par Cash (FR-05/06/07 pour 508 ; patch extension pour 524).
- FR-08 : heartbeat worker — le bridge bat `last_heartbeat` toutes les 30 s uniquement si le PID vit ET que le log de dispatch progresse (`log=` dans l'event dispatched) ; un worker gelee-mais-vivant cesse d'emettre des beats et est reape `failed` apres 10 min.
- Regle de veille transmise au relais : `in_progress` > ~30 min sans artefact = suspect ; verifier PID + CPU + mtime log, pas seulement le statut DB.
- Timeout abort 300 s ajoute aux workers NIM ; recommandation de ne pas redispatcher sur `ollama-cloud` sans timeout/reaper effectif.

## Verification et prevention

- Signature de gel documentee (CPU=0 + RSS ~4,4-4,5 MB + logs figes).
- Reaper heartbeat deploye ; watchdog detecte les `in_progress` stales >30 min.
