---
titre: Phase 1 — Durcissement du dispatch (gates Rust)
statut: draft
date: 2026-10-18
---

# Phase 1 — Durcissement du dispatch

## Contexte

L'orchestrateur est le binaire Rust `hphe-mcp.exe` (58 outils) dont la logique
vit dans `hphe/crates/hphe-kit/src/orch.rs`, exposée via
`hphe/crates/hphe-mcp/src/tools/kit.rs` (`execute_kit_tool` → `orch::tool_*`).
Base : `data/orchestrator.db` (rusqlite, WAL, `busy_timeout=5000`).

Constats terrain (audit 2026-10-18) :

- `tool_dispatch_task` (orch.rs:1138) insère la tâche **même si `pick_model`
  retourne `None`** : `unwrap_or_default()` produit `model=""`, `provider=""`
  → tâches zombies sans cible (incidents #441/#452).
- `pick_model` (orch.rs:569) honore `provider_prefs.enabled` pour le ranking
  automatique mais **un `provider` forcé en argument n'est jamais validé**
  contre `provider_prefs.enabled=0`.
- Aucune notion de capacité agent : un agent texte pur (NIM `nim1`/`nim2`,
  `nvidia-nim`/`nvidia-nim2`, API chat sans tools fichiers) peut recevoir une
  mission « produis un fichier » qu'il ne peut pas livrer.
- `agent-discipline.mjs` (`.agent/scripts/`) écrit SQLite directement —
  violation de la règle « orchestrateur = seul canal ». À porter en MCP.

Principe directeur 2.1 : **maximum en Rust**, JS uniquement là où l'IDE
l'impose. Toutes les modifications de cette phase sont dans `hphe-kit` +
`hphe-mcp` — une seule recompilation.

Fichiers concernés :

- `hphe/crates/hphe-kit/src/orch.rs` — gates + migrations + discipline
- `hphe/crates/hphe-mcp/src/tools/kit.rs` — `kit_tool_definitions()` (schémas)
  et `execute_kit_tool()` (routage)
- Propagation : canonique `C:\Program Files\Projet-complet\hephaistos2-kit`
  → runtime `C:\Program Files\servers\hephaistos2-kit` (binaire + DB partagée).

## Exigences fonctionnelles

### FR-1.1 — Refus si modèle/provider vide

`dispatch_task` refuse **avant tout INSERT** si le routage (`pick_model` ou
forçage) aboutit à `model` vide/absent ou `provider` vide/absent. Aucune ligne
`tasks_todo`, aucun `task_events`, aucun `notify_agent` ne doit résulter d'un
dispatch refusé : la validation précède la transaction d'insertion.

### FR-1.2 — Refus si provider désactivé

Si `provider` est passé explicitement (forçage) et que
`provider_prefs.enabled = 0` (ou `provider_prefs.breaker_open_until` futur —
cf. phase 2 — est dans le futur) pour ce provider → refus immédiat, même si le
modèle est sain. Un provider absent de `provider_prefs` n'est **pas** refusé
(pas de ligne = pas de préférence exprimée, comportement legacy).

### FR-1.3 — Capacités agent

Nouvelle colonne `agents.capabilities` (TEXT, JSON array). Valeurs reconnues :
`fs_read`, `fs_write`, `text_only`, `acp`, `hub`.

- `NULL`/absent → héritage `config.capabilities` si présent, sinon
  `["fs_read","fs_write"]` (compat descendante : les agents CLI existants ont
  des outils fichiers).
- `text_only` est **exclusif** : s'il est présent, `fs_write`/`fs_read` sont
  ignorés.
- Agents dont le runtime est un appel chat pur (nim1, nim2, providers API sans
  tools) → `capabilities = '["text_only"]'`.

Règle de gate au dispatch : si la mission exige un livrable fichier —
`expected_artifact` non vide (phase 2) **ou** `task_type` dans
`{code, debug, test}` (ensemble `FILE_TASK_TYPES`, constante) — alors l'agent
doit posséder `fs_write`. Agent `text_only` → refus. Les task_types
`explore`/`docs`/`review` restent éligibles aux agents texte (livrable =
`result` texte via `update_task`).

### FR-1.4 — Migration additive de schéma

Toute évolution de schéma est **strictement additive** : `ALTER TABLE ... ADD
COLUMN` (idempotent, garde `PRAGMA table_info`), `CREATE TABLE IF NOT EXISTS`.
Jamais de `DROP`, jamais de recréation. Les migrations tournent dans
`with_db` au premier accès (même point d'entrée que `seed_templates`), donc
appliquées par n'importe quel binaire utilisant `hphe-kit`.

```sql
ALTER TABLE agents ADD COLUMN capabilities TEXT;            -- gardé par table_info
ALTER TABLE tasks_todo ADD COLUMN expected_artifact TEXT;   -- posé en phase 1, gate en phase 2
ALTER TABLE tasks_todo ADD COLUMN dispatched_at TEXT;       -- référence mtime (phase 2)
ALTER TABLE tasks_todo ADD COLUMN parent_task_id INTEGER;   -- cascade verify (phase 2)
ALTER TABLE tasks_todo ADD COLUMN verified_by INTEGER;
ALTER TABLE tasks_todo ADD COLUMN last_heartbeat TEXT;      -- reaper (phase 3)
CREATE TABLE IF NOT EXISTS agent_discipline (
  agent_name TEXT PRIMARY KEY,
  score INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'nominal',
  last_penalty INTEGER DEFAULT 0,
  last_reason TEXT,
  penalties_count INTEGER DEFAULT 0,
  rewards_count INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

### FR-1.5 — Discipline en MCP

Portage 1:1 de `agent-discipline.mjs` en Rust. Sémantique à reproduire
exactement (source de vérité : `.agent/scripts/agent-discipline.mjs`) :

- Score initial 100, status `nominal`.
- `penalize` : `score = max(0, score - |points|)` ;
  `<80 → probation`, `<50 → quarantine`, `<20 → euthanized`.
- `<20` → `UPDATE agents SET active=0` (débranché, invisible à
  `pick_agent_by_skill`).
- `reward` : `score = min(100, score + |points|)` ; si nouveau score `>= 50`
  et score précédent `<20` → `agents.active=1` (réhabilitation).
- Insertion paresseuse : premier appel sur un agent inconnu crée sa ligne à
  100/`nominal`.
- Chaque penalize/reward écrit un `task_events` (`event='discipline'` avec
  `task_id='agent:<name>'`) **et** un append `.agent/comms.jsonl` best-effort
  pour visibilité monitor.

## Spécifications

### Signatures des outils MCP (kit_tool_definitions / execute_kit_tool)

`dispatch_task` — schéma enrichi (rétrocompatible) :

```jsonc
{
  "title":             "string (requis)",
  "task_type":         "code|debug|review|docs|test|explore (requis)",
  "context":           "string",
  "files":             "string[]",
  "priority":          "low|medium|high",
  "agent_name":        "string  // forçage agent",
  "provider":          "string  // forçage provider — validé vs provider_prefs",
  "model":             "string  // forçage modèle",
  "workspace":         "string",
  "worktree":          "boolean",
  "session":           "string",
  "expected_artifact": "string  // chemin ou glob du livrable attendu (nouveau)"
}
```

Retour inchangé `{task_id, agent, model, provider, template_used, workspace,
worktree, notify}` + `"gates": {"provider_enabled": true, "capabilities": [...]}`.

`create_task` — inchangé + champ optionnel `expected_artifact` (la tâche
`pending` porte le contrat pour un dispatch ultérieur) et `task_type`.

`update_task` — inchangé en phase 1 (le gate livrable arrive en phase 2).

`discipline_agent` — nouveau (annotations `destructiveHint`) :

```jsonc
// entrée
{
  "agent_name": "string (requis)",
  "action":     "penalize|reward (requis)",
  "points":     "integer > 0 (requis)",
  "reason":     "string (requis)"
}
// sortie
{ "agent_name": "kilo-1", "score": 60, "status": "probation",
  "active": 1, "penalties_count": 2, "rewards_count": 0 }
```

`agent_status` — nouveau (readOnly) :

```jsonc
// entrée : { "agent_name": "string (optionnel)" }
// sortie : tableau trié score ASC — ou l'agent seul si filtré
[{ "agent_name": "...", "score": 60, "status": "probation",
   "last_penalty": 20, "last_reason": "...",
   "penalties_count": 2, "rewards_count": 1, "updated_at": "...",
   "capabilities": ["fs_read","fs_write"], "active": 1 }]
```

### Codes d'erreur

Aujourd'hui les outils renvoient `Result<Value, String>` → `isError: true`
côté MCP. Convention proposée : le string devient un JSON sérialisé
`{"code":"<ERR_CODE>","message":"...","details":{...}}` que les clients
parsent ; en transport JSON-RPC nu, mapper sur la plage serveur
`-32040..-32049` (`protocol.rs` définit déjà les codes standard
-32700/-32600/-32601/-32602/-32603).

| code JSON-RPC | code métier        | condition                                       |
|---------------|--------------------|-------------------------------------------------|
| -32041        | `EMPTY_MODEL`      | model/provider vide après routage ou forçage    |
| -32042        | `PROVIDER_DISABLED`| provider forcé avec `provider_prefs.enabled=0`  |
| -32043        | `CAPABILITY_MISMATCH` | agent text_only + mission à livrable fichier |
| -32044        | `AGENT_INACTIVE`   | agent forcé `active=0` ou `euthanized`          |
| -32045        | `ARTIFACT_MISSING` | (phase 2) livrable absent à la completion       |
| -32046        | `ARTIFACT_STALE`   | (phase 2) mtime < dispatched_at                 |
| -32602        | invalid params     | points <= 0, action inconnue, agent introuvable |

### Ordre des gates dans `tool_dispatch_task`

```
1. args → title requis (existant)
2. agent : forcé → find_agent + active=1 + status discipline != 'euthanized'
          sinon → pick_agent_by_skill (agents.active=1 déjà filtré)
3. CAPABILITY_MISMATCH : FILE_TASK_TYPES ou expected_artifact → fs_write requis
4. PROVIDER_DISABLED : provider forcé → provider_prefs.enabled=1 exigé
5. pick_model → EMPTY_MODEL si model/provider vide
6. INSERT tasks_todo (avec expected_artifact, dispatched_at=now_iso())
7. notify_agent → statut selon résultat spawn (logique existante inchangée)
```

Chaque refus écrit `task_events(event='gate_refused', detail=code)` sur un
`task_id` synthétique `gate:<ts>` pour auditabilité sans polluer `tasks_todo` —
ou simplement log stderr hphe-mcp + erreur structurée au client (choix à
l'implémentation, privilégier le plus simple).

## Plan de test

Unitaires (`cargo test -p hphe-kit`) :

1. `pick_model` forcé sur provider `enabled=0` → gate refuse (fixture
   `provider_prefs` en DB temporaire).
2. Dispatch `task_type=code` + agent `capabilities='["text_only"]'` →
   `CAPABILITY_MISMATCH`.
3. Dispatch `task_type=explore` + agent `text_only` → accepté.
4. `available_models` vide → `EMPTY_MODEL`, zéro ligne `tasks_todo` créée
   (count avant/après identique).
5. `discipline_agent` penalize 85 → score 15, status `euthanized`,
   `agents.active=0` ; reward 40 → score 55, `active=1`.
6. Migration idempotente : double ouverture `with_db` sur DB pré-existante
   sans colonnes → aucune erreur, colonnes présentes.
7. `agent_status` filtré/non filtré → tri score ASC, join `agents.active`.

Intégration dispatch réel :

- `dispatch_task` avec `provider="openrouter-free"` alors que
  `provider_prefs.enabled=0` → refus -32042 côté client MCP.
- `dispatch_task` nominal (kilo, provider sain) → accepté, `gates` présent.
- `cargo check -p hphe-kit -p hphe-mcp` propre, recompile, copie
  `hphe-mcp.exe` canonique → `servers\hephaistos2-kit`, redémarrage sessions
  MCP en fenêtre calme, `fix-report-2026-10-18.md` mis à jour.

## Critères d'acceptation

- [ ] Aucun dispatch n'insère de tâche avec `model`/`provider` vide.
- [ ] Forcer un provider `enabled=0` renvoie `PROVIDER_DISABLED` (-32042).
- [ ] Agent `text_only` + task_type fichier → `CAPABILITY_MISMATCH` (-32043).
- [ ] `discipline_agent` reproduit les seuils 80/50/20 et le basculement
      `agents.active`, sans aucun accès SQLite externe.
- [ ] `agent-discipline.mjs` marqué déprécié (commentaire + renvoi vers
      l'outil MCP), les appels historiques redirigés.
- [ ] Migrations additives uniquement, idempotentes, `PRAGMA table_info`
      vérifié sur la DB `servers` post-déploiement.
- [ ] `cargo check` propre ; binaire propagé canonique → `servers`.

## Risques

- **Agents legacy sans `capabilities`** : traités `fs_*` par défaut → pas de
  régression ; l'enrôlement text_only exige une passe `update_agent` /
  `register_agent` sur nim1/nim2 (checklist déploiement).
- **Refus EMPTY_MODEL sur infra dégradée** : si `available_models` échoue en
  global, tout dispatch échoue. Mitigation : message d'erreur explicite +
  `task_events`, pas de fallback silencieux (c'est le but du durcissement).
- **Recompile = redémarrage sessions MCP** : fenêtre calme obligatoire.
- **Discipline vs `active=0` manuel** : un reward `>=50` réactive un agent
  désactivé manuellement → documenter que `active` est désormais géré par la
  discipline, ou ajouter `manual_hold` (hors scope phase 1).
- **`text_only` exclusif** : un agent `["text_only","fs_write"]` est text_only
  — documenter l'exclusivité pour éviter les configs incohérentes.
