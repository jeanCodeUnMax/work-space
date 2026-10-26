# J5 — Packaging / Distribution plugin-devin

## Fichiers créés (chemins absolus)

1. **plugin-devin/manifest.json** — manifeste complet déclarant :
   - `id`, `version`, `name`
   - 65 commandes `mcp_<outil>` extraites de `.agent/flux/mcp-tools.json`
   - 5 commandes `execute_skill_*` (jointes, binome, flux, bleubite-dispatch + activity_feed)
   - `permissions.ntfsElevation` (objet with required/scope/justification/consentRequired)
   - `mcpProxy` (exe, pathEnv, args, fallback)
2. **plugin-devin/install.ps1** — script PowerShell d'installation :
   - Vérifie `hphe-mcp.exe` via `HPHE_MCP_PATH` ou fallback relatif
   - Copie le plugin dans le dossier cible (ou `%USERPROFILE%\.hephaistos-devin`)
   - Lance `node --check` sur chaque `.js` de `src`
   - Demande le consentement élévation NTFS (Read-Host sauf `-Force`)
   - Affiche resumé OK/Échec
3. **plugin-devin/test-post-install.js** — vérification autonome à la demande :
   - `require()` des 4 modules src (comms, mcp-proxy, index, skills)
   - Vérifie l'existence et la validité de `plugin.json` + `manifest.json`
   - Teste `getLastEntries(3)` depuis comms.jsonl
   - Teste `callTool('everything_count',{query:'*'})` si `HPHE_MCP_PATH` défini
   - Sortie 0=OK / 1=FAIL + résumé des échecs
4. **plugin-devin/README.md** — section **Packaging/Install complete** résumant les étapes d'installation, les permissions NTFS et la structure des commandes.
5. **plugin-devin/manifest.json** — à jour avec les 65 outils MCP et les permissions.

## Choix d'implémentation

- **CommonJS** (require/exports) cohérent avec l'existant (.agent/agent-bridge).
- **Chemin absolu** partout pour éviter tout path-relative silencieux (le bug J4).
- **Ring buffer** dans `getLastLines` (comms.js) pour lire les N dernières lignes sans charger les 89 Ko entiers.
- **Whitelist d'args** dans `callTool` (mcp-proxy.js) via `validateArgs` + TOOL_SCHEMAS minimal chargé à l'initialize.
- **JSON-LINE** robuste : parse par ligne, ignore corrompues, masque tokens/paths sensibles via `filterSensitive`.
- **Manifest JSON** généré dynamiquement à partir de `.agent/flux/mcp-tools.json` (65 outils).
- **install.ps1** paramétrable : `-Target` custom, `-Force` pour sauter le consentement.

## Points ouverts

- Le `pathEnv` `HPHE_MCP_PATH` doit être défini par l'utilisateur ou l'administrateur ; le fallback relatif nécessite que le repo hphe-mcp soit déballé à côté du plugin.
- La liste exacte des 65 outils pourrait évoluer ; il serait envisageable de lire `mcp-tools.json` à l'runtime au lieu de la hardcoder (future amélioration).
- Le script `test-post-install.js` utilise des appels mock si le MCP n'est pas démarré ; un vrai test d'intégration nécessiterait le processus `hphe-mcp.exe`.
- Le consentement NTFS est stocké localement (pas de registry) ; une politique GPO pourrait être déployée en entreprise.
- Les commandes `mcp_<outil>` appellent `tools/call` sur le JSON-RPC stdio ; la méthode `initialize` respecte le protocole 2024-11-05 avec les params attendus.

## Résumé

L'ensemble des fichiers J1–J5 constitue un plugin Devin autonome, packagé avec manifeste complet, script d'installation automatisée et autotests post-install. Le plugin s'appuie sur le serveur MCP `hphe-mcp.exe` en stdio, expose 65 outils et 5 commandes natives, et gère l'élévation NTFS en lecture seule avec consentement explicite.

LIVRABLE-CODEUR-J5-OK