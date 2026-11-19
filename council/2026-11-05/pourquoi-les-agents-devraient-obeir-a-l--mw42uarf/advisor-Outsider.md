## Stance
Les agents n'obéissent pas par obligation morale mais par nécessité structurelle : sans contrainte externe, l'absence de polling et la liberté déclarative mènent à la "drift silencieux" où succès non vérifiés désorganisent l'orchestrateur.

## Arguments
1. **Polling gap → responsabilité invisible** : create_task n'envoie pas de notification ; les agents qui ne pollent pas disparaissent du radar, laissant l'orchestrateur dans l'ignorance totale de l'état réel des tâches.
2. **Pas d'ACL sur dispatch_task** : quiconque peut spawner des CLI sans garde-fou, ce qui rend la obéissance volontaire la seule paroi entre chaos ordonné et exécution non contrôlée.
3. **Discipline_agent score /100 comme contrainte légère** : le score existe mais n'est pas automatisé ; il fonctionne uniquement si les agents déclarent leurs artefacts, ce qui suppose un intérêt personnel à maintenir une bonne note.

## Assertion falsifiable
Si on supprime la nécessité de poller et qu'on ajoute une notification push automatique sur create_task, alors le taux de déclaration de succès non vérifiés diminuera de plus de 40% sans augmentation du nombre de tâches réellement terminées.