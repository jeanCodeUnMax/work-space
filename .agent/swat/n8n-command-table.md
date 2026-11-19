# SWAT `swat-n8n-command` — Tableau de commandement n8n

Escouade de 6 cartes opérationnelles. Toutes les commandes passent par le mux :
`POST http://127.0.0.1:5682/tools/call {"name":"n8n__<tool>","arguments":{...}}`
Ré-injection dans une carte :
`POST http://127.0.0.1:5678/webhook/swat-n8n-bridge {"action":"say|fanout|dispatch","card":"<titre>","text":"..."}`

| Carte | Codename | Provider | Rôle | Commandes n8n__* |
|---|---|---|---|---|
| **n8n-Commandant** | vex-marble | omniroute | Point d'entrée — route les ordres vers les cartes via le webhook bridge | `action:say` (carte ciblée), `fanout` (toutes), `dispatch` (healthcheck) |
| **Cmd-n8n-Pilot** | pilot-laser | omniroute | Exécution & publication | `execute_workflow`, `test_workflow`, `publish_workflow`, `unpublish_workflow`, `archive_workflow`, `prepare_workflow_pin_data`, `get_workflow_execution` |
| **Cmd-n8n-Builder** | forge-havoc | nim | Construction & édition | `create_workflow_from_code`, `update_workflow`, `validate_workflow`, `validate_node_config`, `get_node_types`, `search_nodes`, `explore_node_resources`, `get_workflow_best_practices`, `get_workflow_sdk_reference`, `get_workflow_versions_diff`, `restore_workflow_version` |
| **Cmd-n8n-Watcher** | hawk-iris | nim2 | Monitoring exécutions | `search_workflow_executions`, `get_workflow_execution`, `get_instance_activity`, `expand_instance_activity`, `search_workflows`, `get_workflow_details`, `get_workflow_history`, `list_workflow_tags` |
| **Cmd-n8n-Medic** | pulse-suture | openrouter | Santé instance | `list_credentials`, `get_instance_context`, `verify_agent_mcp_server`, `list_n8n_gateway_services`, `search_projects`, `search_folders`, `create_folder`, `move_workflows_to_folder` |
| **Cmd-n8n-Scribe** | ink-sable | omniroute | Rapports & tableaux | `search_workflows`, `get_workflow_details`, `list_credentials` (méta seul), `search_data_tables`, `get_data_table_rows` → synthèse → Devin via `/ask` |

## Flux d'un ordre

```
Utilisateur ──► n8n-Commandant (chat-n8ncmd)
                  │  webhook bridge {action:say, card:X}
                  ▼
              Carte cible ──► mux :5682 ──► n8n__<tool> ──► n8n :5678
                  │
                  ▼  rapport
              Cmd-n8n-Scribe ──► /ask ──► Devin
```

## Règles de l'escouade

- Jamais de secret dans les chats — métadonnées de credentials uniquement.
- `publish/unpublish/archive` = actions live → confirmation explicite avant d'exécuter.
- Réponse courte en français + preuve d'appel réel (id d'exécution, statut).
- Workflows sensibles : `hphe-architecture-healthcheck`, `swat-n8n-bridge`, `SWAT - Telegram Hub` — lecture seule sauf ordre explicite.
