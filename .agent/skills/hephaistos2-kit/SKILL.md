---
name: hephaistos2-kit
description: "Guide opérationnel et maître d'orchestration pour Hephaistos2-Kit : serveur MCP unifié Rust hphe-mcp (58 outils), recherche NTFS instantanée ($MFT+USN sans Everything.exe), passerelle REST :8792 et boucle Tantivy, orchestrateur multi-agents, panel monitor (:7477), protocole binôme ACP/CLI, Mutex Single-Flight, throttle 2 workers et maintenance réactive."
triggers:
  - hephaistos2-kit
  - hephaistos
  - hphe
  - hphe-mcp
  - everything-search
  - orchestrator-monitor
  - /hephaistos
---

# Hephaistos2-Kit — Guide Opérationnel & Architecture Unifiée

> Ce playbook est la référence opérationnelle définitive pour tout agent IA (Devin, Antigravity, Cursor, Windsurf, Hermes, Kilo) opérant sur ou avec l'écosystème Hephaistos2-Kit. Il élimine toute conjecture, centralise les commandes et définit les invariants architecturaux stricts.

---

## 0. Principes Fondamentaux de l'Architecture (100% Rust)

1. **Serveur MCP Unique et Unifié (`hphe-mcp.exe`)** :
   - Exposé sous le nom canonique **`Hephaistos-everything-search`** (stdio MCP).
   - Intègre 58 outils dans la source couvrant recherche, contenu, vecteurs, orchestration, modèles et mémoire.
   - **Remplacement complet** : Les 7 serveurs historiques (orchestrator Node, agentMemory, nim-router, model-discovery, qdrant, zvec, pont RAG Python) sont définitivement supprimés et absorbés dans le binaire Rust.
2. **Recherche NTFS Instantanée sans Dépendance Externe** :
   - Démon `hphe-indexd.exe` (tâche planifiée SYSTEM) : lit directement le `$MFT` et le journal USN en direct.
   - Sert les requêtes via named pipe `\\.\pipe\hphe-index` en **< 50 ms** sur l'ensemble du PC.
   - **Aucune dépendance à `Everything.exe`**.
3. **Passerelle HTTP & Ingestion Unique (`hphe-rest.exe` :8792)** :
   - Expose les mêmes outils en HTTP (`POST /call`, `POST /tools/{name}`).
   - Gate mutex interne : sérialise les écritures d'index Tantivy (`ingest_busy` dans `/health`) pour éliminer définitivement les erreurs `LockBusy`.
4. **Machine Modeste & Concurrence Maîtrisée** :
   - Empreinte au repos : ~12,5 Mo de RAM pour `hphe-mcp` et 0% de CPU.
   - Throttle strict à **2 workers CLI simultanés maximum**.
   - Priorité Windows obligatoirement assignée sous `BELOW_NORMAL_PRIORITY_CLASS`.
   - **Mutex Single-Flight ACP** : verrouillage des cascades dans l'IDE pour interdire les doublons.

---

## 1. Répertoire des 58 Outils MCP (`Hephaistos-everything-search`)

### A. Recherche Système de Fichiers NTFS (`\\.\pipe\hphe-index`)
- `everything_search` / `search_files` : recherche instantanée sur tous les volumes NTFS par nom, extension ou filtres.
- `everything_count` : compte les résultats sans transférer les lignes (très rapide).
- `everything_categories` : catégories prédéfinies (`audio:`, `document:`, `exe:`, etc.).
- `everything_index_stats` / `everything_stats` : statistiques de l'index (nombre d'entrées, mémoire, statut).
- `everything_refresh` : demande un rafraîchissement forcé du snapshot.
- `everything_open_gui` : ouvre l'interface graphique de visualisation si présente.
- `resolve_path` : résout un ID de ligne interne vers son chemin complet.
- `hphe_health` : vérifie la santé du serveur et la connexion au named pipe du démon.

### B. Indexation & Recherche Plein-Texte (Tantivy)
- `content_search` : recherche plein-texte BM25 (renvoie chemin, score et extraits de code).
- `content_ingest` : ingère un dossier dans Tantivy (respecte `.ragignore` et les filtres de sécurité).
- `hephaistos_update` / `hephaistos_update_force` : cycle complet d'ingestion + vectorisation optionnelle.

### C. Recherche Vectorielle (USearch HNSW 2048D)
- `vec_search` : recherche k-NN vectorielle brute sur les collections locales.
- `semantic_search` : recherche sémantique avec vectorisation automatique.
- `vec_stats` : statistiques des collections vectorielles locales.
- `hybrid_search` : fusion multimodale (nom de fichier + BM25 Tantivy + vecteurs USearch).

### D. Orchestration Multi-Agents & Gouvernance Processus
- `list_agents` : liste les agents enregistrés (config, skills, providers).
- `register_agent` / `update_agent` : enregistre ou modifie un agent.
- `suggest_agent` : recommande le meilleur agent selon le type de tâche et les compétences requises.
- `create_task` : crée une tâche dans `orchestrator.db` (en attente).
- `dispatch_task` : **crée, assigne et spawne réellement le worker CLI** de l'agent retenu.
- `update_task` : met à jour l'état, la description ou le résultat d'une tâche.
- `get_next_task` : récupère la prochaine tâche éligible selon les dépendances.
- `list_tasks` : liste les tâches avec filtres de statut (`pending`, `running`, `completed`, `failed`).
- `delete_task` : supprime une tâche.
- `list_prompt_templates` / `set_prompt_template` : gestion des templates de rôles d'agents.
- `list_worktrees` / `worktree_cleanup` : isolation git des tâches et nettoyage des branches de travail.
- `reconcile_tasks` : réconcilie le statut des tâches avec les PID Windows actifs et libère les verrous orphelins.
- `reap_ghosts` : purge les processus zombies orphelins et requalifie les tâches mortes en échec.

### E. Modèles IA & Routage NVIDIA NIM
- `available_models` : sonde dynamique en direct des modèles gratuits/locaux (Ollama, OpenRouter `:free`, NIM ×2).
- `nim_domains` : domaines routés (modèle primaire + fallbacks automatiques).
- `nim_models` : modèles servis par l'API NVIDIA NIM.
- `nim_chat` / `nim_chat_model` : chat direct routé ou ciblé par identifiant de modèle.
- `nim_embed` : génération d'embeddings 2048D via `nemotron-3-embed-1b`.

### F. Mémoire Technique Unifiée (Knowledge Graph)
- `project_init` : initialise l'espace mémoire d'un projet.
- `memory_write` / `memory_read` : écriture et lecture par clé dans le KV store persistant.
- `memory_search` / `memory_list` : recherche par mot-clé, tags ou type d'entité.
- `memory_update` : modification d'une mémoire existante.
- `memory_stats` : statistiques d'occupation de la mémoire.
- `beacon_ingest` : ingestion incrémentale sécurisée des télémétries et résumés Beacon.

### G. Système de Fichiers Borné (`fs_*`)
- 18 outils filesystem natifs (`fs_read_file`, `fs_read_multiple_files`, `fs_write_file`, `fs_edit_file`, `fs_list_directory`, `fs_directory_tree`, `fs_delete`, `fs_move`, `fs_get_info`, `fs_create_directory`, etc.) régis par la politique stricte `.mcp-access` et l'allowlist `EVERYTHING_MCP_ROOTS`.

---

## 2. Règles de Routage pour l'Agent (Économie de Tokens & Vélocité)

- **Localiser un fichier sur la machine** :
  - **OBLIGATOIRE** : `everything_search` (instantané <50ms sur ~6.4M d'entrées).
  - **INTERDIT** : scans disques récursifs lents (`Get-ChildItem -Recurse`, `dir /s`, `find`).
- **Chercher du code ou un symbole dans le projet** :
  - `content_search` (recherche plein-texte BM25) ou `hybrid_search`.
- **Récupérer du contexte, une décision ou une convention passée** :
  - `memory_search` (mémoire Hephaistos) ou consultation Obsidian (`obsidian_triage`, `obsidian_peek`).
- **Déléguer une sous-tâche technique** :
  - Utiliser `dispatch_task` via l'orchestrateur Hephaistos.
  - **INTERDIT** : spawner des processus détachés en sous-main (`Start-Process`, `nohup`, `&` sans trace dans l'orchestrateur).

---

## 3. Orchestrateur & Monitor WebSocket (:7477)

- **Panel Orchestrator-Monitor** : extension VS Code (`hephaistos.orchestrator-monitor`) fournissant la supervision visuelle, la gestion des priorités de providers et le pont WebSocket réactif (`127.0.0.1:7477`).
- **Ordre de Priorité des Fournisseurs (table `provider_prefs`)** :
  1. `antigravity-subscription` (priorité 1)
  2. `mistral-vibe` (priorité 2)
  3. `nvidia-nim` (priorité 3, clés directes `NVIDIA_API_KEY` / `NVIDIA_API_KEY_2`)
  4. `ollama-cloud` (priorité 4, modèles `:cloud` uniquement : `gpt-oss:120b-cloud`, `nemotron-3-ultra:cloud`)
- **Supervision Réactive** :
  - Toujours surveiller l'avancement via `list_tasks` ou les notifications du bus WS :7477.
  - **INTERDIT** : boucles d'attente passives (`Start-Sleep`, `sleep`).

---

## 4. Protocole Binôme ACP / CLI & Mutex Anti-Doublons

- **Commande `/jointes <agent>`** : établit un canal direct sécurisé entre Antigravity et une session ACP/CLI homologuée.
- **Mutex Single-Flight ACP (`agent-adapters.js`)** :
  - Toute injection dans l'IDE passe par `acquireAcpLock(providerId, timeoutMs)`.
  - Rejette immédiatement toute tentative concurrente sur la même session (TTL 120 s).
  - Libération systématique dans le bloc `finally` via `releaseAcpLock(providerId)`.
  - Élimine 100% des cascades orphelines et onglets fantômes.
- **Plafond Concurrence CLI** : 2 workers maximum simultanés. Les tâches excédentaires sont mises en attente (`pending`).

---

## 5. Maintenance Réactive & Commandes d'Exploitation

### Diagnostic de Santé
```powershell
# Vérifier la passerelle HTTP et l'état du gate d'ingestion
curl http://127.0.0.1:8792/health

# Vérifier la tâche planifiée du démon NTFS SYSTEM
schtasks /query /tn hphe-indexd
```

### Nettoyage des Tâches et Processus Fantômes
```powershell
# Exécution du script de réconciliation automatique
pwsh -File tools/reap-and-reconcile.ps1
```
Ce script invoque successivement `reconcile_tasks` et `reap_ghosts` sur le MCP pour libérer les verrous orphelins et marquer en échec les processus prématurément terminés.

### Configuration Collaborateur Rapide (`setup-collab/`)
```cmd
# Lanceur en un clic pour déployer les 9 agents et le pont binôme
setup-collab\configurer-devin-agents.cmd
```
Ou en PowerShell portable :
```powershell
pwsh -ExecutionPolicy Bypass -File .\setup-collab\configurer-devin-agents.ps1
```

---

## 6. Politique de Sécurité Git (Double Remote Private)

- **Remotes Autorisés Exclusivement** :
  1. `origin` : Organisation projet provisoire (`https://github.com/projet-temporaire/...`)
  2. `personal` : Dépôt personnel de Boss (`https://github.com/lascard-m/...`)
- **Statut Obligatoire** : Tous les dépôts doivent impérativement demeurer en statut **PRIVATE**.
- **Audit de Sécurité** : Vérification systématique de l'absence de tokens (`nvapi-`, `sk-`, `ghp_`, etc.) avant tout commit.
