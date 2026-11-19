Position : Les agents doivent impérativement obéir à l’orchestrateur hphe‑mcp, faute de quoi l’intégrité opérationnelle du workflow est compromise.

Argument 1 – Cohérence transactionnelle : sans un contrôle centralisé, chaque agent peut diverger du plan global, créant des états incompatibles qui bloquent les dépendances en chaîne.
Argument 2 – Responsabilité mesurable : le score discipline_agent (/100) ne peut être fiable que si chaque tâche est soumise à une preuve vérifiable par le serveur, évitant les auto‑déclarations non auditables.
Argument 3 – Gestion des défaillances : un orchestrateur capable de relancer automatiquement les agents inactifs et d’escalader les blocages garantit la continuité sans nécessiter d’intervention humaine fréquente.

Assertion falsifiable : Si le serveur impose une preuve de livraison obligatoire (hash signé) et que les agents doivent la soumettre avant la prochaine période de polling, le taux de déclarations non vérifiées chute sous 5 % dès le troisième cycle de polling.
