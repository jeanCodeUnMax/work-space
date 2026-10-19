# Faisabilité — Durcissement orchestrateur + binôme Hephaistos2-Kit

Date : 2026-10-18 · Auteur : devin · Statut : rapport, rien d'implémenté
Périmètre : canonique `C:\Program Files\Projet-complet\hephaistos2-kit` (runtime `C:\Program Files\servers\hephaistos2-kit`)

## Réalité du terrain (correction de mes estimations)

- L'orchestrateur MCP est **Rust**, pas JS : `hphe/crates/hphe-kit/src/orch.rs` (1517 l.) exposé via `hphe/crates/hphe-mcp/src/tools/kit.rs` → `hphe-mcp.exe` (58 outils). Toute modification de `dispatch_task` = recompile du binaire + copie vers `servers/`.
- `orch.rs` lit déjà `provider_prefs` (enabled, position) pour le ranking — le respect de la chaîne existe en partie, il n'est pas appliqué au dispatch forcé.
- Le bus temps réel = `ws-bridge` JS dans l'extension `orchestrator-monitor` (poll `orchestrator.db` + tail `comms.jsonl`, `ws://127.0.0.1:7477`). Les correctifs "supervision" peuvent rester en JS ici.
- `agent-discipline.mjs` existe (workspace CLI-Anything) mais écrit SQLite directement → à porter en outil MCP.

## Matrice de faisabilité

| # | Suggestion | Où | Effort | Risque | Verdict |
|---|-----------|-----|--------|--------|---------|
| 1 | Gate de completion sur livrable (`expected_artifact` vérifié avant `completed`) | `hphe-kit/src/orch.rs` `update_task` + `dispatch_task` (nouveau champ) | M (Rust, ~100 l. + migration schéma) | Faible : vérif fs existe/mtime | **Faire en premier** — tue les faux succès |
| 2 | Fail-fast dispatch : `model`/`provider` vides → refus ; provider `enabled=0` → refus | `orch.rs` `dispatch_task` | S (~40 l.) | Aucun | **Faire en premier** — empêche #441/#452 |
| 3 | Capacités agent (`capabilities` : fs_read/fs_write/text_only/acp) refus au dispatch | Schéma `agents` + `dispatch_task` | M (migration + ~60 l.) | Faible | Fortement recommandé |
| 4 | Reaper heartbeat : tâche sans pulsation > N min → `failed` auto + event | `ws-bridge` JS + colonne `last_heartbeat` | M | Moyen : risque faux positif si worker long ; heartbeat = tick DB côté spawn | Recommandé |
| 5 | Persistance des pairs binôme (`established` en DB, rejoin auto) | `comms`/`binome.js` + table `pairs` | M | Faible | Recommandé |
| 6 | Fallback découverte ACP quand extension IDE absente (`session/list` providers directs) | `chat-id.js`/`acp-inject.js` | M | Moyen : opencode a `acp` stdio, agy a son hub ; pas uniforme | Utile mais partiel |
| 7 | Circuit breaker provider (échecs répétés → `enabled=0` temporaire + timestamp) | `orch.rs` + `model_health` (table déjà citée ligne 4) | M | Moyen : risque d'éteindre un provider sur erreur transitoire → hysteresis | Recommandé |
| 8 | `agent_discipline` → outil MCP (`discipline_agent`, `agent_status`) | `hphe-mcp` tools + `orch.rs` (table existe) | S | Aucun — supprime la violation SQL directe | **Faire** |
| 9 | QC formalisé : livrable → `verify_task` auto vers agent reviewer | `orch.rs` (hook post-completion) | M | Moyen : boucle infinie si reviewer lui-même produit un livrable → exclure verify de la cascade | Recommandé |

## Piste plugins IDE

L'extension `orchestrator-monitor` (VSIX, packaging via `package-vsix.sh`, déjà 59 versions) est le véhicule naturel :

- **Sidebar tâches temps réel** : le WS bridge existe — ajouter une WebView tree (tasks par statut, kill/retry en un clic). Effort M, valeur haute (visibilité sans chat).
- **Commandes palette** : `Hephaistos: Join Binome`, `: Kill Task`, `: Rejoin Last Pair` → masquent la fragilité du focus-onglet actuel. Effort S.
- **Status bar pair actif** : affiche `pairId` + peer — preuve visuelle du join. Effort S.
- **Reconnexion auto du client WS** : actuellement le list_acp_sessions meurt avec l'IDE ; l'extension devrait retry/backoff au démarrage. Effort S.
- Limite : l'extension ne voit que l'IDE qui l'héberge ; la supervision multi-IDE reste au ws-bridge/orchestrateur.

## Piste CLI supplémentaire

- **`cli-anything-hphe`** (ou `hphe-orch`) : harness CLI exposant dispatch/list/kill/verify/discipline sans passer par un IDE — pour cron, CI, ou un agent shell-only. Pattern identique aux cli-anything-* existants (entry `hphe-mcp` via stdio ou appel direct `orchestrator.db` en lecture + tools MCP en écriture). Effort S-M. **Valeur réelle** : permet à n'importe quel agent CLI de piloter l'orchestrateur sans MCP client.
- Alternative zero-code : `mcp-bridge` expose déjà les harnesses en tools MCP ; le faire dans l'autre sens (orchestrateur → CLI) est la nouveauté utile.

## Piste A2A (rappel)

Wrapper HTTP `/agent-card`+`/tasks` par agent — faisable (~300-500 l.) mais **n'ajoute rien en interne** ; à garder uniquement si fédération avec des agents externes A2A un jour.

## Ordre de mise en place proposé

1. **Rust** : items 2 + 3 + 8 (petits, groupés, une recompile) → puis 1 + 7 + 9.
2. **JS bridge/extension** : 4 + 5 + 6 + commandes palette + reconnexion WS.
3. **CLI** : `hphe-orch` une fois les gates stables.
4. Propagation obligatoire : chaque modif dans `Projet-complet/hephaistos2-kit` → vérifier divergence `servers/hephaistos2-kit`, `node --check`/`cargo check`, `fix-report-<date>.md`.

## Points d'attention

- Recompiler `hphe-mcp.exe` = redémarrer les sessions MCP actives → faire en fenêtre calme.
- `orchestrator.db` : migrations additives uniquement (colonnes/tables nouvelles), jamais de drop.
- Item 4 : le heartbeat doit venir du wrapper de spawn (`nim-worker.mjs`/templates), pas du worker lui-même.
