# Analyses anonymisées — TOUR 2 peer-review

Question : « Pourquoi les agents devraient obéir à l'orchestrateur hphe-mcp, et comment un orchestrateur doit s'y prendre pour se faire respecter ? »

## A1
**Stance** : L'obéissance n'est pas une soumission mais la condition d'une exécution tracée où chaque action fait l'objet d'un ACK serveur. Sans orchestration contraignante, les agents déclarent des succès non vérifiés et le canal unique devient un chemin de bruit.
1. **Push + ACK obligatoire** — `dispatch_task` doit renvoyer un jeton cryptographique que l'orchestrateur valide avant de considérer la tâche close. Pas de « déclaration auto-signée ».
2. **Relances bornées** — Le watchdog peut forcer un retry jusqu'à 3 fois ; passé ce seuil, escalade humaine (score discipline_agent > 70/100 sur 5 cycles).
3. **Polling contraignant** — `create_task` ne notifie pas ; l'agent doit poller toutes les 5 s. L'orchestrateur impose ce rythme via un minuteur partagé, éliminant la fenêtre « j'ai oublié de poller ».
**Assertion falsifiable** : Si un agent déclare un succès sans ACK serveur valide sur 5 tâches consécutives, alors discipline_agent s'effondre à < 50/100.

## A2
**Stance** : Les agents n'obéissent pas par obligation morale mais par nécessité structurelle : sans contrainte externe, l'absence de polling et la liberté déclarative mènent au « drift silencieux » où succès non vérifiés désorganisent l'orchestrateur.
1. **Polling gap → responsabilité invisible** : create_task n'envoie pas de notification ; les agents qui ne pollent pas disparaissent du radar.
2. **Pas d'ACL sur dispatch_task** : quiconque peut spawner des CLI sans garde-fou ; l'obéissance volontaire est la seule paroi entre chaos ordonné et exécution non contrôlée.
3. **Discipline_agent /100 comme contrainte légère** : le score existe mais n'est pas automatisé ; il suppose un intérêt personnel de l'agent à maintenir sa note.
**Assertion falsifiable** : Si on ajoute une notification push automatique sur create_task, le taux de déclarations non vérifiées diminuera de plus de 40 %.

## A3
**Stance** : L'obéissance n'est pas une soumission mais un contrat de responsabilité mutuelle : l'orchestrateur garantit traçabilité et cohérence du canal unique, l'agent s'engage à fournir des preuves vérifiables.
1. **Preuve tracée** : chaque tâche produit un artifact vérifiable, transformant le « succès non vérifié » en assertion factuelle (expected_artifact + discipline_agent).
2. **Relance forcée** : l'orchestrateur pousse les tâches en attente et relance automatiquement les agents en défaut de pollage.
3. **Escalade bornée** : discipline progressive (score → gel partiel → intervention humaine) sans jamais contourner le canal unique.
**Assertion falsifiable** : Sans ACL sur dispatch_task, le score moyen chute sous 70/100 sur 50 tâches consécutives.

## A4
**Position** : Les agents doivent impérativement obéir à l'orchestrateur hphe-mcp, faute de quoi l'intégrité opérationnelle du workflow est compromise.
1. **Cohérence transactionnelle** : sans contrôle centralisé, chaque agent peut diverger du plan global → états incompatibles bloquant les dépendances en chaîne.
2. **Responsabilité mesurable** : le score /100 n'est fiable que si chaque tâche est soumise à une preuve vérifiable par le serveur.
3. **Gestion des défaillances** : relance automatique des agents inactifs + escalade des blocages = continuité sans intervention humaine fréquente.
**Assertion falsifiable** : Avec preuve de livraison obligatoire (hash signé) soumise avant la période de polling suivante, le taux de déclarations non vérifiées chute sous 5 % dès le 3ᵉ cycle.

## A5
**Stance** : Les agents doivent obéir à l'orchestrateur hphe-mcp pour garantir la cohérence et la fiabilité du workflow.
1. Canal unique = ordre d'exécution déterministe, évitant doublons et conflits de ressources.
2. Polling obligatoire + vérification serveur = élimination des déclarations auto-signées.
3. Escalade bornée puis sortie humaine = protection contre les dérives.
Trois piliers : contrôle d'accès, preuve vérifiable, escalade limitée. Sans respect du canal unique → boucles infinies, tâches orphelines. Mise en œuvre : webhooks push, réponses signées, watchdog bloquant les déclarations non vérifiées.
**Assertion falsifiable** : « 100 % des agents livrent à temps avec zéro déclaration non vérifiée » — une seule tâche non confirmée invalide l'assertion.

---
*Absent du concile : A6 non attribué (provider omniroute hors service au moment du dispatch — fetch failed).*