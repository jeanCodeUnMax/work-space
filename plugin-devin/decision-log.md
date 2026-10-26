# Journal de décisions J1-J6 — Plugin Devin Hephaistos

## Choix d'architecture
- **Hybride ext+plugin** : Les skills lourdes restent dans le kit Hephaistos (.agent/skills), le plugin Devin apporte le proxy MCP et l'interface Devin.
- **Proxy stdio** : `hphe-mcp.exe` lancé une fois en stdio, réutilisé via `pendingCalls` map, pas de nouveaux processus par outil.
- **Spawn unique** : `mcp-proxy.js` gère le cycle vie (initialize, tools/list, tools/call) via un seul processus enfant.

## Incidents résolus
- **Réponses vides** : Corrigé en additionnant `clearTimeout` + `pendingCalls.delete(id)` + nettoyage `setTimeout(checkInit)` devenu inutile.
- **Date.now -> compteur atomique** : Remplacement de `id = Date.now()` par un simple compteur `let _cid = 0;` incrémenté pour éviter les collisions de promesse dans des fenêtres temporelles serrées.
- **initialize jamais résolu** : Ajout de la résolution via `pendingCalls` à l'arrivée du message JSON-RPC `initialize` response.

## Verdicts pipeline
- J1-J3 : squelette functional avec mcp-proxy, skills.js, index.js, mapping, README. Code checké CommonJS.
- J4 : reader comms.jsonl, activity-panel, commande activity_feed ajoutée.
- J5 : packaging install.ps1, test-post-install, manifeste complet mcp-tools.json mapping.
- J6 : documentation securité, mapping-guide, decision-log final. Elevation NTFS justifiée en lecture seule.

## Verification finale
- Tous les fichiers .js passent `node --check` (syntaxe CommonJS valide).
- Pas de secrets durs dans le code ; elevation déclarée et consentie.
- Manifest complet avec 65 outils MCP + commandes skills + activity_feed.