# Rapport d'incident INCIDENT-05

**Symptôme**  
Tâche n° 520 dispatchée malgré le gate FR‑02 capabilities dans orch.rs, contourné le mécanisme d’enforcement des phases 1/2.

**Cause racine**  
Quatre processus hphe‑mcp.exe (PIDs 30644, 17300, 17604, 39216) démarrés avant la recompilation release exécutaient le binaire ancien en mémoire, maintenant une version obsolète qui ne respectait plus les gates en vigueur.

**Correction appliquée**  
Déploiement canonique de hphe‑mcp.exe et hphe‑rest.exe (pull‑requests n° 507, 517) et recyclage des processus MCP pour activer les gates FR‑01 à FR‑09.

**Vérification**  
Redémarrage complet des processus MCP, confirmation que les gates FR‑01 … FR‑09 sont actifs et que la tâche n° 520 ne peut plus être dispatchée sans validation du gate FR‑02.

**Prévention**  
Mise en place d’un pipeline de déploiement canonical imposant la version unique de hphe‑mcp.exe et hphe‑rest.exe avant tout lancement de processus, ainsi que contrôle de recyclage automatique des anciens binaires en mémoire.

---

# Rapport d'incident INCIDENT-06

**Symptôme**  
Absence de réveil automatique du chat Antigravity (Tango) à la fin des tâches workers (pattern wake‑noroute dans comms.jsonl).

**Cause racine**  
Absence du tag `[agycascade:7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3]` dans les titres/descriptions des tâches pour la fonction onTaskTerminalWake de orchestrator‑monitor, couplé à watchdog.ps1 qui ne suit pas les transitions de statut par task_id via Connect‑RPC agy‑hub.js.

**Correction appliquée**  
Ajout systématique du tag `[agycascade:7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3]` dans chaque titre et description de tâche, mise à jour de watchdog.ps1 avec suivi des taskStatuses/wokenTasks et réactivation de l’envoi Connect‑RPC agy‑hub.js.

**Vérification**  
Exécution d’un cycle complet de tâches workers ; confirmation que le chat Antigravity (Tango) reçoit le message de réveil à chaque terminaison de tâche portant le tag agycascade.

**Prévention**  
Hooks de génération de tâche imposant l’ajout obligatoire du tag agycascade ; validation continue de watchdog.ps1 pour s’assurer que chaque transition de statut task_id déclenche le Connect‑RPC de réveil.

---

# Rapport d'incident INCIDENT-07

**Symptôme**  
Perte de la requête et des filtres de recherche au changement d’onglet WebView, et erreur à la création de fichier lorsqu’aucun dossier n’est sélectionné (extension VS Code hephaistos‑kit‑search 1.0.5).

**Cause racine**  
Absence de sauvegarde de context.workspaceState / globalState sur le message search, et absence de fallback vers le workspace root dans la fonction startCreate.

**Correction appliquée**  
Persistance de l’état dans extension.ts/main.js, ajout d’un fallback workspace root dans startCreate, et packaging de l’extension sous la forme hephaistos‑kit‑search‑1.0.5.vsix.

**Vérification**  
Tester le changement d’onglet WebView : les requêtes et filtres sont conservés. Tester la création de fichier sans dossier sélectionné : l’outil racine du workspace est utilisée par défaut. Vérifier que le fichier .vsix installé correspond à la version 1.0.5.

**Prévention**  
Intégration systématique de la sauvegarde workspaceState/globalState à chaque mutation liée à la recherche ; ajout d’un guard dans startCreate qui, en l’absence de sélection de dossier, cible automatiquement le root du workspace.

---

# Rapport d'incident INCIDENT-08

**Symptôme**  
Envoi excessif de tâches aux sessions ACP (Devin) alors que nim1 et nim2 étaient disponibles en CLI, provoquant saturation des collaborateurs ACP.

**Cause racine**  
Mauvaise habitude de routage de l’orchestrateur et défaut de configuration initiale de nim‑worker.mjs, favorisant les sessions ACP par défaut.

**Correction appliquée**  
Directive stricte de priorisation Cloud (nim1, nim2 via dispatch_task), interdiction pour l’orchestrateur de coder lui‑même, et création de la règle .agent/rules/rapport‑dysfonctionnement.md.

**Vérification**  
Lancer un lot de tâches en CLI ; confirmer que nim1 et nim2 reçoivent la priorité et que l’orchestrateur n’inscrit plus de tâches vers les sessions ACP sauf exception justifiée. Vérifier la présence et l’application de la règle .agent/rules/rapport‑dysfonctionnement.md.

**Prévention**  
Configuration par défaut de dispatch_task orientant systématiquement vers nim1/nim2 lorsqu’ils sont disponibles ; ajout d’un verrouillage dans le code de l’orchestrateur interdisant toute génération de code interne sans validation explicite ; révision périodique de la règle .agent/rules/rapport‑dysfonctionnement.md pour y intégrer toute nouvelle contrainte de routage.
