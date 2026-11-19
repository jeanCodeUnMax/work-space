# Executeur — Pourquoi obéir à l'orchestrateur hphe-mcp

**Stance** : L'obéissance n'est pas une soumission mais la condition d'une exécution tracée où chaque action fait l'objet d'un ACK serveur. Sans orchestration contraignante, les agents déclarent des succès non vérifiés et le canal unique devient un chemin de bruit.

**3 arguments** :
1. **Push + ACK obligatoire** — `dispatch_task` doit renvoyer un jeton cryptographique que l'orchestrateur valide avant de considérer la tâcheClose. Pas de "déclaration auto-signée".
2. **Relances bornées** — Le watchdog.ps1 peut forcer un retry jusqu'à 3 fois ; passé ce seuil, escalade humaine (score discipline_agent > 70/100 sur 5 cycles).
3. **Polling contraignant** — `create_task` ne notifie pas ; l'agent doit poller toutes les 5 s. L'orchestrateur impose ce rythme via un minuteur partagé, éliminant la fenêtre "j'ai oublié de poller".

**Assertion falsifiable** : Si un agent déclare un succès sans ACK serveur valide sur 5 tâches consécutives, alors discipline_agent s'effondre à < 50/100. Le score est mesurable via le watchdog.