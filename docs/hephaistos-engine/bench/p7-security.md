# P7 — Revue sécurité T-031 : pipe ACL, snapshot mmap, policy MCP

**Date** : 2025-12-10 — périmètre : `hphe-ipc` (named pipe + ACL), `hphe-index/snapshot` (mmap),
`hphe-mcp/policy` (.mcp-access + roots), `hphe-daemon/handler` (bornes requêtes).

## Findings corrigés

### F1 — Traversal bypass dans `AccessPolicy::check_allowed` (HIGH, corrigé)

Quand `fs::canonicalize` échoue (fichier inexistant — cas normal en écriture), le
fallback rejoignait le chemin brut au cwd **sans normalisation lexicale**.
`C:\allowed\..\evil.txt` passait alors le préfixe `starts_with` des allowed roots
→ écriture possible hors racine via `fs_write`/`fs_move`/`fs_copy`/`fs_delete`.

**Fix** : `normalize_lexical` dépile `.`/`..` par composants avant tout check
(`policy.rs`). Test de régression `test_traversal_denied_on_missing_file` ajouté.

### F2 — `SearchParams.limit` sans borne haute (MEDIUM, corrigé)

`handler.rs` bornait seulement par le bas (`max(1)`). Un client pipe pouvait
demander `limit = usize::MAX` → réponse NDJSON contenant potentiellement des
millions d'entrées → DoS mémoire/CPU côté démon.

**Fix** : `clamp(1, MAX_SEARCH_RESULTS=10_000)` (`handler.rs`).

## Points validés

| Composant | Contrôle | Verdict |
|---|---|---|
| Pipe listener | SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)(A;;GA;;;CO)` — SYSTEM+admins+owner, DACL protégée, appliquée par défaut | OK |
| Frame NDJSON | `MAX_MESSAGE_SIZE` 16 MiB, connexion coupée si pas de `\n` dans la fenêtre | OK |
| Concurrence | `MAX_CONNECTIONS` 128, timeouts read/write | OK |
| Snapshot mmap | magic `HPHE` + version + CRC32 header + CRC32 par section + bounds `offset+len≤mmap` + alignement + fallback rebuild sur corruption | OK |
| `unsafe` `from_mmap` | préconditions vérifiées en amont (bounds + align + mmap Arc gardé vivant) | OK |
| fs_* tools | tous passent par `check_allowed` (read vs write distingués) | OK |
| Secrets | aucune clé/credential dans le code audité | OK |

## Risques résiduels (acceptés, documentés)

- **Buffer 16 MiB par connexion** : `vec![0; max_message_size]` pré-alloué → 128 connexions
  × 16 MiB = 2 GiB. Exploitabilité faible (pipe local, ACL admin-only). Amélioration future :
  buffer dynamique.
- **TOCTOU** : entre `check_allowed` et l'ouverture du fichier, un junction/symlink swap
  reste théoriquement possible. Nécessite droits d'écriture locaux dans la racine autorisée —
  risque accepté (même modèle que le serveur Python legacy).
- **Fail-open `.mcp-access`** : si le fichier est absent, `is_path_allowed` retourne vrai
  (pas de règles = pas de restriction). Cohérent avec le legacy Python ; les `EVERYTHING_MCP_ROOTS`
  restent la barrière principale.
- **Sémantique last-match-wins** des règles `.mcp-access` (comme .gitignore) : un `allow`
  après un `deny` l'emporte. Documenter dans le runbook T-110.
