# `.agent/flux/plugin-devin/prd-archi.md`

## PRD : Architecture du Plugin Devin pour hephaistos2-kit

**Version** : 0.1  
**Date** : 2025‑08‑27  
**Auteur** : Worker texte Hephaistos  

---

### 1. Objectifs

- **Hybridation extension + plugin d’abord** : Le plugin Devin (`cli-anything-plugin`) vient en complément de l’extension VS Code `hephaistos-chats`, sans la remplacer. L’objectif est d’exposer depuis le plugin des actions rapides (commands, skills, configuration MCP) tout en laissant l’extension assurer l’interface UI (canvas React Flow, chats).
- **MCP `hphe-mcp.exe` en service permanent** : Le serveur MCP reste en cours d’exécution en arrière‑plan. Le plugin ne le lance pas à chaque session ; il se connecte à une instance existante ou la démarre une seule fois par cycle d’utilisation.
- **Skills normalisés** : Les modules `.agent/skills` (jointes, binome, flux, bleubite‑dispatch) sont traduits en commandes Devin `execute_skill_<nom>` ou en outils MCP proxy. Les entrées/sorties sont sérialisées en JSON compatibles avec le flux Devin.
- **Synchronisation état extension ↔ plugin** : Les providers actifs (outils, compétences, journaux) sont échangés via IPC (pipe nommé / stdin‑stdout). Le journal `comms.jsonl` sert de flux d’événements partagé.
- **Élevation NTFS dans le manifeste** : Le manifeste du plugin déclare les droits d’accès NTFS requis par les outils Rust, permettant au processus `hphe-mcp.exe` de fonctionner sans élévation manuelle de l’utilisateur à chaque lancement.

### 2. Périmètre

| Inclus | Exclus |
|--------|--------|
| ✅ Mapping des compétences vers des actions Devin | ❌ Remplacement de l’extension VS Code `hephaistos-chats` |
| ✅ Points d’extension : slash commands, rule configuration, MCP proxy | ❌ Exécution directe des fichiers `.agent/bridge` (workspace‑roster.js, acp‑inject.js, devin‑hub.js) depuis le plugin |
| ✅ IPC vers `hphe-mcp.exe` (58 outils Rust) | ❌ Exécution des outils Rust dans le sandbox du plugin sans processus hôte |
| ✅ Journalisation `comms.jsonl` visible dans le plugin | ❌ Modification du cycle de vie de l’orchestrateur Hephaistos |
| ✅ Configuration NTFS élévation dans manifeste | ❌ Accès non filtré à l’ensemble des 58 outils sans validation utilisateur |

### 3. Composants

#### 3.1. Côté plugin (exposables)

| Bloc | Mode d’exposition | Détails |
|------|-------------------|---------|
| **Skills** (`jointes`, `binome`, `flux`, `bleubite-dispatch`) | Commandes `execute_skill_<nom>` ou outils MCP proxy | Entrées/sorties JSON sérialisées ; mapping déclaré dans `skills-to-plugin-commands.json`. |
| **Règles d’exécution** (logique `acp-inject.js`) | Configuration déclarative `rules/` (YAML/JSON) du plugin | Appliquées avant/après exécution d’outils Devin. |
| **Configuration MCP** (`hphe-mcp.exe` params) | Proxy léger | Le plugin lance `hphe-mcp.exe` en processus enfant la première fois, puis réutilise l’instance en cours de vie. |
| **Commands slash existantes** | Redirection vers le plugin | `/hphe-search`, `/hphe-flux`, etc., réenregistrés dans le manifeste Duplugin, pointant vers le binaire local ou l’API locale. |
| **Journal `comms.jsonl`** | Vue d’activité en temps réel | Filtré selon les permissions de l’utilisateur ; affichage dans un panneau latéral du plugin. |

#### 3.2. Côté runtime (local)

| Bloc | Raison de staying local |
|------|--------------------------|
| **`hphe-mcp.exe`** | Processus lourd, 58 outils Rust, gestion mémoire NTFS/sémantique. Client plugin uniquement. |
| **Orchestrateur Hephaistos** | Moteur de décision, planification multi‑agents, état global. API locale uniquement. |
| **Bridge `.agent/agent-bridge`** | `workspace-roster.js`, `acp-inject.js`, `devin-hub.js`, `comms.jsonl` : dépendent de Node.js/VS Code. |
| **Extension VS Code `hephaistos-chats`** | Interface React Flow, état UI local, dépendances VS Code API. |
| **Permissions NTFS et sécurité** | Verrouillées au processus `hphe-mcp.exe` ; le plugin n’a pas ces droits sans élévation explicite. |

#### 3.3. Schéma d’architecture

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

### 4. Interfaces

| Interface | Protocole / Mode | Description |
|-----------|------------------|-------------|
| **Plugin ↔ `hphe-mcp.exe`** | JSON‑RPC sur stdin/stdout ou pipe nommé | 58 outils exposés en commandes `mcp_<outil>`. Le plugin envoie des requêtes `{"tool":"<outil>","params":{}}` et reçoit les résultats. |
| **Plugin ↔ Orchestrateur** | API locale (JSON) | Requêtes de planification, état des skills, réponse avec prochaines actions. |
| **Plugin ↔ Extension `hephaistos-chats`** | Événements `comms.jsonl` / RPC locale | Partage d’états (canvas, conversations) via fichier journal structuré ou messages post‑message entre extension et plugin. |
| **Plugin ↔ Compétences** | Mapping JSON `skills-to-plugin-commands.json` | Déclenchement `execute_skill_<nom>` avec payload normalisé ; réponse dans format Devin. |
| **Plugin ↔ Manifest** | Fichier `manifest.json` (CLI‑Anything‑Plugin) | Déclare les binaires, droits NTFS, commandes slash, et points d’entrée IPC. |

### 5. Jalons (J1 .. Jn)

| Jalon | Description | Critères de réussite |
|-------|-------------|----------------------|
| **J1 : Structure du manifeste** | Création du fichier `manifest.json` pointant vers le répertoire `hephaistos2-kit`, déclaration des 58 outils, élévation NTFS, commandes slash. | `manifest.json` valide lu par `cli-anything-plugin` ; plugin démarre sans erreur de configuration. |
| **J2 : Proxy MCP basique** | Mise en place du mécanisme de connexion au processus `hphe-mcp.exe` en cours d’exécution (ou lancement unique). | Le plugin peut envoyer `mcp_search` et recevoir des résultats de recherche NTFS. |
| **J3 : Mapping des compétences** | Génération du fichier `skills-to-plugin-commands.json` à partir des modules `.agent/skills`. | Quatre commandes `execute_skill_<nom>` fonctionnelles (jointes, binome, flux, bleubite‑dispatch) avec entrées/sorties JSON conformes. |
| **J4 : Redirection des slash commands** | Enregistrement dans le manifeste des commandes `/hphe-search`, `/hphe-flux` redirigeant vers les outils MCP correspondants. | Exécution d’une slash command depuis l’interface Devin lance l’outil MCP attendu. |
| **J5 : Journalisation partagée** | Intégration de la lecture du flux `comms.jsonl` dans l’UI du plugin (panneau activité). | Le plugin affiche les 20 dernières entrées du journal, filtrées selon les permissions utilisateur. |
| **J6 : Coexistence extension ↔ plugin** | Vérification que l’extension `hephaistos-chats` reste fonctionnelle à côté du plugin. | Lancement d’une session Devin ne casse pas l’extension ; les deux peuvent afficher le même contexte de travail. |
| **J7 : Revue de sécurité** | Validation des droits NTFS et sandboxing des 58 outils. | Aucune élévation de privilèges inattendue ; le manifeste réclame uniquement les droits requis. |
| **J8 : Documentation & mapping automatique** | Génération d’un guide de mapping skills↔commandes et mise à jour du fichier de décisions. | Tous les développeurs peuvent identifier quelles parties du bridge sont “plugin‑exposables” vs “runtime local”. |

### 6. Questions Ouvertes (à résoudre en phase de conception)

1. **Mode exécution du MCP** : `hphe-mcp.exe` lancé automatiquement par le plugin à chaque session ou service système indépendant ?  
2. **Sérialisation des skills** : Normalisation vers quels schémas JSON Devin avant exposition ?  
3. **Interaction extension ↔ plugin** : Besoin de synchronisation de l’état UI canvas React Flow ? Mécanisme privilégié ?  
4. **Permissions utilisateur** : Configuration supplémentaire de droits dans le manifeste ?  
5. **Versionning et mises à jour** : Synchronicité entre kit et plugin ; mécanisme de compatibilité ascendante pour skills et commandes slash.  

---

*Fin du PRD. Ce document sera écrit par le worker hôte vers le fichier `.agent/flux/plugin-devin/prd-archi.md`.*
