# Verdict partiel — Concil « forcer les agents » (2026-11-05)

**Présents : 3/6** — Premiers-Principes (keen-agent/nim2), Expansionniste (urban-agent/nim), Exécuteur (steady-agent/nim2).
**Absents : Outsider (amber-agent/omniroute), Contrariant (kens-mmm/omniroute), Empirique (brave-llm/omniroute)** — tous sur provider omniroute, injection delivered mais aucun livrable. Verdict partiel autorisé (protocole §Doctrine).

## Convergence (3/3 présents)

1. **Push > pull** : `create_task` sans notification = défaut de conception ; chaque tâche doit être un événement poussé (`dispatch_task` + ACK), le polling ne sert qu'à récupérer l'accusé.
2. **Preuve serveur, jamais auto-signée** : `expected_artifact` doit devenir obligatoire ; le serveur vérifie artefact (hash + timestamp) avant de clore `completed`. La déclaration de l'agent ne vaut rien seule.
3. **Escalade bornée → humain** : relances liées au score `discipline_agent` ; après seuil (≈2 relances / score <70), verrou + notification humaine — jamais de boucle infinie dans le canal.

## Apports distincts

- **Premiers-Principes** : chaque étape = événement explicite visible de l'agent ; escalade par notch de score.
- **Expansionniste** : accusé de réception **cryptographiquement signé**, dépôt immuable d'artefacts, timeout configurable (2 h) → mode « human-override » sans canal additionnel.
- **Exécuteur** : `dispatch_task` ne considère la tâche close qu'après preuve serveur ; assertion falsifiable sur le score.

## Ce que le concil complet avait déjà établi (session sub-agents, même jour)

Convergence avec le concil précédent : bail/lease + heartbeat + epoch fencing, ACL sur `dispatch_task`, watchdog acteur via `Invoke-McpJson`, réputation → `provider_prefs` après preuve serveur. Les 3 livrables Bleubites **confirment indépendamment** le cœur du verdict : push obligé + preuve serveur + escalade bornée.

## Recommandation maintenue

Premier geste inchangé : `watchdog.ps1` passe d'observateur à acteur (inject ACP généralisé via roster, échelle de relance bornée, re-vérif des `completed`). Puis gate `expected_artifact` obligatoire + epoch fencing contre les zombies.
