# GUIDE DE REPLICATION SYSTEME : ANTIGRAVITY & DEVIN (ORCHESTRATION BOOST + HEPHAISTOS)

> Ce document est une consigne operationnelle directe destinee a un agent IA (Antigravity, Devin, Cursor, Cline) s'executant sur un poste distant (Windows). L'agent distant doit lire ce guide et appliquer les modifications de maniere autonome.

---

## 1. OBJECTIF ET PERIMETRE
Reconcilier et aligner l'environnement de developpement distant avec le standard d'orchestration :
1. **Activation de la commande `/boost` dans Devin** via un workflow d'orchestration haute precision.
2. **Automatisation du serveur MCP Hephaistos (`Hephaistos-everything-search`)** dans Antigravity et Devin pour eliminer les scans disques lents (`Get-ChildItem`, `dir /s`, `find`).
3. **Harmonisation des regles globales** : Rigueur chirurgicale, boucle de test/linter obligatoire, politique stricte de zero emoji.

---

## 2. PREREQUIS MACHINE DISTANTE
- **OS :** Windows 10/11 (PowerShell disponible).
- **Runtimes :** Node.js actif (`node -v`).
- **Serveur MCP Hephaistos :** L'executable `hphe-mcp.exe` de Hephaistos2-Kit accessible en local (par exemple dans `C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe` ou dans le clone du depot).
- **Dossiers Utilisateur standard :**
  - Config Devin : `%USERPROFILE%\.config\devin\`
  - MCP Devin : `%APPDATA%\devin\mcp_config.json`
  - Config Antigravity : `%USERPROFILE%\.gemini\config\`

---

## 3. ETAPE 1 : CONFIGURATION DE DEVIN

### 1.1 Declaration MCP dans Devin
Verifier ou creer le fichier `%APPDATA%\devin\mcp_config.json`.
Ajouter dans l'objet `"mcpServers"` le serveur `Hephaistos-everything-search` :

```json
{
  "mcpServers": {
    "Hephaistos-everything-search": {
      "command": "C:/Program Files/servers/hephaistos2-kit/extension/server/hphe-mcp.exe",
      "args": [],
      "env": {
        "HPHE_VEC_DIR": "C:/Program Files/servers/hephaistos2-kit/migrated-vec",
        "HPHE_PIPE": "\\\\.\\pipe\\hphe-index",
        "HPHE_CONTENT_DIR": "C:/Program Files/servers/hephaistos2-kit/data/content-index",
        "HPHE_ORCH_DB": "C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db",
        "HPHE_MEMORY_ROOT": "F:/Sqlite-DB/agentmemory"
      }
    }
  }
}
```

### 1.2 Creation du Workflow `/boost` pour Devin
Creer le fichier `%USERPROFILE%\.config\devin\workflows\boost.md` (ou copier le fichier `boost.md` present dans ce dossier).

### 1.3 Injection des Regles dans Devin (`global_rules.md`)
Ouvrir `%USERPROFILE%\.config\devin\global_rules.md` et ajouter a la fin la directive :

```markdown
### PROTOCOLE RECHERCHE ULTRA-RAPIDE HEPHAISTOS & /BOOST
- Recherche de fichiers / code : Interdiction d'utiliser des commandes shell lentes (Get-ChildItem -Recurse, find, dir /s).
- Outil Obligatoire : Utiliser systematiquement le serveur MCP Hephaistos-everything-search (everything_search, content_search, hybrid_search).
  - Via appel MCP direct si disponible dans le contexte.
  - Fallback CLI rapide : node "%USERPROFILE%\.config\devin\scripts\mcp-call.mjs" Hephaistos-everything-search everything_search '{"query":"<motif>"}'.
- Commande /boost : Des que la commande /boost est invoquee par l'utilisateur, appliquer le workflow ~/.config/devin/workflows/boost.md (cadrage Hephaistos prealable, decomposition rigoureuse et boucle de verification complete).
```

---

## 4. ETAPE 2 : CONFIGURATION D'ANTIGRAVITY

### 2.1 Regles d'Automatisation `/boost` dans Antigravity
Ouvrir le fichier de regles actives d'Antigravity (`%USERPROFILE%\.gemini\config\rules\obsidian-brain.md` ou `global_rules.md`).
Ajouter la section obligatoire :

```markdown
### PROTOCOLE D'AUTOMATISATION HEPHAISTOS DANS /BOOST (MANDATAIRE) :
- Principe : A chaque activation de la fonction /boost ou d'une tache d'orchestration / delegation :
  1. Phase 0 (Recherche & Indexation Pre-Delegation) : Avant d'appeler invoke_subagent, l'orchestrateur DOIT appeler automatiquement Hephaistos-everything-search.
  2. Phase 1 (Injection de Contexte aux Sous-Agents) : Transmettre systematiquement les chemins et extraits decouverts dans le prompt adresse au sous-agent.
  3. Phase 2 (Suivi de Taches Hephaistos) : Enregistrer et clore les sous-taches avec Hephaistos create_task et update_task.
```

### 2.2 Fixation de l'Identite
- Nom de l'agent : `Antigravity`
- Profil : Ingenieur senior d'elite, autonome, pragmatique et de precision chirurgicale.
- Politique : Zero emoji absolu.
