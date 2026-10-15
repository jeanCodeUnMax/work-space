---
name: boost
description: Mode Boost — Parallélisation maximale, délégation agressive via orchestrateur Hephaistos (dispatch_task) + subagents, cadrage Hephaistos et vérification continue
triggers:
  - user
---

# /boost — Mode Boost Haute Performance

Active le mode d'ingénierie avancée : parallélisation, délégation et autonomie maximales, câblé sur l'infrastructure Hephaistos2-Kit.

## 1. Directives Opérationnelles
- **Autonomie Maximale :** skip les confirmations pour les étapes évidentes (création de fichiers, lectures, tests, scripts non destructifs).
- **Parallélisation & Délégation Agressive :** déléguer immédiatement toute sous-tâche d'exploration/recherche/analyse lourde (>3 fichiers ou >150 lignes).
- **Rigueur Chirurgicale :** zéro placeholder, zéro code mort, zéro supposition. Implémentations complètes et fonctionnelles.

## 2. Phase 0 : Cadrage & Indexation Immédiate (Hephaistos)
- **Interdiction formelle :** jamais de `Get-ChildItem -Recurse`, `find`, `dir /s`.
- **Recherche instantanée** via MCP `Hephaistos-everything-search` (hphe-mcp, 58 outils) :
  - `everything_search` : localiser fichiers et dépendances sur le disque.
  - `content_search` / `hybrid_search` : symboles, types, interfaces.
  - `fs_*` : lecture/écriture bornées par `.mcp-access` (profil `external` = subagents muxés).
- **Fallback CLI si MCP non exposé :**
  `node "C:\Users\Administrator\.config\devin\scripts\mcp-call.mjs" Hephaistos-everything-search everything_search '{"query":"<terme>"}'`

## 3. Phase 1 : Exécution & Délégation

### 3.1 Pipeline Obligatoire /boost : Workers Hephaistos (Production) -> Subagents IDE (Contrôle)
1. **PRIORITÉ 1 — PRODUCTION LOURDE : Workers CLI via l'Orchestrateur Hephaistos (`dispatch_task`)**
   - Toute tâche lourde sous `/boost` DOIT être assignée en priorité à un **Worker CLI externe** via l'Orchestrateur : `dispatch_task(title, task_type, context, files, workspace, [agent_name], [priority])`.
   - C'est le Worker (`agy` par défaut, `kilo-nim1`, `ollama-cloud`) qui effectue le travail de fond.
   - La tâche est enregistrée dans `orchestrator.db` et apparaît en direct dans l'**Orchestrateur Monitor**.
2. **PRIORITÉ 2 — CONTRÔLE ET AUDIT DU LIVRABLE : Subagents internes (`run_subagent`)**
   - Le travail renvoyé par le Worker CLI est analysé, relu et vérifié par un **Subagent interne** en arrière-plan (`is_background: true`).
   - Le subagent filtre le bruit, contrôle le diff, vérifie la conformité sur disque et évite de saturer l'agent principal avec du travail de relecture inutile.
3. **PRIORITÉ 3 — CONFIRMATION ET RESTITUTION**
   - Une fois le travail certifié par le subagent, le résultat final propre et synthétique est rapporté à l'agent principal.
4. **Fallback one-shot** (uniquement si l'orchestrateur Hephaistos est indisponible) : `agy --print "<prompt>"` ou `hermes -z "<prompt>"`.

### 3.2 Agents enregistrés (`.agent/REGISTRY.md` = source de vérité)
- **`agy`** — Antigravity CLI, skills `*`, abonnement (toujours dispo). **Défaut** — non muxé, MCP en direct.
- **`kilo-nim1`** — KiloCode → NIM : explore, code, docs.
- **`ollama-cloud`** — Hermes scopé : code, review, docs, explore (1 connexion à la fois).
- **`devin`** — agent principal : architecture, orchestration, synthèse, validation finale.

### 3.3 Règles de délégation
- **Modèles free uniquement** pour les CLI (sauf `agy` : abonnement). L'orchestrateur sonde les modèles live (`available_models`, cache 60 s) et suit `provider_prefs` dans `orchestrator.db` — ordre réel piloté par le monitor UI.
- `suggest_agent(task_type)` en cas de doute ; `agent_name` pour forcer.
- `full_prompt:true` = le CLI reçoit le prompt complet (agents sans accès orchestrator comme `agy --print`).
- **`dispatch_task` réveille réellement le CLI** — ne pas l'appeler « pour voir ». Clôture obligatoire : `update_task(id, status, result)`, sinon tâche perdue.
- **Jamais de SQL direct** sur `orchestrator.db` — outils MCP uniquement.
- **Wake-back agy→Devin** : inclure un tag `[agycascade:<uuid>]` dans le context pour que la réponse remonte dans le chat (sinon skip volontaire).
- Agent sans `skills` déclarés n'est jamais choisi auto → `update_agent` ou `agent_name`.
- Ne pas utiliser `gemini` CLI stock (IneligibleTierError) → `agy.exe`.
- Worktree isolation dispo (`list_worktrees`/`worktree_cleanup`) pour les tâches modifiant du code en parallèle.

## 4. Phase 2 : Boucle de Validation & Auto-Correction
- Linters, vérifications de syntaxe, compilations.
- Suites de tests unitaires/intégration associées.
- Régression/erreur → diagnostic cause racine → correction → re-test avant de clore.
- Vérifier le livrable **sur disque** (les agents CLI peuvent rapporter un diff non persisté).

---
*Skill détaillée : `orchestrator-mcp` (playbook complet dispatch_task). `model-router` est déprécié — `available_models` fait le probing live.*
