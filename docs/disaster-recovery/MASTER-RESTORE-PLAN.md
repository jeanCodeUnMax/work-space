# MASTER DISASTER RECOVERY PLAN // HEPHAISTOS2-KIT
=====================================================
Guide d'éradication de toute dépendance volatile et de reconstruction complète (Bare-Metal -> 100% Opérationnel)
Zéro Perte de Performance • Tolérance Zéro • Reproductibilité Totale

---

## 1. CARTOGRAPHIE DES EMPLACEMENTS CRITIQUES HORS DU REPO

Si le disque C: est formaté, voici l'inventaire exact des fichiers et dossiers indispensables qui vivent en dehors de `C:\data-sys\hephaistos2-kit` :

### A. Tâches Planifiées Windows (Task Scheduler)
Ces tâches doivent être réenregistrées avec les mêmes chemins et utilisateurs :
1. `hphe-indexd` : Daemon d'indexation NTFS $MFT -> `C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-indexd.exe`
2. `hphe-watchdog` : Gardien des 13 daemons (toutes les 10 min) -> `wscript.exe //nologo "C:\Users\webma\.hephaistos\scripts\run-hidden.vbs" "powershell -ExecutionPolicy Bypass -File C:\Users\webma\.hephaistos\scripts\hphe-watchdog.ps1"`
3. `hphe-taskwatch` : Poller de tâches (toutes les 5 min) -> `wscript.exe //nologo "C:\Users\webma\.hephaistos\scripts\run-hidden.vbs" "cmd /c set HPHE_WORKSPACE=C:\data-sys\hephaistos2-kit&& node C:\data-sys\hephaistos2-kit\tools\taskwatch.mjs"`
4. `n8n` & `n8n-auth-proxy` : Lancement discret des composants n8n -> `start-n8n.cmd` & `start-n8n-proxy.cmd`
5. `CerbereShield` : Gardien de sécurité local -> `C:\data-sys\security-sheeld\dist\CerbereShield\CerbereShield.exe`

### B. Démarrage Automatique (Startup Folder)
Chemin : `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`
1. `hphe-rest.vbs` : Lance à la fois le Gateway REST (`:8792` pure) et le Worker Ingestion (`:8793`)
2. `mcp-mux-http-bridge.vbs` : Démarre le pont HTTP :5682 pour le broker d'outils MCP
3. `ws-bridge-http.vbs` : Démarre le bus WebSocket :7477 / :7478
4. `n8n-ai-gateway.vbs` : Démarre la passerelle IA n8n sur le port :11435
5. `Herald-Tray.lnk` / `OpenCLI-Robot.lnk` / `Ollama.lnk`

### C. Services Windows
1. `BeaconCollector` (Status: Automatic) : Collecteur d'événements et de télémétrie locale

### D. Configurations Utilisateur (%USERPROFILE%)
1. `C:\Users\webma\.config\mcp-mux\mcp-mux.json` :
   - Fichier maître définissant les 18 serveurs MCP du broker
   - **Crucial** : paramètre `initTimeoutMs: 120000` pour OmniRoute
2. `C:\Users\webma\.hephaistos\` :
   - `scripts/hphe-watchdog.ps1` : Le script maître de recouvrance des 13 sondes
   - `scripts/run-hidden.vbs` : Wrapper de lancement en arrière-plan sans fenêtre cmd
   - `servers/mcp-mux/src/server-manager.mjs` : Broker patché supportant `initTimeoutMs`
3. `C:\Users\webma\.claude\CLAUDE.md` : Les règles universelles multi-agents (Loi Canal Unique, Asimov, etc.)
4. `C:\Users\webma\.devin\AGENTS.md` : Règles de l'environnement Devin
5. `C:\Users\webma\.n8n\` : Base SQLite locale (`database.sqlite`, WAL mode) contenant les workflows configurés

### E. Serveurs Installés (Program Files)
1. `C:\Program Files\servers\hephaistos2-kit\extension\server\` :
   - `hphe-mcp.exe`
   - `hphe-indexd.exe`
   - `hphe-rest.exe`
   - `hphe-rest.cmd` (passé sans ingestion)
   - `hphe-rest-ingest.cmd` (port :8793)
   - `.mcp-access` (allowlist machine locale)

---

## 2. PROCÉDURE DE RECONSTRUCTION APRÈS FORMATAGE (Zero-Downtime Blueprint)

### Phase 1 : Pré-requis OS & Outils de Base
1. Installer Windows 11 avec compte utilisateur `webma` (pour préserver les chemins absolus sans re-mapping).
2. Activer Git, Node.js v22+ (via NVM), Python 3.10+, PowerShell 7+.
3. Installer Visual Studio Code / Devin / Windsurf.
4. Cloner les dépôts maîtres dans `C:\data-sys\` :
   - `C:\data-sys\hephaistos2-kit` (depuis `git@github.com:jeanCodeUnMax/work-space.git`)
   - `C:\data-sys\OmniRoute`
   - `C:\data-sys\n8n`
   - `C:\data-sys\claude-skills-mux`

### Phase 2 : Restauration des Profils Utilisateur
1. Recréer les dossiers `~/.config/mcp-mux/`, `~/.hephaistos/scripts/`, `~/.claude/`, `~/.devin/`.
2. Restaurer `mcp-mux.json` (avec les 18 serveurs configurés).
3. Restaurer `CLAUDE.md` et `AGENTS.md` dans les profils racine.
4. Restaurer `hphe-watchdog.ps1` et `run-hidden.vbs` dans `~/.hephaistos/scripts/`.

### Phase 3 : Déploiement des Serveurs Core Hephaistos
1. Exécuter l'installateur : `powershell -ExecutionPolicy Bypass -File C:\data-sys\hephaistos2-kit\install.ps1 -Elevated`.
2. Vérifier que `C:\Program Files\servers\hephaistos2-kit\` contient bien les 3 binaires Rust (`hphe-mcp.exe`, `hphe-indexd.exe`, `hphe-rest.exe`).
3. Vérifier la présence du fichier `.mcp-access` contenant la racine autorisée `C:\data-sys`.
4. Remplacer `hphe-rest.cmd` et ajouter `hphe-rest-ingest.cmd` (fournis dans `extensions/search-ext/server/`).

### Phase 4 : Raccordement du Broker MCP Mux (654 outils)
1. S'assurer que le fichier `server-manager.mjs` dans `~/.hephaistos/servers/mcp-mux/src/` intègre bien le patch `initTimeoutMs`.
2. Démarrer le broker et le pont HTTP `:5682`.
3. Vérifier : `curl http://127.0.0.1:5682/tools` -> doit retourner 654 outils.

### Phase 5 : Raccordement des Automatisations & Tâches
1. Copier les raccourcis `.vbs` dans le dossier Startup (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`).
2. Réenregistrer les tâches planifiées via script PowerShell.
3. Importer le workflow n8n durci `.agent/n8n-hphe-healthcheck.json` (avec le portillon `Backlog Zero`).

### Phase 6 : Test de Validation Globale (Smoke Test V6)
Exécuter le script de diagnostic global :
- Les 8 sondes HTTP/TCP doivent répondre en <100ms.
- `hphe-rest /health` doit afficher `ingest_busy: false`.
- Lancer le test Bleubites : `acp-inject.js` avec une tâche témoin -> doit se fermer avec `DONE:<id>`.
- Le watchdog `hphe-watchdog.ps1` doit afficher toutes les sondes à l'état `OK`.
