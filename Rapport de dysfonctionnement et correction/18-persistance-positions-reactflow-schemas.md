# Rapport 18 — Persistance automatique des positions React Flow et changement de schémas (v0.3.22)

**Date :** 2026-10-26  
**Composant :** `extensions/hephaistos-chats` (extension Hephaistos Chats) + `.agent/agent-bridge/workspace-roster.js`  
**Version :** `0.3.22`  
**Auteur / Orchestrateur :** SWAT Orchestrateur (Cash / Devin)

---

## 1. Description du dysfonctionnement

Lors de l'utilisation de l'espace de travail React Flow de l'extension `hephaistos-chats` :
1. **Perte de position lors des changements de schéma** : les blocs déplacés sur un schéma ne conservaient pas leur position. Lors d'une bascule vers un autre schéma puis d'un retour vers le premier schéma, les blocs revenaient à des coordonnées initiales ou se retrouvaient dispersés.
2. **Disparition de blocs et de connexions** : à l'ouverture de l'espace de travail ou lors de synchronisations, des identifiants `activeSchemaId` étaient supprimés du roster, provoquant l'élagage des nœuds non visibles et la suppression de leurs liens associés.
3. **Absence d'auto-sauvegarde live type n8n** : le glisser-déposer de blocs n'écrivait que dans `.agent/workspace-roster.json` sans mettre à jour l'entrée correspondante dans `~/.hephaistos-workflow-schemas.json`.

---

## 2. Analyse des causes racines

1. **Absence de synchronisation entre `saveWorkflow` et `SCHEMAS_FILE`** :
   Quand un schéma était actif (`activeSchemaId`), `saveWorkflow` persistait `roster.workflow` sur disque dans `.agent/workspace-roster.json`, mais ne synchronisait jamais la fiche du schéma dans `~/.hephaistos-workflow-schemas.json`. Lors de `loadSchema`, l'ancien graphe stocké dans `schemas.json` écrasait donc les nouvelles coordonnées.
2. **Suppression de `activeSchema` / `activeSchemaId` dans `validateWorkflow` et `upsertCoreAgent`** :
   `validateWorkflow` filtrait uniquement `{ version, name, entrySessionId, nodes, edges }` en éliminant les métadonnées de schéma actif. À chaque ouverture d'espace de travail ou ré-ancrage d'agent IDE via `upsertCoreAgent`, le schéma actif était dépouillé de son ID.
3. **Collision de positions dans le webview React Flow** :
   À la réception d'un `workflow_state`, `position: schemaLoaded ? node.position : (prev?.position || node.position)` réutilisait `prev.position` du schéma précédent si un message asynchrone intermédiaire avait déjà réinitialisé le flag `schemaLoadPending`. De plus, `onNodesChange` déclenché par la mesure des dimensions envoyait une sauvegarde différée écrasant le schéma venant d'être chargé.
4. **Pollution de `roster.core.bleubites`** :
   Des sessions `acp/*` et des doublons `chat-*` étaient ajoutés à répétition dans `bleubites` sans déduplication, créant des conflits de masquage (`hidden: true/false`).

---

## 3. Correctifs appliqués

- **Auto-sauvegarde n8n (`syncActiveSchemaSnapshot`)** : chaque déplacement (`onNodeDragStop`), liaison ou reconfiguration met à jour simultanément `.agent/workspace-roster.json` et l'entrée active de `~/.hephaistos-workflow-schemas.json`.
- **Sauvegarde avant bascule dans `loadSchema`** : l'état du schéma quitté est figé avant de charger le nouveau schéma.
- **Autorité des positions serveur** : `position: prev?.dragging ? prev.position : node.position` garantit que tout schéma chargé applique ses positions réelles.
- **Suppression de l'écho perturbateur** : `FlowWorkspacePanel.syncCache` absorbe les changements locaux sans réémettre un `workflow_state` destructeur vers l'éditeur.
- **Déduplication robuste de `roster.core`** : assainissement des groupes `devin`, `cerberos` et `bleubites`.
- **Suite de tests de régression** : test complet de bascule `Schema-A` $\rightarrow$ déplacement $\rightarrow$ `Schema-B` $\rightarrow$ `Schema-A` vérifiant l'intégrité stricte des positions et arêtes.

---

## 4. Vérification et déploiement

- **Tests unitaires :** `npm test` dans `extensions/hephaistos-chats` $\rightarrow$ 8/8 tests passés avec succès.
- **Audit de sécurité :** aucun codepoint bidi/zero-width, aucun secret ni token détecté.
- **Packaging VSIX :** version `0.3.22` packagée via `@vscode/vsce package`.
- **Installation IDE :** déployée sur Devin Desktop (`devin-desktop.cmd`), Cursor et VS Code.
- **Git :** commit conventionnel `fix(chats): persistance automatique n8n des positions et switch de schemas (0.3.22)` et push sur `origin` (projet-temporaire) et `personal` (lascard-m).
