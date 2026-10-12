# MCP-TOOLS — référence des 57 outils `hphe-mcp` / `hphe-rest`

Serveur MCP canonique : **`Hephaistos-everything-search`**
(stdio `hphe-mcp.exe` ; mêmes outils en HTTP sur `hphe-rest` :8792 —
`GET /tools`, `POST /tools/{name}`, `POST /call`, `GET /health`).

## Index NTFS (`\\.\pipe\hphe-index`)

| Outil | Rôle |
|---|---|
| `everything_search` | Recherche de fichiers ultra-rapide sur les volumes NTFS (index hphe-indexd) |
| `search_files` | Alias d'`everything_search` |
| `everything_count` | Compte les résultats sans renvoyer les lignes |
| `everything_categories` | Catégories de filtres Everything (`audio:`, `document:`…) |
| `everything_index_stats` | Statut index : entrées, fichiers, dossiers, mémoire |
| `everything_stats` | Alias d'`everything_index_stats` |
| `everything_refresh` | Demande un refresh / rebuild de l'index |
| `everything_open_gui` | Lance le GUI Everything (si présent) pour visualiser |
| `resolve_path` | Résout une ligne index interne → chemin complet (pipe démon) |
| `hphe_health` | Ping santé serveur + connectivité pipe démon |

## Contenu (Tantivy)

| Outil | Rôle |
|---|---|
| `content_search` | Recherche plein-texte BM25 (hits : path, score, snippet) |
| `content_ingest` | Ingère un arbre dans l'index Tantivy (respecte `.ragignore` + SAFETY) |
| `hephaistos_update` | Pipeline complet : ingest Tantivy + embeddings NIM optionnels |
| `hephaistos_update_force` | Variante force de `hephaistos_update` |

## Vecteurs (usearch embarqué, 2048D)

| Outil | Rôle |
|---|---|
| `vec_search` | k-NN vectoriel usearch HNSW sur collections persistées |
| `semantic_search` | Recherche sémantique (forwarding `vec_search`) |
| `vec_stats` | Stats des collections (noms, dims, tailles) |
| `hybrid_search` | Multi-modal : nom de fichier + BM25 + vecteurs |

## Orchestration multi-agents

| Outil | Rôle |
|---|---|
| `create_task` | Crée une tâche (ID auto) |
| `update_task` | Met à jour statut/description/résultat/deps/assignation |
| `get_next_task` | Prochaine tâche en attente (deps + assignation) |
| `list_tasks` | Liste filtrable par statut/assignation |
| `delete_task` | Supprime une tâche |
| `list_agents` | Agents enregistrés (config, skills, providers) |
| `register_agent` | Enregistre/met à jour un agent |
| `update_agent` | Modifie config/type/flag actif |
| `suggest_agent` | Suggère un agent selon `task_type` et skills |
| `set_prompt_template` | Template de rôle (`{{task}} {{context}} {{files}} {{model}}`) |
| `list_prompt_templates` | Liste les templates par rôle |
| `dispatch_task` | Dispatch complet : agent par skill + modèle live + notify CLI |
| `list_worktrees` | Worktrees d'agents (task_id, path, branche, statut) |
| `worktree_cleanup` | Supprime un worktree (`git worktree remove --force` + `branch -D`) |

## NIM / modèles

| Outil | Rôle |
|---|---|
| `available_models` | Sonde live des modèles free/locaux (NIM ×2, Ollama, OpenRouter `:free`) |
| `nim_domains` | Domaines routés NIM (modèle primaire + fallbacks) |
| `nim_models` | `model_id`s servis par NVIDIA NIM (`GET /models`) |
| `nim_chat` | Chat routé par domaine (fallbacks auto) |
| `nim_chat_model` | Chat direct par `model_id` explicite |
| `nim_embed` | Embeddings NIM domaine `rag_embedding` (2048D — mêmes vecteurs que hphe-vec) |

## Mémoire unifiée

| Outil | Rôle |
|---|---|
| `project_init` | Initialise le stockage mémoire d'un projet |
| `memory_write` | Écrit une mémoire (store unifié — mêmes fichiers que l'ex-agentMemory) |
| `memory_read` | Lit par clé exacte |
| `memory_search` | Recherche par mot-clé, tags ou type |
| `memory_list` | Liste les mémoires (filtre type optionnel) |
| `memory_update` | Met à jour une mémoire |
| `memory_stats` | Stats de stockage par projet ou global |

## Filesystem (`fs_*` — politique `.mcp-access`)

| Outil | Rôle |
|---|---|
| `fs_read_file` | Lit un fichier (utf-8, `max_bytes`) |
| `fs_read_multiple_files` | Batch de lectures (échec unitaire non fatal) |
| `fs_list_directory` | Liste un répertoire (name, dir, size, mtime) |
| `fs_directory_tree` | Arbre JSON récursif borné (`max_depth`, `max_entries`) |
| `fs_get_info` / `get_file_info` | Stat : taille, dates, attributs, readonly |
| `fs_write_file` | Écrit (crée parents, append optionnel) |
| `fs_edit_file` | Remplace `oldText`→`newText` (1ʳᵉ occurrence) |
| `fs_create_directory` | Crée récursivement (idempotent) |
| `fs_move` | Déplace/renomme |
| `fs_delete` | Supprime fichier/dir (`recursive=true` requis pour non-vide) |
| `fs_search_files` | Traversal récursif par nom partiel (lent sur gros arbres) |
| `fs_list_allowed_roots` | Affiche l'allowlist `EVERYTHING_MCP_ROOTS` |

## Variables d'environnement

| Var | Défaut | Rôle |
|---|---|---|
| `HPHE_CONTENT_DIR` | `INSTALL\data\content-index` | index Tantivy |
| `HPHE_VEC_DIR` | `INSTALL\migrated-vec` | collections usearch |
| `HPHE_ORCH_DB` | `INSTALL\data\orchestrator.db` | orchestrateur (tasks, provider_prefs) |
| `HPHE_MEMORY_ROOT` | `F:\Sqlite-DB\agentmemory` | racine mémoire |
| `HPHE_PIPE` | `\\.\pipe\hphe-index` | pipe démon index |
| `HPHE_INGEST_ROOTS` | — | racines boucle ingest (`;`) |
| `HPHE_INGEST_SCAN` | — | parents scannés pour marqueur `.agent/` |
| `HPHE_INGEST_INTERVAL_S` | `900` | cycle boucle (s, min 30) |
| `EVERYTHING_MCP_ROOTS` | — | allowlist `fs_*` (`;`, vide = libre) |
| `EVERYTHING_MCP_AGENT` | `default` | profil `.mcp-access` actif |

## Invariants d'écriture

- **Un seul writer Tantivy** : gate interne `hphe-rest` — `content_ingest` /
  `hephaistos_update[_force]` via REST = file d'attente (`ingest_busy` dans
  `/health`), plus de `LockBusy`.
- **Un seul writer par base** : `hphe-rest` est le point de sérialisation ;
  les connexions externes = read-only ou éphémères.
- Toute racine passée à `content_ingest` s'inscrit dans
  `data\ingest-roots.txt` → ré-ingérée à chaque cycle de la boucle.
