# ADR-003: Localisation de la source de vérité du kit

## Statut

ACCEPTED — 2026-10-14

## Décision

La source de vérité active du starter kit est **`C:\Program Files\Projet-complet\hephaistos2-kit`** (Hephaistos2-Kit, v2).

- Toute correction des scripts `.agent/` (ingest-workspace.ps1, start-workspace.ps1, auto-ingest.ps1, etc.) se fait **dans ce répertoire**, puis se propage aux projets injectés via `.agent/scripts/sync-agent-layer.ps1`.
- `F:/Promgramation-teste/Hephaistos-Kit` = **version 1, obsolète**, en cours de remplacement par la v2. Ne plus y écrire.
- `C:\Program Files\servers\hephaistos2-kit` = **runtime/install** (binaires hphe-mcp.exe, hphe-rest.exe, hphe-indexd.exe, `data/content-index`, `ingest-roots.txt`) — pas la source des scripts `.agent/`.

## Contexte

Trois emplacements portant des noms proches coexistent et se confondent facilement :

| Emplacement | Rôle |
|---|---|
| `C:\Program Files\Projet-complet\hephaistos2-kit` | Source de vérité `.agent/` (v2) |
| `C:\Program Files\servers\hephaistos2-kit` | Install runtime (binaires + index Tantivy + état) |
| `F:/Promgramation-teste/Hephaistos-Kit` | Kit v1 — DEPRECATED |

Un patch appliqué au mauvais endroit est soit ignoré (v1 morte), soit non propagé (runtime ≠ source).
