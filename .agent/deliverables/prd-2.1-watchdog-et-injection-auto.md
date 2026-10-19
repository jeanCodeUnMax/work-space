# Specification PRD 2.1 - Watchdog et Injection Automatique
[agycascade:7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3]

---

## FR-15 : Watchdog Reactif Permanent

- **Fichier exécutable absolu** : `c:/Program Files/Projet-complet/hephaistos2-kit/.agent/skills/reactive-orchestrator/watchdog.ps1`
- **Suivi des transitions taskStatuses/wokenTasks** : Le watchdog surveille en continu l'état des tâches via l'observateur de transitions intégré, enregistrant chaque réveil et changement de statut dans le flux de communication.
- **Réveil Connect-RPC agy-hub.js** : À chaque transition `taskStatus` ou entrée dans `wokenTasks`, un événement RPC est émis via `agy-hub.js` pour notifier les autres composants du système.
- **FileSystemWatcher sur .agent/comms.jsonl** : Un watcher système surveille le fichier `c:/Program Files/Projet-complet/hephaistos2-kit/.agent/comms.jsonl` en temps réel. Toute modification (ajout de ligne, mise à jour de statut) déclenche immédiatement le routage correspondant.
- **Routing [agycascade:7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3] dans orchestrator-monitor** : Les événements captés sont routés vers l'instance `orchestrator-monitor` identifiée par l'UUID `[agycascade:7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3]`, permettant une réaction en chaîne orchestrée.

---

## FR-16 : Injection Automatique et Persistante dans chaque workspace

- **Configuration `.vscode/tasks.json`** : À l'ouverture d'un workspace (`runOn: folderOpen`), la tâche suivante est injectée automatiquement et s'exécute en arrière-plan (`isBackground: true`) :
  - **Commande** : `pwsh -NoProfile -ExecutionPolicy Bypass -File c:/Program Files/Projet-complet/hephaistos2-kit/.agent/skills/reactive-orchestrator/watchdog.ps1 -IntervalSeconds 30`
  - **runOptions** : `"runOn": "folderOpen"`, `"isBackground": true`
- **Initialisation projet `project_init` dans `hphe-kit/src/orch.rs`** : La fonction `project_init` est appelée au démarrage de chaque nouveau workspace pour enregistrer la configuration de watchdog dans les métadonnées du projet, assurant la persistabilité.
- **Supervision auto-start dans `extensions/orchestrator-monitor/src/extension.ts`** : L'extension `orchestrator-monitor` démarre la tâche watchdog automatiquement au chargement, avec gestion des erreurs, journalisation dans `c:/Program Files/Projet-complet/hephaistos2-kit/.agent/logs/` et redémarrage en cas d'échec silencieux.

---

## FR-17 : Repertoire obligatoire et priorisation workers Cloud CLI

- **Répertoire de rapport de dysfonctionnement** : `c:/Program Files/Projet-complet/hephaistos2-kit/Rapport de dysfonctionnement et correction/` — tout incident, erreur non gérée ou correction doit y être consigné sous format structuré.
- **Règle de validation `.agent/rules/rapport-dysfonctionnement.md`** : Chaque worker doit vérifier la présence et la conformité du rapport dans le répertoire ci-dessus avant tout déploiement ou transmission d'artéfact. La règle définit le format minimal (identifiant tâche, timestamp, description, étapes de reproduction, correction appliquée).
- **Priorisation workers Cloud CLI via `dispatch_task`** : Les workers `nim1` et `nim2` bénéficient d'une priorité élevée lors de l'envoi de tâches. Les paramètres obligatoires sont :
  - `context` : État actuel et contexte global de la tâche en cours.
  - `expected_artifact` : Artéfact attendu à la fin du traitement (chemin absolu ou description).
  - `workspace` : Chemin absolu du workspace cible (ex: `c:/Program Files/Projet-complet/hephaistos2-kit`).

---

## .vscode/tasks.json - Contenu exact

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "pwsh",
      "label": "Watchdog Reactif Permanent",
      "command": "pwsh",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "c:/Program Files/Projet-complet/hephaistos2-kit/.agent/skills/reactive-orchestrator/watchdog.ps1",
        "-IntervalSeconds",
        "30"
      ],
      "runOptions": {
        "runOn": "folderOpen",
        "isBackground": true
      }
    }
  ]
}
```

---

*Fin du livrable PRD 2.1 - Watchdog et Injection Automatique*
