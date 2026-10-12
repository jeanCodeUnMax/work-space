# P9 — Audit sécurité final T-120 (consolide T-031)

**Date** : 2025-12-10 — périmètre : workspace `hphe/` complet + couche MCP + extension.

## Verdict : PASS avec risques résiduels documentés

## 1. Findings corrigés (hérités T-031, commit `a5e7c62`)

| # | Sévérité | Finding | Fix |
|---|---|---|---|
| F1 | HIGH | Traversal bypass `check_allowed` quand `canonicalize` échoue (écriture nouveau fichier) — `allowed_root/../evil` passait le préfixe roots | Normalisation lexicale `normalize_lexical` + test régression |
| F2 | MEDIUM | `SearchParams.limit` sans borne haute → vidage index en une frame NDJSON | `clamp(1, 10_000)` dans handler démon |

## 2. Balayage T-120 complémentaire (aucun finding nouveau)

| Surface | Contrôle | Résultat |
|---|---|---|
| Secrets hardcodés | grep api_key/password/secret/token sur tout `hphe/crates/**/src` | Aucun — seulement APIs Win32 (`OpenProcessToken`) et strings de test |
| Exécution dynamique | `Command::new`/spawn/exec dans le code Rust | **Zéro** — aucune surface d'injection |
| `unsafe` | 9 fichiers : snapshot mmap (borne+align+CRC), `sys.rs` FFI, MFT/USN readers, elevation | Justifiés, préconditions vérifiées |
| `unwrap`/`expect` hors tests | Concentré dans `tests.rs` et `main.rs` CLI ; les handlers démon/MCP retournent `Result` | Panic = seulement en chemins CLI/test |
| NDJSON pipe | 16 MiB/frame max, 128 connexions max, timeouts read/write | Borné |
| ACL pipe | SDDL `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)(A;;GA;;;CO)` par défaut | Restreinte |
| Snapshot | magic+version+CRC32 header/sections, fallback rebuild | Intègre |
| Outils `fs_*` | Tous passent `check_allowed` (read/write distincts) | OK post-F1 |
| VSIX embarqué | `hphe-mcp.exe` = binaire release officiel, `.mcp-access` fourni | OK |

## 3. Risques résiduels acceptés

- **Buffer 16 MiB/connexion** pré-alloué (2 GiB @128 conn.) — pipe local ACLé, amélioration future buffer dynamique.
- **TOCTOU** entre `check_allowed` et open — même modèle que legacy, nécessite droits locaux.
- **Fail-open `.mcp-access`** absent — `EVERYTHING_MCP_ROOTS` reste la barrière (parité legacy).
- **Last-match-wins** dans les règles `.mcp-access` (sémantique .gitignore) — documenté au RUNBOOK.
- **Warnings** : 52 warnings cosmétiques `hphe-usn` (dead code, imports) — à nettoyer en maintenance.

## 4. Couverture tests au moment de l'audit

~190 tests workspace verts : mft 10, index 18+15 snapshot, query 34, usn, ipc,
content 20, vec 8, mcp 21 (unit+e2e+roundtrip+v2), parity 18 pytest, beacon 9 pytest.

## 5. Actions post-audit recommandées

- [ ] `cargo fix -p hphe-usn` + revue warnings (cosmétique)
- [ ] Buffer pipe dynamique (backlog perf)
- [ ] `cargo audit` périodique dans CI (vuln deps)
- [ ] Rotation/clé : aucun secret côté moteur — `QDRANT_API_KEY` à retirer des env de service à la décommission (cf. `p8-migration.md`)
