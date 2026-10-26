# DOC VAULT — Jalon J5 Packaging (run 2026-10-26)

## Livré
- **manifest.json** : 71 commandes (4 `execute_skill_*`, 66 `mcp_*`, `activity_feed`), `policy.writeToolsRequireConfirmation` + 12 outils en écriture flaggés `confirm:true`, permissions NTFS justifiées + `consentRequired`.
- **install.ps1** : `$PSScriptRoot`, copie explicite de fichiers, `$target` sanitisé `GetFullPath`, consentement NTFS `Read-Host`, `-Force`.
- **mcp-proxy.js** : enforcement `confirm` — `callTool` refuse les outils en écriture sans `__confirmed:true` (prouvé : `fs_write_file` bloqué, `everything_count` OK).
- **test-post-install.js** : vérif modules + manifeste — PASSED.
- 65 outils extraits via le proxy lui-même (`.agent/flux/mcp-tools.json`).

## Pipeline
Codeur OK 1 round, Reviewer VALIDE, Audit FAIL (copy aveugle, target non sanitisé, surface MCP large) → corrigé → Sentinelle GO.

## Suite — J6 (dernier)
Durcissement final + documentation : modèle de sécurité documenté, guide mapping skills↔commandes, journal de décisions à jour, validation que droits NTFS = besoins réels.
