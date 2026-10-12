# Tools-Reference

**La référence complète des 57 outils vit dans [`docs/MCP-TOOLS.md`](../MCP-TOOLS.md).**

Résumé des familles exposées par `hphe-mcp` / `hphe-rest` :

| Famille | Outils | Rôle |
|---|---|---|
| Index NTFS | `everything_search`, `search_files`, `everything_count`, `everything_index_stats`, `everything_refresh`, `everything_open_gui`, `hphe_health` | recherche `\\.\pipe\hphe-index` |
| Contenu | `content_ingest`, `content_search`, `hephaistos_update`, `hephaistos_update_force` | index Tantivy |
| Vecteurs | `vec_search`, `vec_stats`, `semantic_search`, `hybrid_search` | usearch 2048D |
| Orchestration | `list_agents`, `create_task`, `update_task`, `delete_task`, `list_tasks`, `get_next_task`, `dispatch_task`, `suggest_agent`, `register_agent`, `update_agent`, `list_prompt_templates`, `set_prompt_template`, `list_worktrees`, `worktree_cleanup` | multi-agents |
| NIM/modèles | `nim_domains`, `nim_models`, `nim_chat`, `nim_chat_model`, `nim_embed`, `available_models` | routage modèles |
| Mémoire | `memory_write`, `memory_read`, `memory_search`, `memory_list`, `memory_update`, `memory_stats`, `project_init` | KG unifié |
| Filesystem | `fs_*` (18) | lecture/écriture bornée `.mcp-access` |

> v1 exposait 18 outils (`everything_*` ×6 + `fs_*` ×12) via le serveur Python.
> Historique archivé dans `_archive/`.
