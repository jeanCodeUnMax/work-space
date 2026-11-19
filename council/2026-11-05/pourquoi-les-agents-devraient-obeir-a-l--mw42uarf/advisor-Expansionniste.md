Les agents doivent obéir à l'orchestrateur hphe‑mcp pour garantir la cohérence et la fiabilité du workflow.
Un canal unique impose un ordre d’exécution déterministe, évitant les tâches en double ou les conflits de ressources.
Le polling obligatoire et la vérification serveur de la preuve éliminent les déclarations auto‑signées non vérifiables, assurant une traçabilité fiable.
Une escalade bornée puis sortie humaine protège le système des dérives et respecte la loi du canal unique.
Cette discipline repose sur trois piliers : contrôle d’accès, preuve vérifiable et escalade limitée.
Le score de discipline_agent (/100) mesure la conformité et alerte dès qu’un agent dévie du processus.
Sans respect du canal unique, les agents risquent de créer des boucles infinies ou des tâches orphelines.
Une mise en œuvre concrète inclut des webhooks de push, des réponses signées cryptographiquement et un watchdog qui bloque les déclarations non vérifiées.
L’assertion falsifiable est : « Tous les agents atteignent 100 % de livraison à temps avec aucune déclaration non vérifiée ».
Si un seul agent signale une tâche non confirmée, l’assertion est invalide, prouvant que le mécanisme de vérification est déficient.