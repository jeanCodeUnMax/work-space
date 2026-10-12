# P8 — Migration Qdrant → hphe-vec (T-082) : bascule et rollback

**Date** : 2025-12-10 — statut : chemin validé de bout en bout, bascule prête.
**Prérequis validé** : gate P4 réel PASS (`p4-real.md`) — recall toléré 1.0000 sur
5 collections réelles 2048D, latence usearch ~18× meilleure que Qdrant.

## 1. Export Qdrant (read-only)

```bash
# Toutes les collections, ou --collections a,b,c ; --sample N pour sous-ensemble
python tools/export_qdrant_recall_parity.py --collections code_index --sample 3558 --queries 100
# Produit: corpus_<name>.json (+ queries_<name>.json, origids_<name>.json)
```

`QDRANT_URL` / `QDRANT_API_KEY` lus depuis l'environnement. Aucune écriture Qdrant.

## 2. Import dans un index usearch persistant

```bash
cargo build --release -p hphe-vec
hphe-vec import --corpus corpus_<name>.json --dir migrated-vec/<name> --file <name>.usearch
# → {"imported":N,"dim":2048,"build_s":X}
```

Vérifié : `migrated-vec/` contient 23 673 vecteurs en ~191 Mo
(doc_index 20k pts construit en 11.7 s). `VecIndex::open(dir, file)` recharge
l'index (roundtrip testé par `persistence_roundtrip` dans hphe-vec).

## 3. Bascule applicative

| Étape | Action | Vérif |
|---|---|---|
| 3.1 | Pointer `VecIndex::open_or_create` du service sur `migrated-vec/<name>` | `hphe_health`/`stats` OK |
| 3.2 | Requêtes vecteurs passent par `vec_*` (hphe-mcp) au lieu du client Qdrant | knn@10 < 1 ms |
| 3.3 | Nouvelles écritures → `upsert_vector` + `save` périodique | fichier `.usearch` mis à jour |

## 4. Rollback (à conserver tant que la parité n'est pas prouvée en prod)

1. **Qdrant reste vivant** — ne pas arrêter le service, ne pas supprimer de collection.
2. Re-pointage de la config vecteur vers `QDRANT_URL` → retour immédiat au comportement legacy.
3. Les exports `corpus_*.json` (dans `.kilo/worktrees/task-337/`) permettent de
   reconstruire un index usearch à l'identique à tout moment.
4. Les index `migrated-vec/*.usearch` sont jetables : suppression = rollback neutre.

## 5. Décommission (dernière étape, après période de stabilité)

- [ ] Parité confirmée en production ≥ 1 semaine (re-run `export_qdrant_recall_parity.py` sur données fraîches)
- [ ] Aucun appel Qdrant dans les logs hphe-mcp/ingest sur la période
- [ ] Export final `corpus_*` horodaté archivé hors du repo
- [ ] Arrêt du service Qdrant, puis désinstallation — zvec: même procédure sur ses collections
- [ ] Nettoyage config : retirer `QDRANT_API_KEY`/`ZVEC_*` des env de service

## État d'avancement

- [x] Exporteur + comparateur de parité (`tools/export_qdrant_recall_parity.py`)
- [x] CLI `hphe-vec import` → index persistants (`hphe-vec/src/main.rs`)
- [x] 5 collections migrées en preuve de chemin (`migrated-vec/`)
- [ ] Bascule applicative (service vecteur pointe sur `migrated-vec/`)
- [ ] Période de stabilité + décommission effective
