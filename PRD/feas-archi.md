# Feasibility Analysis: hephaistos2-kit → Devin IDE Plugin

## Constats

- **Kit actuel (hephaistos2-kit)** : Comporte `hphe-mcp.exe`, un serveur MCP unifié exposant 58 outils Rust (recherche NTFS, recherche sémantique, gestion de flux, dispatch bleubite). Il fonctionne en processus autonome et attend des connexions MCP (JSON-RPC sur stdin/stdout ou socket nommé).
- **Écosystème existant** :
  - `.agent/agent-bridge` : `workspace-roster.js` (routing des workspaces), `acp-inject.js` (injecteur de règles d'exécution), `devin-hub.js` (pont de communication vers l'interface Devin), `comms.jsonl` (journal d'événements structurés).
  - `.agent/skills` : Modules `jointes`, `binome`, `flux`, `bleubite-dispatch` encapsulant la logique métier, la planification de tâches et le dispatch d'événements.
  - Extension VS Code `hephaistos-chats` : Interface Canvas React Flow + zones de chat, s'exécute côté navigateur/extension, communique avec `hphe-mcp.exe` via un pipe local.
- **Référence d'installation** : Le plugin `cli-anything-plugin` (Devin) s'installe via un répertoire dédié (`F:\Promgramation-teste\CLI-Anything\`) et s'attend à un fichier `manifest.json` + binaires/outils associés. Il ne remplace pas les extensions VS Code existantes, il les **complète**.
- **Conclusion précédente** : *« Le plugin Devin complete les extensions, il ne les remplace pas »*. Toute architecture doit donc viser une coexistence, pas un remplacement.

## Blocs exposables (plugin-side)

Ces composants peuvent être packagés dans le plugin Devin ou exposés via ses points d'extension sans briser le modèle de sécurité/localité :

| Bloc | Mode d'exposition | Détails |
|------|-------------------|---------|
| **Skills** (`jointes`, `binome`, `flux`, `bleubite-dispatch`) | Mapping vers des actions Devin | Chaque skill peut être traduit en une commande Devin `execute_skill_<nom>` ou en un outil MCP proxy. Les entrées/sorties sont sérialisées en JSON compatibles avec le flux Devin. |
| **Règles d'exécution** (`acp-inject.js` logique) | Configuration déclarative | Les règles d'injection d'ACP (Automatic Command Protocol) peuvent être traduites en `rules/` du plugin Devin (YAML/JSON), appliquées avant/après exécution d'outils. |
| **Configuration MCP** (`hphe-mcp.exe` params) | Proxy léger | Le plugin peut lancer `hphe-mcp.exe` en tant que processus enfant ou le connecter via ses propres points de communication stdin/stdout. Les 58 outils restent accessibles via des commandes `mcp_<outil>`. |
| **Slash commands** existants | Redirection vers le plugin | Les commandes slash de l'extension `hephaistos-chats` (ex: `/hphe-search`, `/hphe-flux`) peuvent être réenregistrées dans le manifeste du plugin Devin, redirigeant vers le même binaire ou vers l'API locale. |
| **Journal comms.jsonl** | Vue d'activité | Le plugin peut exposer un volet de journal en temps réel dérivé du flux `comms.jsonl`, filtré selon les permissions de l'utilisateur. |

## Blocs runtime (local)

Ces composants **doivent rester** sur la machine locale / dans le processus hôte pour des raisons de sécurité, de performance ou d'architecture :

| Bloc | Raison de staying local |
|------|--------------------------|
| **`hphe-mcp.exe`** | Processus lourd, 58 outils Rust, gestion de mémoire NTFS/sémantique. Il s'exécute en arrière-plan et communique via des canaux IPC dédiés. Le plugin ne peut qu'en être le client. |
| **Orchestrateur Hephaistos** | Moteur de décision, planification multi-agents, état global. Il maintient la cohérence entre les skills et les requêtes externes. Exposé en API locale uniquement. |
| **Bridge `.agent/agent-bridge`** | `workspace-roster.js`, `acp-inject.js`, `devin-hub.js`, `comms.jsonl` : Ils gèrent le cycle de vie du workspace, l'injection de contexte et le journalisation. Ils s'attendent à un environnement Node.js/VS Code et ne sont pas conçus pour s'exécuter dans le sandbox Devin. |
| **Extension VS Code `hephaistos-chats`** | Interface React Flow, état UI local, dépendances VS Code API. Elle reste installée à côté du plugin, le plugin venant en complément (ex: bouton "Open Hephaistos Panel" dans l'extension). |
| **Permissions NTFS et sécurité** | Le moteur de recherche NTFS et les outils Rust nécessitent des droits d'accès système. Ils sont verrouillés au processus `hphe-mcp.exe` ; le plugin n'aurait pas ces droits sans élévation explicite. |

## Architecture Cible

```
+------------------------+          +--------------------------+
|   Deven IDE (client)   |          |   Hephaistos2 Kit (hôte) |
|  + Plugin `cli-anything`|          |  + hphe-mcp.exe (MCP server) |
|  + Onglets, chat, UI   |          |  + 58 outils Rust          |
+------------------------+          |  + Orchestrateur (local)   |
          ^                          |  + .agent/agent-bridge (JS) |
          |                          |  + .agent/skills (Rust/JS)  |
  +--------------------+-----------+----------+----------------------------+
  |  Exposition plugin-side   |  Communication IPC (stdin/stdout, named pipe)  |
  |  - Slash commands         |  -------------------------------------------  |
  |  - Skill actions          |  .agent/agent-bridge  <--- JSONL comms -----> |
  |  - Rule config            |  .agent/skills (proxy)                        |
  +--------------------+-----------+----------+----------------------------+
                       |  Extension VS Code `hephaistos-chats` (React Flow + chats) |
                       +--------------------------------------------------------+
```

- **Séparation extension/plugin** : L'extension VS Code reste la porte d'entrée UI/expérience chat/canvas. Le plugin Devin ajoute une couche d'actions rapides, de compétences exécutables directement depuis l'interface Devin, et de configuration MCP allégée. Les deux peuvent coexister : le plugin appelle les points d'entrée locaux (via pipe ou RPC locale), l'extension conserve son canvas React Flow et ses chats.
- **Flux de données** : L'utilisateur lance une action depuis Devin → plugin → pipe vers `hphe-mcp.exe` → orchestrateur → skills → résultat → retour vers Devin (et éventuellement affichage dans l'extension via un événement `comms.jsonl`).

## Faisabilité Architecture

| Aspect | Évaluation | Notes |
|--------|------------|-------|
| **Technique** | **Réalisable** | Le plugin Devin peut lancer des processus externes et communiquer via JSON-RPC/stdin. Les 58 outils MCP sont déjà conçus pour ce mode. Le principal effort est le mapping des skills et la gestion du cycle de vie du bridge. |
| **Intégration** | **Moyenne** | Il faut fournir un `manifest.json` Devin pointant vers le répertoire du kit, ainsi qu'un script de démarrage qui lance `hphe-mcp.exe` si ce n'est pas déjà le cas, et qui expose les commandes plugin. Les fichiers `.agent/bridge` resteront en JS côté hôte ; le plugin ne tentera pas de les parser directement. |
| **Sécurité** | **Requiert revue** | Exposition de 58 outils Rust demande des sandboxings. Le plugin doit limiter les appels aux skills autorisés par l'utilisateur. Le bridge `acp-inject.js` ne doit pas être exécuté en mode automatique depuis Devin sans validation explicite. |
| **Performances** | **Bon** | Le pipe IPC vers `hphe-mcp.exe` est déjà éprouvé par l'extension VS Code. Le plugin n'ajoute qu'une couche de redirection, sans impact matériel supplémentaire. |
| **Maintenabilité** | **Modérée** | Les fichiers de bridge et de skills devront être documentés pour que les futurs développeurs sachent quelles parties sont "plugin-exposables" vs "runtime local". Un fichier de mapping `skills-to-plugin-commands.json` pourrait être généré automatiquement. |

## Questions Ouvertes

1. **Mode exécution du MCP** : `hphe-mcp.exe` doit-il être lancé automatiquement par le plugin à chaque session Devin, ou rester en tant que service système indépendant ? Quelle gestion du cycle de vie (démarrage/arrêt/redémarrage) est attendue ?
2. **Sérialisation des skills** : Les skills `.agent/skills` (notamment `bleubite-dispatch` et `flux`) utilisent-elles des formats de données internes spécifiques qui devraient être normalisés avant exposition plugin ? Y a-t-il un mapping souhaité vers des schémas JSON Devin standards ?
3. **Interaction extension ↔ plugin** : Existe-t-il un besoin de partager l'état UI du canvas React Flow ou les conversations chat depuis l'extension vers le plugin (et inversement) ? Dans l'affirmative, quel mécanisme de synchronisation (fichier partagé, mémoire commune, RPC) est privilégié ?
4. **Permissions utilisateur** : Le plugin s'exécutant au même niveau que l'utilisateur, les outils NTFS de `hphe-mcp.exe` auront-ils automatiquement les droits requis, ou faut-il une configuration de droits supplémentaires dans le manifeste Devin ?
5. **Versionning et mises à jour** : Le kit `hephaistos2-kit` et le plugin Devin seront-ils mis à jour de façon synchrone ? Faut-il prévoir un mécanisme de "compatibilité ascendante" pour les skills et les commandes slash lors des mises à jour du kit ?

---
*Fin de l'analyse de faisabilité. Ce document peut être sauvegardé sous `.agent/flux/feas-archi.md` par le worker hôte.*
