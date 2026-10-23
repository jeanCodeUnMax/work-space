# Rapport 13 — Audit global d'usage de `Hephaistos-everything-search` (2.1)

Date : 2026-10-19. Demandeur : Boss. Auditeur : Cash (`acp/devin-cli/whip-principle`), binôme sollicité : Luna (`acp/devin-cli/maple-lizard`, GPT-6 Luna Medium) — handshake envoyé via devin-hub, réponse en attente.

## Périmètre

Vérifier que tous les agents — ACP, CLI, local, cloud — utilisent `Hephaistos-everything-search` (hphe-mcp, 58+ outils) pour toute recherche (`everything_search`, `search_files`, `everything_count`, `content_search`, `semantic_search`, `hybrid_search`, `memory_search`), qu'aucun contournement n'est possible, et que la transition v2 → v2.1 est propagée partout.

## État vérifié — positif

| Surface | État | Preuve |
|---|---|---|
| Devin MCP config | hphe-mcp branché, outils live | `everything_search` via `mcp-call.mjs` : résultats hphe-pipe en ~1 s |
| mcp-mux | multiplexe `Hephaistos-everything-search` (env complets, mode shared/lazy) | `~/.config/mcp-mux/mcp-mux.json` |
| Agents via mux | kilo (`kilo.json`), hermes (`config.yaml`), opencode défaut (`opencode.json`) → hphe joignable | configs lues |
| Règles workspace `.agent/rules/global_rules.md` | v2.1 — mandat `everything_search`, interdiction scans récursifs, fallback mcp-call | lignes 60-64, 140 |
| `%APPDATA%/devin/AGENTS.md` | v2.1 — routage recherche hphe-mcp | lignes 53-82 |
| Windsurf `global_rules.md` | v2.1 idem | mémoire windsurf |
| `.agent/agents/memory-agent.md` | v3 alignée, anciens outils marqués absorbés | ligne 36 |
| `.agent/skills/hephaistos2-kit/SKILL.md` | inventaire complet des outils | §2 |
| Fallback CLI `mcp-call.mjs` | présent et fonctionnel | test live OK |
| nim-worker (cloud text-only) | lecture `file:` confinée au workspace (F3/C1) — lecture opérationnelle légitime, pas de découverte repo | `nim-worker.mjs` |

## Incohérences relevées et corrections appliquées

| # | Écart | Gravité | Correction |
|---|---|---|---|
| I1 | `opencode-hephaistos.json` : `"mcp": {}` — profil dédié sans AUCUN MCP, contournement total | Critique | hphe-mcp + mcp-mux injectés |
| I2 | `opencode-lean.json` : `"mcp": {}` — idem | Critique | hphe-mcp injecté (lean = minimal mais hphe obligatoire) |
| I3 | `~/.claude/CLAUDE.md` : section routage prioritaire v2 (Qdrant/Zvec/EMBED-FIRST) alors que §1857 les déclare absorbés — contradiction interne, mandat erroné en always-on | Critique | bloc routage remplacé par routage hphe-mcp |
| I4 | `~/.config/opencode/AGENTS.md` : même bloc v2 (Qdrant/Zvec) | Critique | idem |
| I5 | Pas de `AGENTS.md` à la racine du workspace — les CLI spawnés par `dispatch_task` (kilo run, hermes -z, opencode run) ne chargent aucun mandat de recherche | Haute | `AGENTS.md` créé : mandat Hephaistos-first + orchestrateur unique + anti-scans |
| I6 | `sync-agent-layer.ps1` ne propageait pas `AGENTS.md` aux projets cibles | Moyenne | ajouté aux RootFiles |

## Manquements structurels restants (ouverts)

| # | Écart | Statut |
|---|---|---|
| O1 | `dispatch_task` ne vérifie pas que le provider cible expose hphe-mcp — un agent sans MCP peut recevoir une tâche d'exploration | Tâche orchestrateur #555 créée (fail-closed gate) |
| O2 | `mcp-mux` multiplexait `beacon` (read) | **Résolu** — retiré du mux ; `beacon` read supprimé partout ; `beacon-rw` réservé aux orchestrateurs Devin + AGY (directive : seuls devin et agy utilisent la chaîne). AGY basculé `beacon`→`beacon-rw` |
| O3 | Configs de repli `.bak-*` (opencode-nim, opencode-ollama, etc.) — si réactivées, certaines n'ont pas hphe | Documenté — ne pas réactiver sans audit |
| O4 | `dispatch_task` spawn les CLI dans le workspace ; le mandat n'atteint l'agent que si `AGENTS.md` est lu par son CLI — désormais présent, mais l'application reste par convention, pas par contrainte technique | Lié à O1 |
| O5 | `.agent/agent-bridge/*.js` font des lectures fs directes (queue, state.vscdb, comms.jsonl) — lectures opérationnelles légitimes (état runtime), PAS découverte repo ; règle explicitée dans AGENTS.md | Accepté par classification |

## Points v2 → v2.1 propagés

- Watchdog : auto-start extension + respawn backoff ✅, `tasks.json` ✅, scaffold `project_init` ✅, sync vers autres workspaces ✅
- Discipline Rust + FR-04 (`active` sync) ✅
- Commandes binôme extension 0.0.61 ✅
- Gates artefacts/confinement/timing-safe/SQL bindé ✅

## Décisions Beacon (2026-10-19, ordre Boss)

- `beacon` (read, `beacon.exe mcp serve`) : **retiré de toutes les surfaces** — Devin (fait précédemment), AGY (remplacé), mcp-mux (retiré).
- `beacon-rw` (write, `~/.beacon/beacon-rw/server.js`) : **réservé aux orchestrateurs** — Devin (Cash) ✅ déjà présent, AGY (Tango) ✅ basculé. Aucun worker ACP/CLI ne le reçoit : l'écriture mémoire des workers passe par le pipeline d'ingestion (`beacon_ingest` hphe-mcp), pas par des writes directs.
- Références `beacon.search_*` dans `~/.config/opencode/AGENTS.md` mises à jour → `memory_search`/`hybrid_search`/`semantic_search` hphe-mcp.
- Note : `nim-router` reste dans le mux mais `disabled: true` (absorbé hphe-mcp) — conservé documenté.
- ⚠️ Effet : les outils `beacon.search_activity`/`summarize_activity`/`search_memory`/`get_memory_context` ne sont exposés nulle part. La lecture du journal d'activité brut n'est plus possible via MCP — ingestion uniquement. Backups : `*.bak-beacon-20261019` / `*.bak-beaconrw-20261019`.

## Preuves live

- `everything_search` via `mcp-call.mjs` : OK (~1 s, backend hphe-pipe)
- JSON des deux configs opencode corrigées : validés
- `hphe_health` : healthy, pipe connecté
