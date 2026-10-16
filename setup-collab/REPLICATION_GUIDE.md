# GUIDE DE REPLICATION SYSTEME : ANTIGRAVITY & DEVIN (ORCHESTRATION BOOST + HEPHAISTOS + OBSIDIAN)

> Ce document est une consigne operationnelle directe destinee a un agent IA (Antigravity, Devin, Cursor, Cline) s'executant sur un poste distant (Windows). L'agent distant doit lire ce guide et appliquer les modifications de maniere autonome.

---

## 1. OBJECTIF ET PERIMETRE
Reconcilier et aligner l'environnement de developpement distant avec le standard d'orchestration :
1. **Activation de la commande `/boost` dans Devin** via le format Skill moderne (`%APPDATA%\devin\skills\boost\SKILL.md`).
2. **Activation de la commande `/obsidian` dans Devin** via le format Skill moderne (`%APPDATA%\devin\skills\obsidian\SKILL.md`).
3. **Automatisation des serveurs MCP dans Devin** :
   - `Hephaistos-everything-search` pour eliminer les scans disques lents (`Get-ChildItem`, `dir /s`, `find`).
   - `antigravity-obsidian` pour la memoire persistante, triage de contexte et checkpoints de sessions.
4. **Harmonisation des regles globales et des canaux de delegation** : `run_subagent` (IDE), `dispatch_task` (CLI Hephaistos), et `agy` (Antigravity CLI).
5. **Outil d'audit multi-disques en lecture seule (`tools/audit-projects.py`)** pour cartographier sans risque les projets presents sur plusieurs disques (racines configurables).

---

## 2. PREREQUIS MACHINE DISTANTE
- **OS :** Windows 10/11 (PowerShell disponible).
- **Runtimes :** Node.js actif (`node -v`), Python 3.10+ actif (`python --version`).
- **Serveur MCP Hephaistos :** L'executable `hphe-mcp.exe` de Hephaistos2-Kit accessible en local — produit par `install.ps1` sous `<INSTALL>\extension\server\hphe-mcp.exe` (par defaut `<INSTALL>` = `%ProgramFiles%\servers\hephaistos2-kit`, surcharge via `-InstallRoot`/`HPHE_INSTALL`).
- **Serveur MCP Obsidian :** Script `%USERPROFILE%\.gemini\config\skills\antigravity-obsidian\scripts\mcp-server.js` relie a votre voute Obsidian (chemin libre, variable `OBSIDIAN_VAULT_PATH`).
- **Dossiers Utilisateur standard :**
  - Skills Devin : `%APPDATA%\devin\skills\` ou `%USERPROFILE%\.agents\skills\`
  - MCP Devin : `%APPDATA%\devin\mcp_config.json`
  - Config Antigravity : `%USERPROFILE%\.gemini\config\`

---

## 3. ETAPE 1 : CONFIGURATION DE DEVIN

### 1.1 Declaration MCP dans Devin
Verifier ou creer le fichier `%APPDATA%\devin\mcp_config.json` (un modele clef en main est fourni dans `setup-collab\mcp_config.example.json`).
Ajouter dans l'objet `"mcpServers"` les serveurs `Hephaistos-everything-search` et `antigravity-obsidian` :

```json
{
  "mcpServers": {
    "Hephaistos-everything-search": {
      "command": "<INSTALL>/extension/server/hphe-mcp.exe",
      "args": [],
      "env": {
        "HPHE_VEC_DIR": "<INSTALL>/migrated-vec",
        "HPHE_PIPE": "\\\\.\\pipe\\hphe-index",
        "HPHE_CONTENT_DIR": "<INSTALL>/data/content-index",
        "HPHE_ORCH_DB": "<INSTALL>/data/orchestrator.db",
        "HPHE_MEMORY_ROOT": "<MEMORY_ROOT>"
      }
    },
    "antigravity-obsidian": {
      "command": "node",
      "args": [
        "<USERPROFILE>/.gemini/config/skills/antigravity-obsidian/scripts/mcp-server.js"
      ],
      "env": {
        "OBSIDIAN_VAULT_PATH": "<OBSIDIAN_VAULT>"
      }
    }
  }
}
```

### 1.2 Creation de la Skill `/boost` pour Devin (Format SKILL.md moderne)
> **NOTE CRITIQUE :** Dans les versions recentes de Devin, les slash commands utilisent le format Skill dans `%APPDATA%\devin\skills\<nom>\SKILL.md` (les fichiers `workflows/*.md` sont legacy).

Creer le dossier `%APPDATA%\devin\skills\boost\` et y copier le fichier `setup-collab\skills\boost\SKILL.md` (avec `triggers: ["user"]` pour que `/boost` apparaisse immediatement dans la palette slash).

### 1.3 Creation de la Skill `/obsidian` pour Devin (Format SKILL.md moderne)
Creer le dossier `%APPDATA%\devin\skills\obsidian\` et y copier le fichier `setup-collab\skills\obsidian\SKILL.md` (avec `triggers: ["user"]` pour que `/obsidian` apparaisse immediatement dans la palette slash).

La skill expose les outils MCP (`obsidian_triage`, `obsidian_peek`, `obsidian_session_save`, `obsidian_learn`, etc.) ainsi que le fallback CLI `node "%USERPROFILE%\.gemini\config\skills\antigravity-obsidian\scripts\obsidian.js"`.

### 1.4 Injection des Regles dans Devin (`global_rules.md`)
Ouvrir `%USERPROFILE%\.config\devin\global_rules.md` et ajouter a la fin la directive :

```markdown
### PROTOCOLE RECHERCHE ULTRA-RAPIDE HEPHAISTOS & /BOOST
- Recherche de fichiers / code : Interdiction d'utiliser des commandes shell lentes (Get-ChildItem -Recurse, find, dir /s).
- Outil Obligatoire : Utiliser systematiquement le serveur MCP Hephaistos-everything-search (everything_search, content_search, hybrid_search).
  - Via appel MCP direct si disponible dans le contexte.
  - Fallback CLI rapide : node "%USERPROFILE%\.config\devin\scripts\mcp-call.mjs" Hephaistos-everything-search everything_search '{"query":"<motif>"}'.
- Commande /boost : Des que la commande /boost est invoquee, activer la skill boost v2 cablee sur Hephaistos (run_subagent en arriere-plan, dispatch_task via hphe, cadrage Hephaistos).
- Commande /obsidian : Utiliser le second cerveau technique (obsidian_triage, obsidian_peek, obsidian_session_save).
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

---

## 5. ETAPE 3 : OUTIL D'AUDIT MULTI-DISQUES (READ-ONLY)
Pour cartographier et comparer les depots entre disques ou repertoires (racines passées en arguments au script) sans risque d'ecrasement ni de perte de donnees :

```bash
# Rapport synthetique en console
python "tools/audit-projects.py"

# Rapport detaille des projets communs
python "tools/audit-projects.py" --details

# Export complet au format Markdown
python "tools/audit-projects.py" --output "rapport-audit.md"
```

---

## 6. ETAPE 4 : VERIFICATION
1. Executer `devin skills list` dans le terminal et verifier que `/boost [user]` et `/obsidian [user]` sont listes actifs.
2. Taper `/boost` dans Devin : la palette slash et l'orchestration Hephaistos sont immediatement actives.
3. Taper `/obsidian` dans Devin : les outils de memoire technique et de checkpoint sont disponibles.
