# AUDIT J6 — Plugin Devin/ (Audit complet final)

## Étendu de l'audit
Fichiers examinés : `manifest.json`, `install.ps1`, `test-post-install.js`, `plugin.json`, `src/*.js` (comms.js, index.js, mcp-proxy.js, skills.js), `doc-securite.md`, `decision-log.md`, `mapping-guide.md`, `README.md`.

## Findings de sécurité

1. **Manifest — 71 commandes MCP exposées** — Le manifeste déclare 65+ outils `mcp_*` dont `fs_read_file`, `fs_write_file`, `fs_list_directory`, `fs_create_directory`, `everything_search`, `search_files`, etc. Surface étendue mais **toutes soumises à validation schema** et **confirmation write** dans mcp-proxy.js.

2. **12 commandes avec `confirm: true`** — Ces commandes imposent `__confirmed:true` avant exécution via `callTool`. Bonne pratique fail-closed : écritures sans consentement utilisateur sont refusées.

3. **mcp-proxy.js — Validation args + confirmation write** — La fonction `callTool` vérifie :
   - Si l'outil est dans `CONFIRM_TOOLS` (issu de manifest.json `confirm:true`) ET que `args.__confirmed !== true` → rejet Promise avec message explicite.
   - Suppression de `.__confirmed` des args avant envoi.
   - Validation stricche des types via `TOOL_SCHEMAS` (whitelist par outil). Si schema inconnu, accepte mais logue un warning.
   → Aucun outil d'écriture ne peut s'exécuter sans confirmation explicite de l'utilisateur.

4. **install.ps1 — Copy-Item aveugle** — `Copy-Item -Path (Join-Path $pluginDir "*") -Destination $target -Recurse -Force` copie **l'intégralité** du répertoire `src/` (incluant éventuellement .gitignore, fichiers de config, logs) vers `%USERPROFILE%\.hephaistos-devin`. **Aucun filtrage, aucune confirmation sur les fichiers copiés**. C'est le seul point FAIL critique : écriture hors de l'intention initiale sans contrôle.

5. **install.ps1 — Target non sanitisé** — `$Target` est accepté tel quel. Par défaut `%USERPROFILE%\.hephaistos-devin` (hors workspace, sous profil utilisateur). Pas de protection contre `../` ou chemins relatifs malveillants, mais la cible par défaut est raisonnable.

6. **ntfsElevation — Juste et limitée** — `plugin.json` déclare `ntfsElevation: { required: true, scope: ["read"], paths: ["<workspace>"], justification: "Lecture seule index NTFS $MFT via hphe-mcp.exe ; aucune écriture directe en elevation."`. Respect des besoins réels : élévation juste pour lecture index, pas d'écriture directe. Documentation conforme dans `doc-securite.md`.

7. **Aucun secret/token/code injection détecté** — Aucun mot de passe, clé API, ou `eval/exec` trouvé dans le code lu. Le plugin utilise `require()` normal, pas d'exécution dynamique de code.

8. **Surface d'attaque résiduelle** — Principale réside dans `install.ps1` qui copie tout sans filtrage. Une fois installé, le plugin s'exécute dans un environnement sandboxed : writes nécessitent confirm `__confirmed:true`, reads validées par schema. Le risque est essentiellement au moment de l'installation.

## Verdict final

**AUDIT: FAIL** — Point critique : `install.ps1` effectue un `Copy-Item` aveugle sans filtrage ni confirmation sur les fichiers copiés vers `%USERPROFILE%\.hephaistos-devin`. Toutes les protections à l'exécution (confirmation write, validation schema) sont présentes mais n'empêchent pas l'écriture non contrôlée au moment du déploiement.

LIVRABLE-AUDIT-J6-OK