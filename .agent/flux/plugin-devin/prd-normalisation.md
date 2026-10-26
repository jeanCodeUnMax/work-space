**.agent/flux/plugin-devin/prd-master.md**
```markdown
# PRD Consolidé – Plugin Devin pour hephaistos2-kit

## 1. Vision
Le plugin **cli‑anything‑plugin** s’inscrit en complément de l’extension VS Code *hephaistos‑chats*. Il expose des commandes rapides, des skills normalisées et un proxy MCP vers le serveur `hphe‑mcp.exe`, tandis que l’extension conserve l’interface UI (canvas React Flow, chats). L’ensemble vise une hybridation « extension + plugin d’abord » sans remplacement de l’outil existant.

## 2. Périmètre
| Inclus | Exclus |
|--------|--------|
| ✅ Mapping compétences → actions Devin | ❌ Remplacement de *hephaistos‑chats* |
| ✅ Points d’extension : slash commands, rule configuration, MCP proxy | ❌ Exécution directe des fichiers `.agent/bridge` depuis le plugin |
| ✅ IPC vers `hphe‑mcp.exe` (58 outils Rust) | ❌ Exécution d’outils Rust dans le sandbox du plugin sans processus hôte |
| ✅ Journalisation `comms.jsonl` visible dans le plugin | ❌ Modification du cycle de vie de l’orchestrateur Hephaistos |
| ✅ Configuration NTFS élévation dans le manifeste | ❌ Accès non filtré à l’ensemble des 58 outils sans validation utilisateur |

## 3. Architecture cible (hybride → IPC)
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

### 3.1. Côté plugin (exposables)
| Bloc | Mode d’exposition | Détails |
|------|-------------------|---------|
| **Skills** (`jointes`, `binome`, `flux`, `bleubite-dispatch`) | Commandes `execute_skill_<nom>` ou outils MCP proxy | Entrées/sorties JSON sérialisées ; mapping dans `skills-to-plugin-commands.json`. |
| **Règles d’exécution** (logic `acp-inject.js`) | Configuration déclarative `rules/` (YAML/JSON) du plugin | Appliquées avant/après exécution d’outils Devin. |
| **Configuration MCP** (`hphe-mcp.exe` params) | Proxy léger | Le plugin lance `hphe‑mcp.exe` une première fois, puis réutilise l’instance en cours de vie. |
| **Commands slash existantes** | Redirection vers le plugin | `/hphe-search`, `/hphe-flux`, etc., réenregistrés dans le manifeste Duplugin. |
| **Journal `comms.jsonl`** | Vue d’activité en temps réel | Filtré selon permissions ; affichage dans un panneau latéral du plugin. |

### 3.2. Côté runtime (local)
| Bloc | Raison de staying local |
|------|--------------------------|
| **`hphe-mcp.exe`** | Processus lourd, 58 outils Rust, gestion mémoire NTFS/sémantique. Client plugin uniquement. |
| **Orchestrateur Hephaistos** | Moteur de décision, planification multi‑agents, état global. API locale uniquement. |
| **Bridge `.agent/agent-bridge`** | `workspace-roster.js`, `acp-inject.js`, `devin-hub.js`, `comms.jsonl` : dépendent de Node.js/VS Code. |
| **Extension VS Code `hephaistos-chats`** | Interface React Flow, état UI local, dépendances VS Code API. |
| **Permissions NTFS et sécurité** | Verrouillées au processus `hphe‑mcp.exe` ; le plugin n’a pas ces droits sans élévation explicite. |

### 3.3. Interfaces
| Interface | Protocole / Mode | Description |
|-----------|------------------|-------------|
| **Plugin ↔ `hphe-mcp.exe`** | JSON‑RPC sur stdin/stdout ou pipe nommé | 58 outils exposés en commandes `mcp_<outil>`. Le plugin envoie `{"tool":"<outil>","params":{}}` et reçoit les résultats. |
| **Plugin ↔ Orchestrateur** | API locale (JSON) | Requêtes de planification, état des skills, réponse avec prochaines actions. |
| **Plugin ↔ Extension `hephaistos-chats`** | Événements `comms.jsonl` / RPC locale | Partage d’états (canvas, conversations) via fichier journal structuré ou messages post‑message. |
| **Plugin ↔ Compétences** | Mapping JSON `skills-to-plugin-commands.json` | Déclenchement `execute_skill_<nom>` avec payload normalisé ; réponse format Devin. |
| **Plugin ↔ Manifest** | Fichier `manifest.json` (CLI‑Anything‑Plugin) | Déclare les binaires, droits NTFS, commandes slash, et points d’entrée IPC. |

### 3.4. Normalisation des skills
- Chaque module `.agent/skills` (jointes, binome, flux, bleubite‑dispatch) est traduit en commande `execute_skill_<nom>`.
- Le schéma d’entrée/sortie suit le format JSON Devin attendu par le plugin.
- Mapping automatique via fichier `skills-to-plugin-commands.json` généré à la construction.

### 3.5. Sécurité & élévation NTFS
- Le manifeste du plugin déclare les droits d’accès NTFS requis par les outils Rust.
- `hphe-mcp.exe` s’exécute avec ces droits ; l’élévation est demandée une seule fois au démarrage du service MCP.
- Aucune élévation manuelle de l’utilisateur n’est requise à chaque session.

### 3.6. Service MCP permanent
- `hphe-mcp.exe` tourne en arrière‑plan en tant que service permanent.
- Le plugin se connecte à une instance existante ; si none, il la lance une fois par cycle d’utilisation et la garde en mémoire pour la session en cours.

### 3.7. Synchronisation d’état
- Le flux `comms.jsonl` sert de journal d’événements partagé entre plugin, extension et bridge.
- Les providers actifs (outils, compétences, journaux) sont synchronisés via IPC (pipe nommé / stdin‑stdout).
- Le plugin affiche les 20 dernières entrées du journal, filtrées selon les permissions utilisateur.

## 4. Jalons (J1 .. J8) – voir *tracker.md* pour le détail ordonné.

---

*Fin du PRD consolidé. Ce document sera écrit par le worker hôte vers le fichier `.agent/flux/plugin-devin/prd-master.md`.*
```

**.agent/flux/plugin-devin/tracker.md**
```markdown
# Tracker de jalons – Plugin Devin hephaistos2-kit

| Jalon | Tâches ordonnées | Dépendances | Livrables attendus |
|-------|------------------|-------------|--------------------|
| **J1 : Structure du manifeste** | 1. Créer `manifest.json` racine<br>2. Lister les 58 outils Rust<br>3. Déclarer élévation NTFS<br>4. Enregistrer commandes slash `/hphe-search`, `/hphe-flux` | Aucun | `manifest.json` valide lu par `cli-anything-plugin` ; plugin démarre sans erreur de configuration. |
| **J2 : Proxy MCP basique** | 1. Implémenter connexion stdin/stdout vers `hphe-mcp.exe`<br>2. Tester commande `mcp_search` | J1 (manifest complet) | Le plugin peut envoyer `mcp_search` et recevoir résultats de recherche NTFS. |
| **J3 : Mapping des compétences** | 1. Extraire les modules `.agent/skills` (jointes, binome, flux, bleubite-dispatch)<br>2. Générer `skills-to-plugin-commands.json`<br>3. Tester quatre commandes `execute_skill_<nom>` | J1 (structure manifeste) | Quatre compétences fonctionnelles avec entrées/sorties JSON conformes au format Devin. |
| **J4 : Redirection des slash commands** | 1. Mettre à jour `manifest.json` pour pointer vers les outils MCP correspondants<br>2. Vérifier exécution depuis l’interface Devin | J2 (proxy MCP opérationnel) | Exécution d’une slash command depuis Devin lance l’outil MCP attendu. |
| **J5 : Journalisation partagée** | 1. Intégrer lecture de `comms.jsonl` dans l’UI du plugin<br>2. Filtrer selon permissions utilisateur<br>3. Afficher les 20 dernières entrées | J1 (manifest) & J2 (MCP) | Panneau activité du plugin affiche le flux d’événements partagé. |
| **J6 : Coexistence extension ↔ plugin** | 1. Lancer une session Devin tout en gardant *hephaistos-chats* actif<br>2. Vérifier que l’extension UI n’est pas cassée | J1‑J5 (tous les composants en place) | Les deux composants peuvent afficher le même contexte de travail sans conflit. |
| **J7 : Revue de sécurité** | 1. Valider droits NTFS déclarés dans manifeste<br>2. S’assurer que `hphe-mcp.exe` s’exécute avec seuls droits requis<br>3. Documenter sandboxing des 58 outils | J1 (manifest) | Aucune élévation de privilèges inattendue ; manifeste ne demande que les droits NTFS stricts. |
| **J8 : Documentation & mapping automatique** | 1. Générer guide de mapping skills↔commandes<br>2. Mettre à jour fichier de décisions<br>3. Rendre le mapping accessible à tous les développeurs | J3 (mapping compétences) | Document complet listant parties « plugin‑exposables » vs « runtime local ». |

**Ordre d’exécution recommandé :** J1 → J2 → J3 → J4 → J5 → J6 → J7 → J8.  
Chaque jalon est considéré terminé uniquement lorsque ses livrables sont validés et que les dépendances précédentes sont validées.

*Fin du tracker. Ce fichier sera écrit par le worker hôte vers `.agent/flux/plugin-devin/tracker.md`.*
```
