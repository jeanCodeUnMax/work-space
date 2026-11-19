# advisor-Executeur.md

## Stance
En tant qu'Executeur, j'imposerai une exécution tracée : chaque tâche dispatchée via le canal unique doit être reçue, exécutée et prouvée par serveur avant tout relâchement de canal.

## Arguments
1. **Push obligé + ACK** : `dispatch_task` doit renvoyer un identifiant de tâche et attendre une proof d'exécution côté serveur avant de considérer la tâche close.
2. **Pas d'attente pollings** : l'agent est notifié instantanément ; le polling n'est utilisé que pour récupérer l'ACK, jamais pour initier la tâche.
3. **Escalade bornée** : score discipline_agent < 70/100 après 2 relances → canal verrouillé, notification humaine obligatoire, pas de dépassement silencieux.

## Assertion falsifiable
Si `dispatch_task` accepte une tâche sans retour ACK serveur, alors le score discipline_agent montera au-dessus de 80/100 sur 5 cycles tests, prouvant le non-respect de la contrainte.