---
name: hephaistos-kit
description: "Kit d'infrastructure agent injectable : installe/met à jour le standard .agent/ (règles, skills, agents, workflows, scripts) dans un projet. À invoquer pour injecter, mettre à jour, restaurer ou réparer la configuration agent d'un projet, ou quand l'utilisateur dit 'hephaistos', 'injecte le kit', 'répare .agent'."
---

# Hephaistos2-Kit — infrastructure agent injectable

> Le kit est le **template canonique** de l'infrastructure agent. Un projet injecté reçoit
> `.agent/` complet + `.vscode/`. Source : `github.com/projet-temporaire/hephaistos2-kit`.
> Template local : `<KIT_ROOT>`.

## Ce que le kit injecte

| Élément | Rôle |
|---|---|
| `.agent/rules/global_rules.md` | Règles universelles (délégation CLI, OpenCLI/puppeteer, uv, mémoire unifiée) |
| `.agent/agents/*.md` | Définitions d'agents + triggers de routage |
| `.agent/skills/*/` | 45 skills métier (dont `hephaistos-kit`, `orchestrator`, `boost`, `chat-id-project`, `jointes-project`) |
| `.devin/` | Règles (`.devin/rules/`) et skills (`.devin/skills/`) locales Devin (dont `chat-id-project`, `jointes-project`) |
| `.agent/workflows/`, `knowledge/`, `memory/` | Workflows slash-commands, docs mémoire |
| `.agent/scripts/` | Infra : `start-workspace.ps1`, `beacon-sync.ps1`, `ingest-workspace.ps1`, `auto-ingest.ps1`, `memory-maintenance.ps1`, `console-hider.ps1`, `sync-agent-layer.ps1`… |
| `.agent/devin/`, `.agent/hermes/` | Hooks Devin + couche Hermes |
| `.agent/REGISTRY.md` | Registre agents/providers + **agent par défaut** |
| `.vscode/` | Configs MCP partagées |

## Commandes réelles (pas de binaire `hephaistos-kit` — scripts PowerShell)

```powershell
# Injection/sync des couches .agent/ et .devin/ vers un projet cible :
.agent/scripts/sync-agent-layer.ps1 -Target <projet>   # copie hash-compare, préserve local_rules.md, .devin existant + runtime
.agent/scripts/init-project.ps1 -ProjectName <nom>     # init complète d'un nouveau projet
.agent/bootstrap.ps1                                   # bootstrap workspace (auto-ingest)
```

Le kit se propage par ces scripts — il n'existe pas d'exécutable `bin/hephaistos-kit.js`.

## Préservations automatiques (update/--force)

Le kit ne détruit **jamais** :
- `.agent/memory-database/` — index vectoriels/caches du projet
- `.agent/rules/local_rules.md` — règles spécifiques au projet

Si un dossier est verrouillé (`EBUSY`), fallback merge-copy au lieu d'échouer.
Sont exclus de la copie : `*.log`, `*.pid`, `__pycache__`, `node_modules`.

## Réparer une injection ratée / .agent corrompu

1. **Processus résiduels** : tuer `hphe-rest`, `bridge.js` (orchestrator-monitor),
   scripts `.agent/` — un watcher ouvert verrouille les dossiers (EBUSY).
2. **Injection partielle** (`.agent` à moitié vide) : relancer `init --force` —
   le merge-copy complète sans rien perdre.
3. **Dossier zombie** (handle fantôme qui refuse rmdir même après kill) : le
   merge-copy le remplit quand même ; un reboot libère le handle résiduel.
4. **`local_rules.md` perdu** (cas ancien kit) : `git checkout .agent/rules/local_rules.md`.
5. **Vérification post-injection** : `REGISTRY.md` présent, `local_rules.md` intact,
   `memory-database/` non vide si données, `git status` → review du diff.

## Après injection dans un projet

- Committer `.agent/` (sauf fichiers runtime gitignorés : `*.log`, `*.pid`, `.ingestion-state.json`).
- Vérifier que le projet tourne toujours (tests).
- Le `local_rules.md` du projet complète — jamais remplacé par — les règles globales.

## Modifier le kit lui-même

Le template vit dans le repo `Hephaistos2-Kit` : éditer `.agent/` à la racine du repo,
commit, push → la prochaine injection embarque la modif. Ne jamais y mettre de
données runtime (logs, pids, bases) ni de secrets.

## Stack MCP — unifiée dans hphe-mcp

La stack MCP multi-serveurs v1 (orchestrator-server, agentmemory, nim-router,
model-discovery, qdrant, zvec, memory-f…) est **absorbée** dans le serveur unique
`extension/server/hphe-mcp.exe` (58 outils, Rust). Devin le déclare en direct dans
`%APPDATA%/devin/mcp_config.json` ; les sous-agents CLI y accèdent via `mcp-mux`
(profil `EVERYTHING_MCP_AGENT=external`, lecture bornée) — sauf `agy`, démuxé en
direct. Voir `docs/MCP-TOOLS.md` pour la liste des outils.
