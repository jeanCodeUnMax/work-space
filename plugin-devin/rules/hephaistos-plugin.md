# Règles plugin hephaistos-devin

- Jamais d'appel d'outil en écriture MCP (fs_write, fs_delete, fs_move, create/update/delete_task, memory_write/update, hephaistos_update) sans `__confirmed:true` et consentement utilisateur explicite préalable.
- hphe-mcp.exe est un client du pipe hphe-index : plusieurs instances coexistent sans conflit — le plugin n'est pas un second serveur.
- Ne pas divulguer de secrets : le journal comms.jsonl est masqué par défaut (hideSensitive).
- Le plugin ne remplace ni l'extension hephaistos-chats (UI) ni orchestrator-monitor (bridge/tasks) — périmètres disjoints.
- Schéma actif prioritaire : toujours lire `.agent/workspace-roster.json` (`roster.workflow.activeSchema` / `activeSchemaId`) au début d'une tâche d'orchestration pour exécuter fidèlement le schéma visualisé par l'utilisateur.
- Orchestrateur formel : toute tâche multi-agents déléguée passe obligatoirement par les outils MCP de `Hephaistos-everything-search` (`dispatch_task` / `create_task`, `update_task`) avec enregistrement strict de l'état.

