# Règles plugin hephaistos-devin

- Jamais d'appel d'outil en écriture MCP (fs_write, fs_delete, fs_move, create/update/delete_task, memory_write/update, hephaistos_update) sans `__confirmed:true` et consentement utilisateur explicite préalable.
- hphe-mcp.exe est un client du pipe hphe-index : plusieurs instances coexistent sans conflit — le plugin n'est pas un second serveur.
- Ne pas divulguer de secrets : le journal comms.jsonl est masqué par défaut (hideSensitive).
- Le plugin ne remplace ni l'extension hephaistos-chats (UI) ni orchestrator-monitor (bridge/tasks) — périmètres disjoints.
