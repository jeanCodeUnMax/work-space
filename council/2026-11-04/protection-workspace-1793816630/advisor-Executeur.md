Stance: Protecting the IA workspace is essential to prevent irreversible data loss and maintain auditability.
1) Mise en place de versionning git sur le workspace racine avec commits automatiques après chaque tâche critique.
2) Snapshots horodatés quotidiens stockés dans un dossier /backup, avec rétention 7 jours pour rollback rapide.
3) Chiffrement des fichiers sensibles (clés API, configs) via .gitattributes cryptés et clés gérées par l'infrastructure.
Assertion falsifiable: Si un agent supprime accidentellement un fichier critique, le snapshot du jour précédent peut être restauré sans perte de données.