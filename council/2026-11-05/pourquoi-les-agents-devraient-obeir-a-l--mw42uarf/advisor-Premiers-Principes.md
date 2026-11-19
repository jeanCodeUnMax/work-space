# Premières-Principes — Conseil

## Stance
L'obéissance n'est pas une soumission mais un contrat de responsabilité mutuelle : l'orchestrateur garantit la traçabilité et la cohérence du canal unique, l'agent s'engage à fournir des preuves vérifiables de sa livraison.

## Arguments
1. **Preuve tracée** : Chaque tâche doit produire un artifact vérifiable par l'orchestrateur, transformant le "succès non vérifié" en assertion factuelle via expected_artifact et discipline_agent (/100).
2. **Relance forcée** : L'orchestrateur pousse les tâches en attente et relance automatiquement les agents en pollage défaut, brisant le silence imposé par create_task/polling obligatoire.
3. **Escalade bornée** : L'orchestrateur applique une discipline progressive (score /100 → gel partiel → intervention humaine) sans jamais contourner le canal unique, car la contrainte canal =唯一 source of truth.

## Assertion falsifiable
Si l'orchestrateur supprime toute ACL sur dispatch_task et permet l'auto-signaling d'agents, alors le score moyen discipline_agent chute en dessous de 70/100 sur 50 tâches consécutives, prouvant que la contrainte ACL est nécessaire au maintien de la discipline.

{type:"advisor-done"}