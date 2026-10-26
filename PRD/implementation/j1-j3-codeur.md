# Résumé J1-J3 — Implémentation Codeur (Plugin Devin Hephaistos)

## Fichiers créés

1. **plugin-devin/plugin.json** — manifeste id hephaistos-devin, commands, mcp proxy déclaré, permission NTFS elevation.
2. **plugin-devin/skills-to-plugin-commands.json** — mapping skill -> commande execute_skill_<norme>, entrées/sorties JSON normalisées.
3. **plugin-devin/src/index.js** — squelette: enregistrement commandes execute_skill_*, spawn hphe-mcp.exe une fois + réutilisation, proxy mcp_<outil> JSON-RPC stdio (via mcp-proxy.js).
4. **plugin-devin/src/mcp-proxy.js** — connexion JSON-RPC stdio : initialize, tools/list, tools/call ; lifecycle : lance une fois, réutilise, kill propre. Utilise `proc.stdin.write` + `proc.stdout.on('data')` avec map id->resolver.
5. **plugin-devin/src/skills.js** — loader mapping + dispatch execute_skill_<nom> ; accepte 'jointes' OU 'execute_skill_jointes'.
6. **plugin-devin/README.md** — usage, install, prérequis élévation NTFS.
7. **PRD/implementation/j1-j3-codeur.md** — ce fichier.

## Choix d'implémentation

- CommonJS, cohérent avec .agent/agent-bridge.
- Pas de secrets ; élévation NTFS déclarée dans plugin.json.
- Proxy MCP singleton : un seul processus hphe-mcp.exe lancé au démarrage, réutilisé pour tous les calls JSON-RPC (stdio, ligne par ligne).
- Mapping skill -> commande respecté telle quelle dans skills-to-plugin-commands.json ; la clé 'execute_skill_jointes' est acceptée directement.
- node --check passé sur chaque fichier .js avant terminaison (vérification syntaxe OK).

## Corrections appliquées (review feedback + fix3)

1. **mcp-proxy.js** :
   - Ajout de `clearTimeout` dans `resolve/reject` avec un seul endroit `pendingCalls.delete`.
   - `initialize()` retourne maintenant une Promise qui attend la réponse JSON-RPC `initialize`.
   - Buffer stdio robuste : accumulation de chunks, split sur `\n`, reste incomplet conservé pour le prochain chunk.
   - Gestion du champ `error` JSON-RPC dans les réponses (rejette avec l'erreur fournie).
2. **skills.js** :
   - Lecture dynamique de `skills-to-plugin-commands.json` (vérifiée et operative).
   - Message d'erreur clair en cas de skill inconnue, avec liste des skills disponibles.
3. **plugin.json** :
   - Vérification que les 4 commandes `execute_skill_*` (jointes, binome, flux, bleubite-dispatch) sont déclarées.
   - Ajout des mcp_* déclarées au manifeste.
4. **index.js** :
   - Import correct `{ initialize, callTool }` (plus de référence à `initializeMcp` inexistant).
   - Mapping acceptant `jointes` OU `execute_skill_jointes`.
5. **fix3 — mcp-proxy.js** :
   - **a.** Ajout de la fonction `stopMcp()` exportée qui tue le processus, réinitialise `mcpProc` et vide `pendingCalls`.
   - **b.** `initialize()` attend maintenant la réponse JSON-RPC `initialize` via le mécanisme `pendingCalls` au lieu d'un drapeau `mcpInitialized` inutilisé. Lorsque la réponse `initialize` arrive, la Promise est résolue.
   - **c.** `handleJsonRpcMessage` appelle `cleanupPending(id)` (qui clearTimeout + delete) au lieu de `pendingCalls.delete(id)` partout, évitant ainsi des timers orphelins.
   - **d.** Suppression de la boucle `setTimeout(checkInit)` ; `initialize` devient un callTool-like : envoie `initialize`, enregistre dans `pendingCalls`, et retourne la Promise. La résolution survient quand la réponse JSON-RPC `initialize` arrive.
   - **e.** Test mental : `require()` fonctionne, `callTool` résout sur réponse id matchee, `initialize` résout quand la réponse `initialize` arrive.

## Corrections appliques (fix5)

1. **Élevation NTFS justifiée** :
   - `plugin.json` : remplacé `ntfsElevation:true` par un objet `{ "ntfsElevation": { "required": true, "scope": ["read"], "paths": ["<workspace>"], "justification": "Requis pour everything_search (index NTFS $MFT en lecture seule via hphe-mcp.exe); le plugin n'ecrit jamais directement en NTFS eleve" }, "consentRequired": true }`.
   - `README.md` : section Permissions expliquant que l'elevation ne sert qu'a la lecture d'index NTFS via le MCP, consentement demande a l'install.

2. **VALIDATION ARGS dans callTool (mcp-proxy.js)** :
   - Ajout de `validateArgs(toolName, args)` : whitelist des outils connus (charge depuis tools/list au initialize ou objet TOOL_SCHEMAS minimal), verifie types (string/number/boolean/object), rejette les args non conformes avec Error claire.
   - `callTool` appelle `validateArgs` avant `stdin.write`.

## Points ouverts

- Tests d'intégration réels avec hphe-mcp.exe sur le poste.
- Persistance du choix thème icône (voir theme-switcher-spec.md).
- Interface Devin réelle d'enregistrement des commandes (à adapter selon l'API Devin dispo).

LIVRABLE-CODEUR-FIX5-OK