# Hephaistos2-Kit Architecture

> Comprehensive AI Agent Capability Expansion Toolkit

---

## 📋 Overview

Hephaistos2-Kit is a modular system consisting of:

- **22 Specialist Agents** - Role-based AI personas
- **48 Skills** - Domain-specific knowledge modules (ajout intelligent-routing)
- **12 Workflows** - Slash command procedures

---

## 📁 Arborescence — séparation PROJET / INSTALL

| Rôle | Chemin | Contenu |
|---|---|---|
| **PROJET (dev)** | `C:\Program Files\Projet-complet\hephaistos2-kit\` | sources complètes : `hphe/` (workspace Rust), `extension/`, `extensions/orchestrator-monitor/`, `.agent/`, `docs/`, `tests/`, `tools/`, `.git`, `install.ps1` |
| **INSTALL (runtime)** | `C:\Program Files\servers\hephaistos2-kit\` | runtime seul : `extension/server/` (hphe-mcp, hphe-rest, hphe-indexd + `.cmd`), `data/` (content-index, orchestrator.db, logs), `migrated-vec/`, `memory-database` (jonction F:) |

> **Ne jamais mélanger les deux.** Le projet se développe, l'install s'exécute.
> `install.ps1` (à la racine projet) fait le deploy : build dans le projet →
> binaires vers l'install → config MCP vers les chemins install.
>
> `servers/everything-mcp` = shim de jonctions : chemins *runtime*
> (`extension`, `data`, `migrated-vec`, `memory-database`) → install ;
> chemins *sources* (`hphe`, `.agent`, `docs`, `tests`, `tools`, `extensions`…) → projet.
> Tâche planifiée `hphe-indexd` (SYSTEM, démarrage) → binaire install.
> Anciens MCP archivés dans `servers/servers_backup/`.
> MCP dans Devin : **`Hephaistos-everything-search`**.

---

## ⚙️ Backend unifié Rust — `hphe-mcp` (57 outils, UN SEUL MCP)

> **Depuis T-unification (commit `55fb057`), tous les services d'infrastructure
> sont absorbés dans UN binaire Rust : `extension/server/hphe-mcp.exe`.**
> Les MCP externes `orchestrator`, `nim-router`, `model-discovery`,
> `agentmemory`, `qdrant`, `zvec` sont **désactivés** (config préservée,
> rollback possible). `everything-search` = point d'entrée unique.

| Famille | Outils | Backend |
|---|---|---|
| **Index NTFS** | `everything_search`, `search_files`, `everything_count`, `everything_index_stats`, `hphe_health` | `hphe-indexd` (SYSTEM task) : $MFT → 6,4M entrées, USN live, pipe `\\.\pipe\hphe-index` |
| **Contenu** | `content_ingest`, `content_search` | Tantivy `install/data/content-index` (BM25+snippets, FRN lié MFT) |
| **Vecteurs** | `vec_search`, `vec_stats`, `semantic_search`, `hybrid_search` | usearch `install/migrated-vec/*.usearch` (2048D) |
| **Orchestration** | `list_agents`, `create_task`, `update_task`, `delete_task`, `list_tasks`, `get_next_task`, `dispatch_task`, `suggest_agent`, `register_agent`, `update_agent`, `list_prompt_templates`, `set_prompt_template`, `list_worktrees`, `worktree_cleanup` | `orchestrator.db` (env `HPHE_ORCH_DB`) — pickAgent/pickModel portés du JS |
| **NIM/modèles** | `nim_domains` (17), `nim_models`, `nim_chat`, `nim_chat_model`, `nim_embed` (2048D), `available_models` | NVIDIA NIM x2 + OpenRouter free + Ollama — absorbe nim-router + model-discovery |
| **Mémoire** | `memory_write`, `memory_read`, `memory_search`, `memory_list`, `memory_update`, `memory_stats`, `project_init` | agentmemory JSON **même fichier** `F:/Sqlite-DB/agentmemory` (`HPHE_MEMORY_ROOT`) |
| **Ingestion** | `hephaistos_update` (= "Hephaistos update force") | Tantivy + KG mirror (`memory-database/agentmemory/graph/*.db`) + vecteurs optionnels + état incrémental + `.ragignore` |
| **FS** | `fs_*` (18 outils) | allowed_roots inchangés |

**REST** : `hphe-rest.exe` (127.0.0.1:8792, même 57 outils + `/health`).
Démarré au logon via `Startup/hphe-rest.cmd` ; porte aussi la **boucle
d'ingestion automatique** (`HPHE_INGEST_ROOTS`, intervalle `HPHE_INGEST_INTERVAL_S`=900s).

**CLI** : `hphe-mcp.exe --tool <name> --args '<json>'` — ex. update force :
`hphe-mcp.exe --tool hephaistos_update --args '{"root":".","force":true,"embed":false}'`

**Scripts remplacés** : `.agent/rag/*.py` (cli/pipeline/chunker/embedder/router/
rag_rest_bridge) → voir `.agent/rag/DEPRECATED-BY-RUST.md` ;
`ingest-workspace.ps1`/`auto-ingest.ps1` → wrappers fins vers le binaire.

---

## 🏗️ Directory Structure

```plaintext
.agent/
├── ARCHITECTURE.md          # This file
├── REGISTRY.md              # Agents/capabilities registry + known issues
├── agents/                  # 22 Specialist Agents
├── skills/                  # 48 Skills
├── workflows/               # 12 Slash Commands (incl. /reflect)
├── rules/                   # Global Rules (incl. memory discipline)
├── knowledge/               # Durable knowledge: ADR decisions/, architecture/, docs/
│                            #   → indexed by auto-ingest (searchable by all agents)
├── consciousness/           # Consciousness spec: 5-layer map (Awareness→Memory→
│                            #   Reflection→Intention). Reflection/Intention = /reflect
├── memory/                  # Unified memory docs + policy
├── rag/                     # RAG pipeline (chunker, embedder, beacon_ingest, router)
├── scripts/                 # Master validation + ingestion scripts
└── logs/                    # Runtime logs (gitignored)
```

---

## 🔁 Boucle d'apprentissage fermée (Learning Loop)

Le système n'est pas un simple stockage : c'est une boucle où chaque couche
réinjecte dans la suivante.

```plaintext
Sessions agents (Devin, agy, kilo, hermes, Claude…)
      │  capture passive
      ▼
Beacon ── service Windows BeaconCollector (auto, survit au logout)
      │  ~/.beacon/endpoint/logs/runtime.jsonl
      ▼
beacon_ingest.py (au start-workspace) — distillation en digests
      │  metadata.source = "beacon"
      ▼
Mémoire unifiée : memory_mcp.db (KG) + graph-memory.db + usearch embarqué
      (Qdrant/Zvec externes remplacés par hphe-vec — voir section Rust)
      ▲                                        │
      │ memory_write + ADR                     │ memory_search / qdrant / zvec
      │                                        ▼
/reflect (fin de session/phase) ◄──── Agents (action + retrieval)
      │
      ▼
.agent/knowledge/decisions/*.md ── indexé par auto-ingest ──┐
      (carve-out dans ingest-workspace.ps1)                 │
      ▲────────────────────── re-retrieval ◄────────────────┘

Auto-observation : memory-maintenance.ps1 (au start-workspace) purge les
caches expirés + relations orphelines, checkpoint WAL, et écrit son rapport
dans kv 'maintenance:last_report' → consommé par /reflect.
```

| Dossier | Rôle dans la boucle |
|---|---|
| `knowledge/` | Connaissance **durable et auditable** : ADR (decisions/), docs d'archi. Lu avant décision, écrit après (double écriture avec memory_write). Indexé → cherchable. |
| `consciousness/` | **Spécification** des couches Awareness→Memory→Reflection→Intention. Awareness≈Beacon, Memory≈mémoire unifiée, Reflection+Intention≈`/reflect`. Doc de référence, indexée comme corpus. |

---

## 🤖 Agents (22)

Specialist AI personas for different domains.

| Agent                    | Focus                      | Skills Used                                              |
| ------------------------ | -------------------------- | -------------------------------------------------------- |
| `orchestrator`           | Multi-agent coordination   | parallel-agents, behavioral-modes                        |
| `project-planner`        | Discovery, task planning   | brainstorming, plan-writing, architecture                |
| `frontend-specialist`    | Web UI/UX                  | frontend-design, react-best-practices, tailwind-patterns |
| `backend-specialist`     | API, business logic        | api-patterns, nodejs-best-practices, database-design     |
| `database-architect`     | Schema, SQL                | database-design, prisma-expert                           |
| `mobile-developer`       | iOS, Android, RN           | mobile-design                                            |
| `game-developer`         | Game logic, mechanics      | game-development                                         |
| `devops-engineer`        | CI/CD, Docker              | deployment-procedures, docker-expert                     |
| `security-auditor`       | Security compliance        | vulnerability-scanner, red-team-tactics                  |
| `penetration-tester`     | Offensive security         | red-team-tactics                                         |
| `test-engineer`          | Testing strategies         | testing-patterns, tdd-workflow, webapp-testing           |
| `debugger`               | Root cause analysis        | systematic-debugging                                     |
| `performance-optimizer`  | Speed, Web Vitals          | performance-profiling                                    |
| `seo-specialist`         | Ranking, visibility        | seo-fundamentals, geo-fundamentals                       |
| `documentation-writer`   | Manuals, docs              | documentation-templates                                  |
| `product-manager`        | Requirements, user stories | plan-writing, brainstorming                              |
| `product-owner`          | Strategy, backlog, MVP     | plan-writing, brainstorming                              |
| `qa-automation-engineer` | E2E testing, CI pipelines  | webapp-testing, testing-patterns                         |
| `code-archaeologist`     | Legacy code, refactoring   | clean-code, code-review-checklist                        |
| `explorer-agent`         | Codebase analysis          | codebase-analysis                                        |
| `memory-agent`           | Memory management          | memory-systems, context-management                       |

---

## 🧩 Skills (48)

Modular knowledge domains that agents can load on-demand. based on task context.

### Frontend & UI

| Skill                   | Description                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `react-best-practices`  | React & Next.js performance optimization (Vercel - 57 rules)                                                 |
| `web-design-guidelines` | Web UI audit - 100+ rules for accessibility, UX, performance (Vercel)                                        |
| `tailwind-patterns`     | Tailwind CSS v4 utilities                                                                                    |
| `frontend-design`       | UI/UX patterns, design systems                                                                               |
| `ui-ux-pro-max`         | 50 styles, 21 palettes, 50 fonts (chargement sélectif recommandé – 27 fichiers, utiliser via /ui-ux-pro-max) |

### Backend & API

| Skill                   | Description                    |
| ----------------------- | ------------------------------ |
| `api-patterns`          | REST, GraphQL, tRPC            |
| `nestjs-expert`         | NestJS modules, DI, decorators |
| `nodejs-best-practices` | Node.js async, modules         |
| `python-patterns`       | Python standards, FastAPI      |

### Database

| Skill             | Description                 |
| ----------------- | --------------------------- |
| `database-design` | Schema design, optimization |
| `prisma-expert`   | Prisma ORM, migrations      |

### TypeScript/JavaScript

| Skill                 | Description                         |
| --------------------- | ----------------------------------- |
| `typescript-expert`   | Type-level programming, performance |
| `nextjs-react-expert` | Next.js & React modern patterns     |

### Cloud & Infrastructure

| Skill                   | Description               |
| ----------------------- | ------------------------- |
| `docker-expert`         | Containerization, Compose |
| `deployment-procedures` | CI/CD, deploy workflows   |
| `server-management`     | Infrastructure management |

### Testing & Quality

| Skill                   | Description              |
| ----------------------- | ------------------------ |
| `testing-patterns`      | Jest, Vitest, strategies |
| `webapp-testing`        | E2E, Playwright          |
| `tdd-workflow`          | Test-driven development  |
| `code-review-checklist` | Code review standards    |
| `lint-and-validate`     | Linting, validation      |

### Security

| Skill                   | Description              |
| ----------------------- | ------------------------ |
| `vulnerability-scanner` | Security auditing, OWASP |
| `red-team-tactics`      | Offensive security       |

### Architecture & Planning

| Skill           | Description                |
| --------------- | -------------------------- |
| `app-builder`   | Full-stack app scaffolding |
| `architecture`  | System design patterns     |
| `plan-writing`  | Task planning, breakdown   |
| `brainstorming` | Socratic questioning       |

### Mobile

| Skill           | Description           |
| --------------- | --------------------- |
| `mobile-design` | Mobile UI/UX patterns |

### Game Development

| Skill              | Description           |
| ------------------ | --------------------- |
| `game-development` | Game logic, mechanics |

### SEO & Growth

| Skill              | Description                   |
| ------------------ | ----------------------------- |
| `seo-fundamentals` | SEO, E-E-A-T, Core Web Vitals |
| `geo-fundamentals` | GenAI optimization            |

### Shell/CLI

| Skill                | Description               |
| -------------------- | ------------------------- |
| `bash-linux`         | Linux commands, scripting |
| `powershell-windows` | Windows PowerShell        |

### Other

| Skill                     | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `clean-code`              | Coding standards (Global)                               |
| `behavioral-modes`        | Agent personas                                          |
| `parallel-agents`         | Multi-agent patterns                                    |
| `mcp-builder`             | Model Context Protocol                                  |
| `documentation-templates` | Doc formats                                             |
| `i18n-localization`       | Internationalization                                    |
| `performance-profiling`   | Web Vitals, optimization                                |
| `systematic-debugging`    | Troubleshooting                                         |
| `intelligent-routing`     | Routage automatique des requêtes vers l'agent approprié |
| `codebase-analysis`       | Analyse rapide du codebase pour explorer-agent          |

---

## 🔄 Workflows (12)

Slash command procedures. Invoke with `/command`.

| Command          | Description                                        |
| ---------------- | -------------------------------------------------- |
| `/brainstorm`    | Socratic discovery                                 |
| `/create`        | Create new features                                |
| `/debug`         | Debug issues                                       |
| `/deploy`        | Deploy application                                 |
| `/enhance`       | Improve existing code                              |
| `/orchestrate`   | Multi-agent coordination                           |
| `/plan`          | Task breakdown                                     |
| `/preview`       | Preview changes                                    |
| `/reflect`       | Fin de session : apprentissages → memory + ADR     |
| `/status`        | Check project status                               |
| `/test`          | Run tests                                          |
| `/ui-ux-pro-max` | Design with 50 styles                              |

---

## 🎯 Skill Loading Protocol

```plaintext
User Request → Skill Description Match → Load SKILL.md
                                            ↓
                                    Read references/
                                            ↓
                                    Read scripts/
```

### Skill Structure

```plaintext
skill-name/
├── SKILL.md           # (Required) Metadata & instructions
├── scripts/           # (Optional) Python/Bash scripts
├── references/        # (Optional) Templates, docs
└── assets/            # (Optional) Images, logos
```

### Enhanced Skills (with scripts/references)

| Skill           | Files | Coverage                         |
| --------------- | ----- | -------------------------------- |
| `ui-ux-pro-max` | 27    | 50 styles, 21 palettes, 50 fonts |
| `app-builder`   | 20    | Full-stack scaffolding           |

---

## 📜 Scripts (2)

Master validation scripts that orchestrate skill-level scripts.

### Master Scripts

| Script          | Purpose                                 | When to Use              |
| --------------- | --------------------------------------- | ------------------------ |
| `checklist.py`  | Priority-based validation (Core checks) | Development, pre-commit  |
| `verify_all.py` | Comprehensive verification (All checks) | Pre-deployment, releases |

### Usage

```bash
# Quick validation during development
python .agent/scripts/checklist.py .

# Full verification before deployment
python .agent/scripts/verify_all.py . --url http://localhost:3000
```

### What They Check

**checklist.py** (Core checks):

- Security (vulnerabilities, secrets)
- Code Quality (lint, types)
- Schema Validation
- Test Suite
- UX Audit
- SEO Check

**verify_all.py** (Full suite):

- Everything in checklist.py PLUS:
- Lighthouse (Core Web Vitals)
- Playwright E2E
- Bundle Analysis
- Mobile Audit
- i18n Check

Les scripts sont listés dans [`scripts/`](scripts/).

---

## 📊 Statistics

| Metric              | Value                         |
| ------------------- | ----------------------------- |
| **Total Agents**    | 22                            |
| **Total Skills**    | 48                            |
| **Total Workflows** | 12                            |
| **Total Scripts**   | 2 (master) + 18 (skill-level) |
| **Coverage**        | ~90% web/mobile development   |

---

## 🛡️ Fallback & Robustesse

| Condition                  | Comportement                                            |
| -------------------------- | ------------------------------------------------------- |
| ARCHITECTURE.md absent     | Skip silencieux + log mémoire (tags='startup,fallback') |
| intelligent-routing absent | Routing manuel vers agents                              |
| agents vides               | Fallback 'mode orchestrator seul'                       |
| skills manquants           | Réponse générique + annonce 'Skills non chargés'        |

---

## 🔗 Quick Reference

| Need     | Agent                 | Skills                                |
| -------- | --------------------- | ------------------------------------- |
| Web App  | `frontend-specialist` | react-best-practices, frontend-design |
| API      | `backend-specialist`  | api-patterns, nodejs-best-practices   |
| Mobile   | `mobile-developer`    | mobile-design                         |
| Database | `database-architect`  | database-design, prisma-expert        |
| Security | `security-auditor`    | vulnerability-scanner                 |
| Testing  | `test-engineer`       | testing-patterns, webapp-testing      |
| Debug    | `debugger`            | systematic-debugging                  |
| Plan     | `project-planner`     | brainstorming, plan-writing           |
