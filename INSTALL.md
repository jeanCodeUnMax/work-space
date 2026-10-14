# INSTALL — Hephaistos2-Kit

Tutoriel d'installation complet. Séparation stricte :

- **PROJET** : `C:\Program Files\Projet-complet\hephaistos2-kit` — sources, git, docs, `.agent/`
- **INSTALL** : `C:\Program Files\servers\hephaistos2-kit` — runtime (binaires + `data/`), régénéré par `install.ps1`, jamais édité à la main

## Prérequis

| Requis | Pourquoi |
|---|---|
| Windows 10/11, NTFS | le démon lit `$MFT` / USN |
| PowerShell 7 (`pwsh`) | tous les scripts ciblent PS7 |
| Rust stable (`cargo`) | rebuild du workspace `hphe/` |
| VS Code-fork (Devin, Antigravity…) | hôte des extensions + client MCP |
| Droits admin | uniquement pour la tâche planifiée `hphe-indexd` (`-Elevated`) |

## Étapes

### 1. Cloner

```powershell
git clone --recurse-submodules https://github.com/projet-temporaire/hephaistos2-kit.git "C:\Program Files\Projet-complet\hephaistos2-kit"
cd "C:\Program Files\Projet-complet\hephaistos2-kit"
```

### 2. Installer

```powershell
pwsh -ExecutionPolicy Bypass -File install.ps1            # build + deploy
pwsh -ExecutionPolicy Bypass -File install.ps1 -Elevated  # + tâche hphe-indexd SYSTEM (admin)
pwsh -ExecutionPolicy Bypass -File install.ps1 -SkipBuild # redeploy sans rebuild
```

`install.ps1` fait, dans l'ordre :

1. `cargo build --release --workspace` dans `hphe/`
2. Copie `hphe-mcp.exe`, `hphe-rest.exe`, `hphe-indexd.exe` → `INSTALL\extension\server\` (+ miroir projet)
3. Crée `INSTALL\data\` (content-index, orchestrator.db), `migrated-vec\`, jonction `memory-database` **+ seed `orchestrator.db`** : roster agents (nim1/nim2 = workers NIM directs, kilo/hermes = renforts, agy/devin = agents directs) et `provider_prefs` par défaut — idempotent, n'écrase jamais un ordre existant
4. Écrit `Hephaistos-everything-search` dans `%APPDATA%\devin\mcp_config.json`
5. Autostart `hphe-rest` via Startup folder
6. (avec `-Elevated`) tâche planifiée `hphe-indexd` en SYSTEM

### 3. Extensions VS Code

```powershell
code --install-extension extension\hephaistos-kit-search-1.0.3.vsix
code --install-extension extensions\orchestrator-monitor\orchestrator-monitor-0.0.38.vsix
```

Le vsix `orchestrator-monitor` embarque `agent-bridge/` complet (binôme Devin⇄AGY : `binome.js`, `devin-hub.js`, `agy-hub.js`, `comms.js`, `current-cascade.js`, `listener.js`) + `ws-bridge/` (daemon `ws://127.0.0.1:7477`). Le bridge est aussi auto-démarré par `start-workspace.ps1` si le port 7477 n'écoute pas.

(ou glisser-déposer dans le panneau Extensions)

### 4. Configuration

- `.env` : copier `.env.example` → `.env`, ajuster `AGENT_DB_ROOT`
  (défaut `F:/Sqlite-DB/` — racine mémoire partagée).
- Clés API (`NVIDIA_API_KEY`, `MISTRAL_API_KEY`…) : variables
  d'environnement **utilisateur** — jamais dans `.env` ni le repo.

## Vérification

```powershell
curl http://127.0.0.1:8792/health
# {"status":"healthy","pipe_connected":true,"ingest_busy":false,...}

schtasks /query /tn hphe-indexd       # démon index actif
```

Dans Devin : panneau MCP → `Hephaistos-everything-search` vert (57 outils).

## Premier démarrage IDE

La tâche workspace `.agent/scripts/start-workspace.ps1` (pwsh) s'exécute :
junction `memory-database` → `AGENT_DB_ROOT/current_workspace`, purge des MCP
orphelins, `content_ingest` via REST. Si la boucle `hphe-rest` écrit déjà,
l'appel est **mis en file** — le script affiche
*« appel en file d'attente, patience »* (comportement voulu, pas un gel).

## Dépannage

| Symptôme | Cause | Fix |
|---|---|---|
| `pipe_connected:false` | `hphe-indexd` arrêté | `schtasks /run /tn hphe-indexd` |
| `ingest_busy:true` long | boucle en cours sur grosse racine | normal — attendre ou vérifier `data\hphe-rest.log` |
| MCP absent dans l'IDE | config pas écrite | relancer `install.ps1` (étape 4) |
| recherche vide | index froid | attendre 1er scan `hphe-indexd` (~1 min) |

## Désinstallation

`servers\servers_backup\` conserve les serveurs legacy. Supprimer :
tâche `hphe-indexd`, autostart `hphe-rest.cmd`, entrée MCP, dossier INSTALL.
