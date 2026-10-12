# RUNBOOK — Moteur Hephaistos (T-110)

Exploitation de `hphe-indexd` + `hphe-mcp` : installation, exploitation,
dépannage, rollback vers Everything.exe / Qdrant.

## Architecture (état livré)

```
NTFS $MFT + USN journal
        │  (admin requis pour lecture directe volume)
        ▼
hphe-indexd (démon/service Windows, crate hphe-daemon)
  ├─ hphe-mft    : parseur records MFT
  ├─ hphe-index  : index SoA + snapshot mmap (HPHE, CRC32)
  ├─ hphe-usn    : deltas USN + wrap recovery
  ├─ hphe-content: index BM25 tantivy (contenu)
  ├─ hphe-vec    : store vectoriel usearch (HNSW, save/open)
  └─ hphe-ipc    : named pipe \\.\pipe\hphe-indexd, NDJSON, ACL SDDL restreinte
        ▲
        │ pipe nommé (verbs: ping stats search resolve watch)
hphe-mcp.exe (serveur MCP stdio unifié — 18 outils legacy + vec_*/content/health)
        ▲
        │ stdio JSON-RPC
Extension VS Code (extension/) + clients pipe (pipe_client.py)
```

## Installation

```powershell
# 1. Build release complet
cd hphe; cargo build --release --workspace
# → hphe-indexd.exe, hphe-mcp.exe, hphe-vec.exe, hphe-index.exe

# 2. Service Windows (admin)
hphe-indexd install        # installe le service
hphe-indexd start          # démarre (scan MFT initial ~min, snapshot ensuite)
sc query hphe-indexd       # vérifier

# 3. Point d'entrée MCP : hphe-mcp.exe en stdio (config MCP client)
```

Sans élévation : le démon retombe sur index synthétique/fallback — vérifier
`hphe-indexd status` / verbe `stats` du pipe.

## Exploitation courante

| Besoin | Commande / verbe |
|---|---|
| Recherche nom fichier | `everything_search` (MCP) ou `search` (pipe) |
| Compter | `everything_count` |
| Santé démon | `hphe_health`, `stats` |
| Watch USN | `watch` (pipe) — beacon_ingest --watch l'utilise |
| Re-index contenu | `everything_refresh` |
| Recherche contenu BM25 | `content_search` |
| Recherche vectorielle | `vec_*` (hphe-mcp) sur `migrated-vec/` |

## Snapshots

- Format `HPHE` v1 — header+sections CRC32, chargement mmap ~95 ms @1M.
- Corruption détectée → fallback rebuild automatique (log warn).
- Emplacement : répertoire data du service (cf. config démon).

## Dépannage

| Symptôme | Diagnostic | Action |
|---|---|---|
| `everything_search` renvoie erreur pipe | hphe-indexd arrêté | `hphe-indexd start`; sinon fallback Everything.exe (pipe_client.py) |
| Résultats vides après boot | scan MFT initial en cours | attendre `stats.total > 0` |
| Pipe refusée | ACL (SDDL owner/admin/SYSTEM) | lancer le client sous un compte autorisé |
| Index contenu périmé | watch USN non reçu | `everything_refresh`, vérifier service |
| Perf dégradée recherche | ef_search bas | `set_expansion_search` (hphe-vec) |

## Rollback

- **Everything.exe** : `pipe_client.py` fallback automatique si pipe absente —
  relancer Everything.exe suffit (aucune conf à changer côté MCP Python).
- **Qdrant/Zvec** : voir `bench/p8-migration.md` §4 — re-pointer la config vecteur,
  collections Qdrant intactes jusqu'à décommission explicite.
- **Index corrompu** : supprimer le snapshot → rebuild complet au prochain démarrage.

## Politique d'accès MCP

- `EVERYTHING_MCP_ROOTS` = liste `;`-séparée des racines autorisées (barrière principale).
- `.mcp-access` = règles glob→regex par profil (`[profile:nom]` ; actions
  `allow|read|write|deny-write|deny`; **dernière règle qui matche gagne**).
- Fichier absent = pas de restriction au-delà des roots (fail-open, parité legacy).
- Chemins normalisés lexicalement même si le fichier n'existe pas encore
  (anti-traversal, cf. `p7-security.md` F1).

## Benchmarks de référence (rapports dans docs/hephaistos-engine/bench/)

| Composant | Mesure | Rapport |
|---|---|---|
| Index SoA | 1,85 Gio @16M entrées, 1,19 Md lignes/s memchr | p1-index.md |
| Query engine | substring ~146 ms @1M, ext ~29 ms | p1-query.md |
| Snapshot | load ~95 ms @1M | p1-snapshot.md |
| Pipe | NDJSON roundtrip | p1-pipe.md |
| Contenu | 71 647 docs/s ingest, 234 µs/query BM25 | p3-tantivy.md |
| Vecteurs | recall@10 0.995 synth / 1.0000 toléré réel | p4-vec.md, p4-real.md |
| MCP e2e | roundtrips stdio 18 outils | p5-e2e.md |
| Sécurité | audit pipe/ACL/snapshot/policy | p7-security.md |
| Migration | export→import→bascule→rollback | p8-migration.md |
