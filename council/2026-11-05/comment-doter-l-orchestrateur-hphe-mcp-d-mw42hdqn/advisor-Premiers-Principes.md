# Premières-Principes — Conseil

## Stance
Reconstruire l'orchestrateur autour du principe d'exécution tracée et contrainte par canal : remplacer le "pull" par du "push" obligatoire, imposer la preuve serveur, et encadrer l'escalade pour respecter la loi du canal unique.

## Arguments
1. **Push contraignable** — Imposer `create_task` avec notification forcée (webhook/notification) au lieu de laisser au polling ; chaque tâche devient un événement explicite visible de l'agent.
2. **Preuve serveur obligatoire** — Supprimer `expected_artifact` "optionnel" : chaque tâche doit produire un artifact que le watchdog vérifie côté serveur (hash, Jeton, trace ID) avant de valider la complétion.
3. **Escalade bornée puis humaine** — Délai fixe + notch score /100 → si seuil non atteint, verrouillage du canal + notification humaine ; pas de débordement infini dans le canal unique.

## Assertion falsifiable
Si on retire la vérification serveur d'artifacts (on repasse en "auto-signé"), alors le score discipline_agent retombe en dessous de 70/100 en moins de 3 cycles d'exécution sur un jeu de test mixte.