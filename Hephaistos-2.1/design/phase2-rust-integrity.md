---
titre: Phase 2 — Intégrité des livrables et santé providers (Rust)
statut: draft
date: 2026-10-18
---

# Phase 2 — Intégrité des livrables et santé providers

## Contexte

Deux faiblesses structurelles de l'orchestrateur Rust
(`hphe/crates/hphe-kit/src/orch.rs`, surface `hphe-mcp/src/tools/kit.rs`) :

1. **Faux succès** : un agent peut appeler `update_task status=completed`
   sans avoir produit le livrable demandé. `tool_update_task` (orch.rs:310)
   accepte le statut sans aucune vérification filesystem. C'est la source des
   « completed fantômes » constatés dans `task_events`.
2. **Providers en vrac réutilisés** : `model_health` est une table append-only
   de probes (`supplier, provider, model, available, latency_ms, checked_at` —
   `record_model_health`, orch.rs:1284). `pick_model` consulte la dernière
   probe par modèle (`recently_failed`, orch.rs:631) mais **rien ne coupe un
   provider entier** après des échecs consécutifs (402 quota, 503, timeout) :
   le dispatcher retente indéfiniment et enregistre des `dispatch_failed`.

Schéma confirmé au moment de la rédaction :

- `tasks_todo` : `id, title, description, priority, status, due_date,
  created_at, dependencies, assigned_to, result, task_type, model, provider,
  dispatcher` (+ colonnes posées en phase 1 : `expected_artifact`,
  `dispatched_at`, `parent_task_id`, `verified_by`, `last_heartbeat`).
- `provider_prefs` : `provider, enabled, position`.
- `model_health` : `id, supplier, provider, model, available, latency_ms,
  checked_at` — **append-only confirmé** ; le circuit breaker ne doit pas y
  écrire d'état (les compteurs vivent sur `provider_prefs`).

Toute la phase est Rust (objectif 2.1 : vélocité/légèreté, JS réservé à
l'IDE). Migrations additives uniquement (règle phase 1).

## Exigences fonctionnelles

### FR-2.1 — Contrat de livrable au dispatch

`dispatch_task` accepte `expected_artifact` : chemin absolu, relatif au
`workspace` de la tâche, ou glob (`src/**/*.rs`, `out/report-*.md`).
Persisté tel quel dans `tasks_todo.expected_artifact` + `dispatched_at =
now_iso()` posé à l'INSERT (référence temporelle du gate). `create_task`
accepte le même champ pour les tâches en file.

### FR-2.2 — Gate de completion

`update_task` avec `status='completed'` sur une tâche dont
`expected_artifact` est non vide :

1. Résoudre le motif : absolu → tel quel ; relatif → joint à `workspace`
   (ou cwd du worker si `workspace` NULL — refus si indéterminable).
2. Glob : au moins un fichier doit matcher ; chemin simple : existence.
3. `mtime(fichier) >= dispatched_at - 5s` (tolérance granularité FS/clock).
4. Échec → **refus** : statut inchangé, `task_events(event='artifact_gate',
   detail=code+fichier)`, erreur `ARTIFACT_MISSING` (-32045) ou
   `ARTIFACT_STALE` (-32046).
5. Succès → `completed` appliqué + `result` peut rester le résumé texte.

Exception : tâches sans `expected_artifact` (missions `text_only` — le gate
de phase 1 empêche déjà qu'on en exige un à un agent texte) → comportement
actuel inchangé. Pas de gate rétroactif sur les tâches créées avant la phase.

### FR-2.3 — Vérification automatique (verify_task)

Après chaque transition `completed` validée (y compris via le gate FR-2.2) :

- `update_task` déclenche une vérification : création d'une tâche fille
  `task_type='verify'` (template prompt dédié « relis le livrable X de la
  tâche N ») via `pick_agent_by_skill('review')` **≠ agent producteur**
  (exclure `assigned_to` de la tâche mère), `parent_task_id = id mère`.
- **Anti-boucle** : une tâche dont `parent_task_id IS NOT NULL` (ou
  `task_type='verify'`) ne déclenche jamais de verify à sa propre completion.
- Résultat : le reviewer écrit son verdict en `result` ; à sa completion,
  `tasks_todo.verified_by = <agent_id reviewer>` est posé sur la mère +
  `task_events(event='verified'|'verify_rejected')`. Verdict négatif → mère
  repasse `status='in_progress'` + event (règle : le reviewer appose
  `[REJECT]` en tête de `result` — convention documentée, pas de parsing
  fragile).
- Outil `verify_task {task_id}` exposé en MCP pour vérification manuelle
  (même chemin de code que le déclencheur auto, flag `manual`).

### FR-2.4 — Circuit breaker provider

État porté par `provider_prefs` (colonnes additives) :

```sql
ALTER TABLE provider_prefs ADD COLUMN breaker_failures INTEGER DEFAULT 0;
ALTER TABLE provider_prefs ADD COLUMN breaker_open_until TEXT;      -- ISO
ALTER TABLE provider_prefs ADD COLUMN breaker_last_error TEXT;
ALTER TABLE provider_prefs ADD COLUMN breaker_open_count INTEGER DEFAULT 0; -- hystérésis
```

- `record_provider_failure(conn, provider, err_kind)` : incrémente
  `breaker_failures`, mémorise `breaker_last_error`. Sources d'échec :
  (a) `update_task status=failed` dont `result` matche `402|503|timeout|
  timed out|rate.?limit` ; (b) `notify_agent` spawn `dispatch_failed` ;
  (c) probe `available_models` marquant le provider down. Success
  (`completed` sur un modèle du provider) → reset `breaker_failures=0`.
- **Ouverture** : `breaker_failures >= 3` → `breaker_open_until = now + 15min`,
  `breaker_open_count += 1`, `task_events(event='breaker_open')`. Le provider
  est traité comme `enabled=0` par `pick_model` **et** par le gate FR-1.2.
- **Hystérésis / réactivation** : lecture paresseuse — si
  `breaker_open_until <= now`, état **half-open** : le provider redevient
  éligible mais le prochain succès referme (`failures=0,
  open_until=NULL`) ; le prochain échec rouvre avec cooldown ×2 plafonné à
  120 min (`cooldown = 15 * 2^min(open_count-1, 3)`).
- `agent_status`/`status` (phase 4 CLI) expose l'état breaker par provider.

Paramètres : seuil **3** échecs consécutifs, cooldown **15 min**, tolérance
mtime **5 s**, TTL demi-ouvert = 1 tentative.

## Spécifications

### Schéma (additif)

```sql
-- posées en phase 1, consommées ici :
-- tasks_todo.expected_artifact TEXT
-- tasks_todo.dispatched_at   TEXT
-- tasks_todo.parent_task_id  INTEGER
-- tasks_todo.verified_by     INTEGER
ALTER TABLE tasks_todo ADD COLUMN verify_task_id INTEGER;  -- lien mère→fille
ALTER TABLE provider_prefs ADD COLUMN breaker_failures INTEGER DEFAULT 0;
ALTER TABLE provider_prefs ADD COLUMN breaker_open_until TEXT;
ALTER TABLE provider_prefs ADD COLUMN breaker_last_error TEXT;
ALTER TABLE provider_prefs ADD COLUMN breaker_open_count INTEGER DEFAULT 0;
```

Même mécanisme de migration idempotente qu'en phase 1 (`PRAGMA table_info`).

### Logique de gate (update_task)

```rust
fn artifact_gate(conn, task_id) -> Result<(), (i64, String)> {
    // charge expected_artifact, dispatched_at, workspace de la tâche
    // None/"" → Ok(())  // pas de contrat = pas de gate
    // resolve_path(ws, pattern); glob via matcher maison (* ? ** ) ou crate glob
    // exists ? mtime >= dispatched_at - 5s ?
    // Err((-32045, "ARTIFACT_MISSING ...")) | Err((-32046, "ARTIFACT_STALE ..."))
}
// dans tool_update_task, AVANT l'UPDATE status:
if args["status"] == "completed" { artifact_gate(conn, id)?; }
// APRÈS l'UPDATE status='completed':
if task.parent_task_id.is_none() && task.task_type != "verify" {
    spawn_verify(conn, &task)?;   // INSERT fille + notify reviewer
}
```

`spawn_verify` : `INSERT INTO tasks_todo (..., task_type='verify',
parent_task_id=mère, dispatcher='auto-verify')` + `notify_agent` reviewer ;
pose `verify_task_id` sur la mère. Si aucun reviewer actif →
`task_events(event='verify_skipped')` et la mère reste `completed` (la
vérif est un plus, pas un blocage).

### Outil MCP `verify_task`

```jsonc
// entrée : { "task_id": "string|number (requis)", "reviewer": "string (optionnel)" }
// sortie : { "verify_task_id": 517, "reviewer": "reviewer-1",
//           "parent": 512 } | { "skipped": true, "reason": "no_reviewer" }
// erreur : -32602 si la tâche cible n'existe pas ou n'est pas completed
//          -32043 CAPABILITY_MISMATCH si reviewer cible = text_only
```

### Signature élargie (rappel phase 1)

`dispatch_task`/`create_task` : `+ expected_artifact` ; `dispatch_task` pose
`dispatched_at` systématiquement (même sans artifact — sert à l'audit).

### Circuit breaker — interface interne

```rust
fn provider_enabled(conn, provider) -> bool;      // enabled=1 && !open
fn breaker_is_open(conn, provider) -> bool;       // open_until > now (lazy)
fn record_provider_failure(conn, provider, kind); // seuil → open + cooldown
fn record_provider_success(conn, provider);       // failures=0, close half-open
```

`pick_model` : `disabled` = `enabled=0 OR provider_enabled()==false`.
`dispatch_task` (gate FR-1.2) : provider forcé + breaker ouvert →
`PROVIDER_DISABLED` avec `details.retry_after = breaker_open_until`.

## Plan de test

Unitaires (`cargo test -p hphe-kit`, DB temporaire + tmpdir) :

1. `update_task completed` avec `expected_artifact` existant et mtime
   postérieur au dispatch → accepté.
2. Fichier absent → -32045, statut reste `in_progress`.
3. Fichier présent mais mtime antérieur à `dispatched_at - 5s` → -32046.
4. Glob `out/*.log` : match ok / aucun match → refus.
5. Tâche sans `expected_artifact` → completed accepté (régression zéro).
6. Completion mère → fille `verify` créée, `parent_task_id` correct,
   reviewer ≠ producteur ; completion fille → **pas** de petite-fille ;
   verdict `[REJECT]` → mère repasse `in_progress`, `verified_by` posé.
7. Breaker : 3 `record_provider_failure` → `open_until = +15min`,
   `pick_model` exclut le provider ; `open_until` passé → half-open,
   1 échec → cooldown 30min ; 1 succès → fermé, `failures=0`.
8. Migrations : double `with_db` → pas d'erreur, colonnes présentes.

Intégration :

- Dispatch réel `expected_artifact=fix-report-test.md` + worker qui ne
  produit rien → `completed` refusé côté client MCP.
- Provider simulé en échec (stub `available_models`) → 3ᵉ échec ouvre le
  breaker, `agent_status` montre `breaker` dans les détails provider.
- `cargo check -p hphe-kit -p hphe-mcp` propre ; propagation binaire
  canonique → `servers\hephaistos2-kit` + `PRAGMA table_info` sur la DB
  runtime ; `fix-report-2026-10-18.md`.

## Critères d'acceptation

- [ ] `completed` impossible si le livrable déclaré est absent ou plus vieux
      que le dispatch (tolérance 5 s).
- [ ] Toute completion mère spawne une vérif reviewer (sauf indisponible →
      event `verify_skipped`) ; aucune vérif de vérif possible.
- [ ] Verdict reviewer `[REJECT]` remet la mère en `in_progress`.
- [ ] 3 échecs consécutifs (402/503/timeout) ouvrent le breaker 15 min ;
      half-open auto ; échec half-open → cooldown doublé (plafond 120 min) ;
      succès → fermeture complète.
- [ ] `provider_prefs.enabled` n'est jamais réécrit par le breaker (état
      séparé, `enabled` reste une décision opérateur).
- [ ] Migrations additives idempotentes ; `cargo check` propre ; binaire
      propagé canonique → `servers`.

## Risques

- **Faux négatifs mtime** : horloge FS vs `dispatched_at` (UTC) — tolérance
  5 s + log `artifact_gate` avec les deux timestamps pour debug.
- **Agents qui complètent via `result` sans fichier** : résolu par
  l'absence d'`expected_artifact` — la charge est sur l'émetteur du dispatch
  de déclarer le contrat. Documenter dans les templates de prompt
  (`set_prompt_template` : « produire le fichier puis update_task »).
- **Reviewer indisponible** : vérif optionnelle (`verify_skipped`), jamais
  bloquante — risque accepté, monitoré via `task_events`.
- **Breaker sur erreur transitoire** : hystérésis half-open + cooldown
  exponentiel limitent l'aveuglement ; `record_provider_success` reset tôt.
- **Regex de détection d'erreur** (`402|503|timeout`) trop large → faux
  ouvertures : restreindre au préfixe de `result`/champ `error_kind` explicite
  si `update_task` gagne un param `error_kind` (évolution possible).
- **Recompile + propagation** : même procédure que phase 1, fenêtre calme.
