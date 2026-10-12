# Benchmarks

Machine de dev (Windows, ~6,4 M entrées indexées sur 4 volumes NTFS
`C:` `D:` `E:` `F:`, `hphe-indexd` SYSTEM actif). Chiffres = ordres de
grandeur, pas précision au µs.

## Protocole reproductible

### 1. Santé index + démon

```powershell
curl http://127.0.0.1:8792/health
# {"status":"healthy","pipe_connected":true,"ingest_busy":false,...}
```

### 2. Latence de recherche (bout en bout, pipe + MCP)

Via l'outil `everything_search` sur `hphe-mcp` ou REST :

```powershell
curl -X POST http://127.0.0.1:8792/tools/everything_search -H "Content-Type: application/json" -d '{"query":"dots folder:","max_results":100}'
```

Protocole recommandé : 10 runs par requête, **médiane**, alterner chaud/froid,
noter `total` à côté du temps — la latence est bornée par la **charge utile**
(taille de la réponse), pas par l'index.

### 3. Traversal de référence

`fs_search_files` (traversal récursif in-server) sur un sous-arbre borné —
jamais un volume entier sans timeout.

## Comparatif

| | Hephaistos2 (Rust, `hphe-indexd`) | v1 (Python + Everything.exe) | `filesystem` MCP officiel |
|---|---|---|---|
| Backend | index SoA propre, snapshot mmap + USN live | index Everything.exe via WM_COPYDATA | traversal `os.scandir` |
| Entrées | ~6,4 M | ~15,8 M (machine de l'époque) | n/a |
| Lookup | **ms** (mémoire) | ms (index) + transport lourd | ~2 000 entrées/s |
| `dots` tout le PC | secondes (résultat-bound) | 1 328 hits / ~4,7 s | n'a jamais fini `C:/` (15+ min tué) |

Le gain structurel v2 vs v1 : la recherche elle-même reste à coût mémoire,
mais le transport `WM_COPYDATA` (sérialisation + fenêtres Windows) est
remplacé par un named pipe NDJSON — la charge utile s'écoule en flux.

## Ingestion de contenu (Tantivy)

Repères observés pendant la migration (logs `hphe-rest`) :

- ~14 000 documents + entités KG en un run d'ingestion workspace
- commits incrémentaux par batch (ex. ~96 000 docs sur cycle complet `F:\`)
- écriture sérialisée par le gate interne : les appels manuels attendent leur
  tour (`ingest_busy` dans `/health`) au lieu d'échouer en `LockBusy`

## Notes

- Le tri est fait dans le démon : les requêtes `sort:` ne changent pas le
  coût d'accès, seulement la forme de la réponse.
- `watch` (flux USN) ajoute ~0 coût au repos ; le surcoût n'apparaît qu'en
  présence d'événements.
