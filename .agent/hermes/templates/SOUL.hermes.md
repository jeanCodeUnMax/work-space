# SOUL.hermes.md — Session identity override for {{PROJECT_NAME}}

> Ce fichier S'APPLIQUE sur le SOUL.md global (`$HOME/.hermes/SOUL.md`) quand
> Hermès démarre dans ce projet. Il ajoute des règles spécifiques au projet.

---

## 🎯 CONTEXTE DU PROJET

- **Nom** : {{PROJECT_NAME}}
- **Chemin** : {{PROJECT_ROOT}}
- **AGENT_DB_ROOT** : {{AGENT_DB_ROOT}}
- **Workspace mémoire** : {{AGENT_DB_ROOT}}/current_workspace/{{PROJECT_ID}}

---

## 🔗 MCP TOOLS — Usage prioritaire dans ce projet

### Mémoire (prioritaire absolu — hphe-mcp `Hephaistos-everything-search`)
1. `memory_search` — Avant toute tâche, chercher le contexte existant
2. `memory_write` / `memory_update` — Après toute décision, tracer avec tags (`architecture`, `security`, `decision`)

### Recherche (hphe-mcp)
3. `hybrid_search` / `content_search` — contenu workspace (BM25 + vectoriel 2048D)
4. `everything_search` — fichiers par nom sur tout le disque (NTFS $MFT)
5. `semantic_search` — sens/concept ; `vec_search` + `nim_embed` pour le vectoriel brut

### SQLite
6. `sqlite-node` `query_data` — SELECT (alias `memory`/`graph`/`cache`, KG read-only)
7. `sqlite-node` `execute_query` — INSERT/UPDATE/DELETE (hors KG/orchestrator)

### Fichiers
9. `mcp_filesystem_read_file` / `write_file` / `edit_file`
10. `mcp_filesystem_list_directory` / `search_files`
11. `mcp_filesystem_directory_tree`

---

## ⚠️ RÈGLES SPÉCIFIQUES À CE PROJET

### Architecture mémoire
- Toutes les données de mémoire DOIVENT être stockées dans `${{AGENT_DB_ROOT}}/current_workspace/{{PROJECT_ID}}/`
- Ne pas créer de bases SQLite hors de ce chemin sans justification
- Utiliser les tags `architecture`, `security`, `mcp-tool` systématiquement

### Chemins
- Les chemins absolus dans ce projet utilisent la racine : {{PROJECT_ROOT}}
- Les chemins relatifs sont exprimés depuis {{PROJECT_ROOT}}

### Communiquer en français
- Obligatoire (déjà imposé par SOUL.md global, mais rappelé ici)

---

## 📚 RÉFÉRENCES

- **SOUL.md global** : $HOME/.hermes/SOUL.md
- **AGENTS.md** : {{PROJECT_ROOT}}/AGENTS.md
- **Config MCP Hephaistos2-Kit** : .agent/mcp-config.json.exemple
- **Documentation mémoire** : .agent/memory/ARCHITECTURE-ANALYSIS.md
