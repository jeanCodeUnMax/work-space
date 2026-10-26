# J5 — AUDIT SECURITE packaging plugin-devin/

## Étendu de l'audit
Fichiers examinés : `manifest.json`, `install.ps1`, `test-post-install.js`.

## Findings de sécurité

1. **Manifest — surface MCP trop large** — 67+ commandes `mcp_*` exposées, dont `mcp_fs_*` (read/write/delete files, directory tree, search, edit, move, create directory, delete file, read multiple, etc.). Les permissions sont limitées à `ntfsElevation` + scope `["read"]`, mais le nombre considérable de commandes donne une surface d'attaque étendue. **Trouble** : plusieurs commandes n'ont pas de limite de chemin explicite dans le manifeste ; la restriction s'applique peut-être uniquement au niveau de l'exécutable hphe-mcp.exe.

2. **install.ps1 — Copy-Item aveugle** — La ligne `Copy-Item -Path (Join-Path $pluginDir "*") -Destination $target -Recurse -Force` copie **tous** les fichiers du répertoire `src/` (yventuels fichiers de configuration, logs, .gitignore, etc.) vers le répertoire cible de l'utilisateur (`%USERPROFILE%\.hephaistos-devin`). Pas de filtrage, pas de vérification de l'intégrité des fichiers ciblés. **Trouble** : aucun contrôle d'autorisation ni de prompt secondaire sur les fichiers copiés.

3. **install.ps1 — Pas de sanitisation du target** — Le paramètre `$Target` est accepté tel quel ; si un chemin relatif ou contenant `../` est fourni, il peut aboutir hors de l'intention initiale. Par défaut, la cible est `%USERPROFILE%\.hephaistos-devin` (sous le profil utilisateur, hors workspace), ce qui est acceptable mais non documenté comme "sandboxed".

4. **ntfsElevation — justifiée mais limitée** — La permission `ntfsElevation` avec justification "Lecture seule index NTFS $MFT via hphe-mcp.exe; aucune écriture directe" est techniquement correcte (l'outil hphe-mcp.exe gère l'indexation), mais elle ne compense pas le fait que `install.ps1` copie l'intégralité du plugin sans restriction.

5. **test-post-install.js — Aucun risque détecté** — Le script ne fait que des `require()` de modules ; pas d'exécution dangereuse, pas d'écriture, pas d'appel système.

## Verdict final

**AUDIT: FAIL** — Surface MCP excessivement large + `install.ps1` copie aveugle sans filtrage ni confirmation sur les fichiers copiés. Le lecteur test est inoffensif, mais les deux premiers points justifient un échec.

LIVRABLE-AUDIT-J5-OK