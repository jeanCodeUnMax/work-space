# P3 — Beacon watch stream (T-071)

**Composant livré :** mode `--watch` de `.agent/rag/beacon_ingest.py` —
bascule de l'ingest Beacon du *scan périodique par offset* vers l'*ingestion
incrémentale pilotée par le watch stream USN* du daemon `hphe-indexd`.

- **Spec :** `03-FAISABILITE-UNIFICATION.md` §2.1 et §3.4 (`beacon_ingest.py` →
  bascule watch stream) ; `04-PRD.md` ligne « Bascule `beacon_ingest` : watch
  stream au lieu de scans périodiques ».
- **Dépend de :** T-070 (crate `hphe-content` tantivy, terminé) et `pipe_client.py`
  (`HphePipeClient.watch()`, verbe `watch` NDJSON de `hphe-ipc`).
- **Branche :** `agent/task-342` (worktree isolé, base `dev`).

---

## 1. Ce qui change

| Avant (scan périodique) | Après (watch stream) |
|---|---|
| `beacon_ingest.py --once` relit tout l'offset JSONL à chaque run | événement USN touchant `runtime.jsonl` → `ingest_once` |
| cadence imposée (cron / tâche planifiée) | réactif : latence ≈ debounce |
| relecture complète même sans écriture | filtrage par chemin, debounce 2s anti-tempête |
| pipe absent = rien | fallback gracieux : polling 30s, log « fallback poll » |

Les flags historiques `--once / --dry-run / --limit / --reset / --log-path`
sont **intacts** (la logique d'ingest est extraite dans `ingest_once()`,
réutilisée telle quelle par le mode watch).

## 2. Architecture du mode `--watch`

```
runtime.jsonl (journal Beacon)
      │  écriture par le harness
      ▼
hphe-indexd (daemon) ──USN──▶ hphe-ipc verbe `watch` (NDJSON, pipe nommé)
      │                              │
      │                    HphePipeClient.watch(callback, volume)
      │                              │
      │                    _DebounceTrigger.on_event()
      │                       ├─ filtre _event_touches_log()
      │                       └─ debounce 2s (regroupe la rafale)
      │                              │
      └────────────── ingest_once() ◀┘   (offset + done + RAGPipeline)
```

- **Volume** : lettre du lecteur contenant `runtime.jsonl` (`_volume_of`).
- **Filtre** : `_event_touches_log` ne retient que les événements dont `path`
  (ou `name`) matche le répertoire + nom du journal — robuste aux séparateurs
  `/` vs `\`.
- **Debounce** : plusieurs événements rapprochés n'engendrent qu'un seul
  `ingest_once` (anti-tempête). L'annulation du timer est **synchrone** dans
  `on_event` pour garantir le regroupement même quand la boucle d'événements
  n'a pas encore repris la main.
- **Thread-safety** : le callback du pipe tourne dans le thread reader ; on
  repasse sur la loop principale via `call_soon_threadsafe`.
- **Fallback** : si `pipe_client` est absent, ou `is_pipe_available()` false,
  ou `connect()`/`watch()` échoue → `_poll_loop` (période `--watch-interval`,
  défaut 30s), avec log explicite.

## 3. Latence événement → ingest (mesurée, simulée)

Mesure : `bench/beacon-watch/measure_latency.py` (résultats bruts :
`bench/beacon-watch/latency-results.json`). Le `ingest_once` réel est remplacé
par un stub instantané : on isole la **latence du mécanisme watch + debounce**,
pas celle du pipeline d'indexation (chunking + embeddings + stores).

| Scénario | Résultat |
|---|---|
| **Overhead mécanisme** (debounce = 0) | **~0,17 ms** (médiane) |
| Événement isolé, debounce production 2,0 s | **~2014 ms** (médiane) ≈ debounce + ~14 ms |
| Rafale de 10 événements (5 ms d'écart) | **1 seul ingest** (coalesced ✓) |

Lecture : le coût ajouté par le mécanisme est négligeable (~0,2 ms). La
latence perçue est **dominée par le debounce**, paramètre assumé pour éviter
les tempêtes d'événements. Baisser `--debounce` réduit la latence au prix de
plus d'ingests ; 2,0 s est le défaut de production. La coalescence est
vérifiée : une rafale ne produit qu'un passage d'ingest.

> ⚠️ Ce bench ne mesure **pas** la latence USN réelle du daemon
> (hphe-indexd n'était pas démarré pendant la mesure) ni le temps
> d'indexation RAG. Un bench end-to-end daemon+pipe reste à faire lorsque
> `hphe-indexd` tourne sur la machine cible.

## 4. Tests

`tests/test_beacon_ingest_watch.py` — 9 tests, `python -m pytest` vert
(stable sur 3 exécutions consécutives) :

- **Filtre** : `_event_touches_log` matche le bon chemin/répertoire, rejette
  les fichiers non liés (`.bak`, autre répertoire, événement vide).
- **Volume** : `_volume_of` extrait la lettre de lecteur (C/F), défaut C.
- **Debounce** : une rafale de 5 événements < debounce → 1 seul ingest ;
  les événements non pertinents sont ignorés.
- **Watch chemin nominal** : pipe dispo → connexion, souscription sur le bon
  volume, événement pertinent → ingest (passe initiale + ingest débouncé),
  `unwatch` + `disconnect` appelés au final.
- **Fallback poll** : pipe absent → `_poll_loop` ; pipe annoncé dispo mais
  `connect()` en échec → bascule fallback.
- **Compat** : `ingest_once` reste appelable et renvoie un dict (pas
  d'exception sans journal).

Le client pipe est intégralement mocké (`FakePipeClientModule` /
`FakeHphePipeClient`) : aucun besoin de pywin32 ni du daemon pour tester.

## 5. Fichiers

| Fichier | Rôle |
|---|---|
| `.agent/rag/beacon_ingest.py` | mode `--watch` (livrable principal ; `.agent/` est gitignoré — copie de référence dans `bench/beacon-watch/`) |
| `tests/test_beacon_ingest_watch.py` | tests watch/debounce/fallback (tracké) |
| `bench/beacon-watch/measure_latency.py` | script de mesure (tracké) |
| `bench/beacon-watch/latency-results.json` | résultats bruts de latence (tracké) |
| `bench/beacon-watch/beacon_ingest.py.orig` | copie de l'original pré-modification (traçabilité, tracké) |
| `docs/hephaistos-engine/bench/p3-beacon-watch.md` | ce rapport |
| `pytest.ini` | `asyncio_mode = auto` (nécessaire aux tests async) |

## 6. Limites & suite

- Bench **simulé** : latence mesurée sur le mécanisme, pas sur le daemon réel.
- `hphe-indexd` doit tourner pour le chemin watch ; sinon fallback poll 30s
  (comportement vérifié par les tests).
- Piste : bench end-to-end avec `hphe-indexd` actif (latence USN réelle +
  temps d'indexation) quand le démon est déployé sur la cible.
