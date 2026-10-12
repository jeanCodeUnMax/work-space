# REGISTRE INFRASTRUCTURE — source de vérité
Dernière vérification : 2026-10-05. Mettre à jour à chaque changement d'agent/provider/MCP.

## Agent exécutant par défaut

**`agy`** (abonnement, tous skills `*`, incl. `generate_image`).
Toute délégation sans précision d'agent va à cet agent. Pour changer le défaut : modifier cette ligne, pas les règles. Fallbacks one-shot : `kilo` (code) → `hermes` (debug/docs).

## Agents exécutants (enregistrés dans l'orchestrateur)

| Agent | Type | Skills | Commande | Quota |
|---|---|---|---|---|
| `agy` | CLI Antigravity | tous (`*`) | `agy.exe --dangerously-skip-permissions --print="{msg}" --print-timeout 600s` | Abonnement — **toujours dispo**, modèles Gemini/Claude via `--model` |
| `vibe` | CLI Mistral Vibe | code, review, docs, test, refactor | `vibe.exe -p "{msg}" --max-turns 40` | Mistral Coder — **requêtes illimitées** |
| `kilo-nim1` | KiloCode CLI → NIM | explore, code, docs | `kilo run -m "{nim-model}"` | Canal NIM agentique — **validé #309 (~3 min)** |
| `ollama-cloud` | Hermes CLI (scopé) | code, review, docs, explore | `hermes -z "{msg}" -m "{model}" --provider ollama-cloud` | Forfait payé — **1 connexion à la fois** |
| `devin` | Agent principal | architecture, orchestration | — | Agent IDE principal |

**NIM non-agentique** : appel direct via les outils `nim_*` du MCP `nim-router` (sous-appels invoqués par Devin/agent CLI — embeddings, raisonnement, rédaction).

**Désactivés (2026-10-12, `active: 0`)** : `kilo`, `kilo-free`, `hermes` — dernier recours absolu, modèles NIM uniquement.

**Clôture obligatoire** : toute tâche dispatchée doit se terminer par `update_task(task_id, status, result)` — l'orchestrateur auto-marque `completed` à la sortie du process, quitter sans `result` = tâche perdue (cf. #308). Devin vérifie le livrable sur disque.

**Routage wake-up (règle 2026-10-12)** : l'extension Monitor réveille Devin (`sendCascadeInput`) uniquement si la description de la tâche contient `cascade: <uuid-de-la-session>` (ou `conv:`/`agycascade:`). L'uuid = `.pb` vivant dans `~/.codeium/windsurf/cascade/` (le seul non `.archived`, réécrit en continu). Sans tag → `(non routé)`, wake perdu volontairement. Toute tâche dispatchée par Devin DOIT porter le tag de la session courante. Watcher filet de secours : `.agent/task-watch.cjs` → `task-events.log`.

## Providers & modèles — ordre de priorité (politique 2026-10-06)

**Tâches courantes / rapides / lourdes / importantes → modèles free dans cet ordre :**

| Priorité | Provider | État | Modèles notables | Usage |
|---|---|---|---|---|
| **1** | `nvidia-nim` (NIM1) | ✅ | 80+ modèles servis : nemotron-3-embed-1b (2048D), nemotron-3-super-120b-a12b, lightning-30b… | **Embeddings (tous stores)** + chat cloud `nim_chat` — clé `NVIDIA_API_KEY` |
| **2** | `nvidia-nim2` (NIM2) | ✅ | même catalogue | Fallback compte 1 : `NVIDIA_API_KEY_2` — `nim_* account:2`, ACP `nim2`, fallback auto `router.py` sur 429 |
| **3** | `ollama-cloud` | ⚠️ quota mensuel (épuisé au relevé 10-05) | gpt-oss:120b-cloud, nemotron-3-ultra:cloud, gemma4:31b-cloud… | Via daemon local `:11434`, suffixe `:cloud` |

**Automatismes et tâches parallélisées → agents multi-modèles :**

| Agent | Rôle |
|---|---|
| `kilo` (KiloCode) | automatisations, tâches parallèles — providers `nvidia-nim → nvidia-nim2 → ollama-cloud → openrouter-free` |
| `hermes` | automatisations, tâches parallèles — mêmes providers |

**Suppléments / dernier recours :**

| Provider | État | Usage |
|---|---|---|
| `openrouter-free` | ✅ ~24 modèles `:free` | **Supplément uniquement**, en cas de manquement des modèles externes (1000 req/jour) |
| `huggingface` | ✅ clé `HF_TOKEN` | API directe + supplier `hf`. **ACP désactivé** : fenêtre 131k < prompt opencode |
| `nous` portal | ✅ auth hermes | laguna-xs/s-2.1 `:free` — fallback hermes |
| `antigravity` (agy) | ✅ abonnement | Agent à tout faire garanti, modèles Gemini/Claude |

**Hors service :**

| Provider | État | Raison |
|---|---|---|
| `ollama` local (:11434) | ✅ UP | ⚠️ **réservé à l'utilisateur** — jamais pour l'automatisation |
| llama.cpp | ⚠️ aucun GGUF | inutilisable sans télécharger un modèle |
| `gemini` CLI (api-key) | ✅ opérationnel | `GEMINI_API_KEY` + `selectedType:"gemini-api-key"` — ≠ `agy` (CANON) |

## Orchestrateur MCP v2 (fork local, `<HEPHAISTOS_ROOT>\mcp\servers\orchestrator-server`)

Outils : `create_task` `update_task` `get_next_task` `register_agent` `update_agent` `list_agents` `list_tasks` `delete_task` **`dispatch_task`** `suggest_agent` `available_models` `set_prompt_template` `list_prompt_templates`

- `dispatch_task(title, task_type, context, files, workspace)` : choisit l'agent par skill → sonde les modèles free live (cache 60 s) → rend le prompt du rôle → crée+assigne+notifie le CLI.
- Rôles de prompt seedés : `code` `debug` `review` `docs` `test` `explore` (placeholders `{{task}} {{context}} {{files}} {{model}}`).
- Config agent JSON : `{skills:[], providers:[], command:"…{message} {model} {provider} {workspace}…", model_prefs:[], full_prompt:true/false}`.

## MCP actifs (Devin)

**17 directs** (2026-10-08) : agentmemory, filesystem, qdrant, sqlite-node, zvec, orchestrator, model-discovery, kaggle, colab-mcp, notebooks, beacon, **nim-router**, google-drive, github-mcp-server, puppeteer, data-agent-kit, visualization.

**`mcp-mux` n'est plus dans Devin** — 13 de ses 17 serveurs doublonnaient les directs (~176 schémas facturés par appel). Mux = pipeline des **sub-agents** (`opencode-*.json`, kilo). Mux-only restants : `memory`, `memory-f`, `context7`, `postgres`.

- `nim-router` : serveur autonome, package `nim-router-mcp` (sous-module `mcp/servers/nim-router-mcp` du kit : `nim_mcp_server.py` + `router.py` + `registre-modeles.json`). **Enregistré aux deux endroits** (même chemin absolu, synchronisés) : `%APPDATA%/devin/mcp_config.json` (serveur direct Devin, outils `nim_*` natifs) et `~/.config/mcp-mux/mcp-mux.json` (mux multi-clients, outils `mcp-mux.nim-router__nim_*` via mcporter). En cas de `Failed to connect/initialize` : vérifier le chemin dans les DEUX fichiers — ils se modifient indépendamment.
- `agy.exe` : `%LOCALAPPDATA%\agy\bin` est dans le **PATH utilisateur** (persistant). Un shell déjà ouvert conserve l'ancien PATH → rouvrir un shell, ou `export PATH="$PATH:$LOCALAPPDATA/agy/bin"` (bash) / `$env:Path += ";$env:LOCALAPPDATA\agy\bin"` (PowerShell). Ne jamais créer d'alias ou de shim.

## Règles d'usage

0. « **Sous-agents** » = les CLI agents externes (`agy`, `kilo`, `hermes`) délégués via `orchestrator.dispatch_task` / `acp-dispatch.mjs` / appel direct — distincts des *sub-agents* internes à l'IDE.
1. Toute délégation → `orchestrator.dispatch_task`, jamais de prompt CLI à la main.
2. `suggest_agent` en cas de doute sur le bon agent.
3. Modèle précis souhaité → `model_prefs` de l'agent via `update_agent`.
4. Nouveau rôle récurrent → `set_prompt_template` au lieu de réécrire le prompt.
5. Gemini CLI (`gemini-api-key`) ≠ `agy` (Antigravity) — deux canaux distincts, jamais interchangeables.
6. **Ordre des providers = `provider_prefs` dans `orchestrator.db`**, piloté par l'extension monitor — table ci-dessus indicative ; l'ordre réel runtime = l'UI. Dérogation uniquement sur demande explicite.

## Problèmes connus

- ~~Collecteur Beacon non supervisé~~ → **RÉSOLU** : service Windows `BeaconCollector` (démarrage automatique), survit au logout.
- llama.cpp sans modèle — inutilisé.
- Orchestrateur présent dans Devin direct ET mcp-mux : **volontaire**, même DB partagée (WAL). Ne pas "corriger".
- HF en ACP : désactivé (fenêtre 131k < prompt opencode ~128k).
