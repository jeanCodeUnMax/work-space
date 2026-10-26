# DOC VAULT — Jalon J1-J3 Plugin Devin (run 2026-10-26)

## Livré
- **plugin-devin/** : squelette plugin fonctionnel — `plugin.json` (manifeste, élévation NTFS justifiée lecture $MFT, `consentRequired`), `skills-to-plugin-commands.json` (jointes, binome, flux, bleubite-dispatch → `execute_skill_<nom>`), `src/mcp-proxy.js` (proxy JSON-RPC stdio vers hphe-mcp.exe : spawn unique réutilisé, buffer ligne, compteur d'id atomique, timeout cleanup unifié, validation TOOL_SCHEMAS), `src/skills.js`, `src/index.js`, README.
- **Test réel prouvé** : `initialize` + `everything_search` via le proxy → résultats NTFS du pipe hphe-index. Rejet d'args invalides prouvé.
- **Extension 0.3.10** : double-clic bloc `acp/devin-cli/*` → onglet cascade.

## Pipeline SWAT
Codeur `chat-mvmw59wa` (5 rounds : squelette → fixes race/init/proto → conditions), Reviewer `chat-mvmw5chd` (CORRECTIONS, 9 pts), Audit NIM2 (FAIL → 2 conditions), Sentinelle `chat-mvfqytbz` (GO-avec-conditions → remplies). Commit `ff02828` poussé origin+personal.

## Suite — J4
Synchronisation état extension ↔ plugin : lecture `comms.jsonl` dans l'UI plugin, filtrage permissions, 20 dernières entrées, extension écrit dans le journal partagé.

## Points ouverts
- Chemin hphe-mcp.exe via `HPHE_MCP_PATH` (fallback release workspace).
- `initialize` : outils dynamiques via `setToolSchemas` après `tools/list`.
- Interface d'enregistrement des commandes côté Devin à brancher sur l'API réelle.
