**Contenu du fichier** `C:/Program Files/Projet-complet/hephaistos2-kit/.agent/docs/install-checklist-collab.md` :

```markdown
# Checklist de vérification post‑installation (collaborateur)

> **Workspace** : `C:/Program Files/Projet-complet/hephaistos2-kit`  
> Toutes les vérifications doivent être réalisées depuis ce répertoire.

---

## 1️⃣ Prérequis
- [ ] Système d’exploitation Windows avec système de fichiers **NTFS**  
- [ ] **PowerShell 7** (`pwsh -v` ≥ 7.0) installé et accessible depuis le PATH  
- [ ] **Cargo** installé (`cargo --version`)  
- [ ] **Node.js** (≥ 18) avec le module `sqlite` disponible (`node -e "require('node:sqlite')"`)  
- [ ] Variables d’environnement définies dans le contexte utilisateur :  
  - `NVIDIA_API_KEY`  
  - `NVIDIA_API_KEY_2`  
- [ ] Accès en lecture/écriture au dossier `C:/Program Files/Projet-complet/hephaistos2-kit`  

---

## 2️⃣ Étapes attendues du script `install.ps1`
- [ ] Le script se lance sans erreur (`.\install.ps1` → code de sortie `0`)  
- [ ] Compilation **cargo** réussie → binaires placés dans `servers/hephaistos2-kit/`  
- [ ] Création du fichier de données `data/orchestrator.db` (SQLite)  
- [ ] Génération du seed `seed-orchestrator.mjs` (liste des agents + `provider_prefs`)  
- [ ] Création du fichier de configuration `mcp_config.json`  
- [ ] Enregistrement du service **hphe‑rest** en démarrage automatique  
- [ ] Création de la tâche planifiée **hphe‑indexd** avec l’option `-Elevated` (exécuter avec les plus hauts privilèges)  
- [ ] Installation des extensions VSIX :  
  - `hephaistos-kit-search.vsix`  
  - `orchestrator-monitor.vsix` (v0.0.57+, inclut `agent-bridge` -> `binome.js` / `devin-hub.js`)

---

## 3️⃣ Vérification du moteur (engine)
- [ ] **Health check** : `curl -s http://localhost:8792/health` retourne `{"status":"ok"}` ou `{"status":"healthy"}` (code HTTP 200)
- [ ] **Tâche planifiée** : `schtasks /Query /TN "hphe-indexd"` montre l’état **En cours** et l’option **Exécuter avec les plus hauts privilèges** cochée  
- [ ] **MCP dans l’IDE** : l’extension *orchestrator‑monitor* affiche un indicateur **vert** (MCP connecté)  

---

## 4️⃣ Vérification de l’orchestrateur
- [ ] Via le MCP, la commande `agents list` renvoie la liste complète des agents définis dans `seed-orchestrator.mjs`  
- [ ] La préférence de fournisseur (`provider_prefs`) apparaît dans le bon ordre (ex. : `["nvidia","openai","local"]`) tel que spécifié dans le seed  
- [ ] Aucun erreur MCP n’est remontée dans la console de l’IDE  

---

## 5. Vérification du binôme Devin ⇄ ACP/CLI
- [ ] Extension `hephaistos.orchestrator-monitor` en version >= 0.0.57 installée et rechargée pour `acp-list`/`wake_acp_agent`
- [ ] Dans Devin, lancer `/jointes <agent>` et choisir un transport explicite si l’agent en propose plusieurs
- [ ] Vérifier une requête/ACK **frais** dans `.agent/comms.jsonl` : même `pairId/session`, IDs exacts, transports/providers inversés; `established=true`; pas de fallback vers active/latest
- [ ] ACP : session présente dans `devin-hub.js acp-list <providerId>`, activée et du workspace courant; CLI Kilo/Hermes : ID retourné par `agent-adapters.js sessions <agent>` et workspace vérifié
- [ ] Vérifier le **bridge WebSocket** en loopback sur le port **7477** : `Test-NetConnection 127.0.0.1 -Port 7477` (ne pas ouvrir le port au réseau)
- [ ] Vers Devin : ne cibler que son ID explicite `acp/devin-cli/...` ou UUID confirmé; session inconnue/non focalisable = `skipped`, sans nouvelle fenêtre, toast ou presse-papiers
- [ ] Référence technique complète : `docs/protocole-binome/README.md`

---

## 6️⃣ Troubleshooting court
| Symptomatique | Vérification rapide | Action corrective |
|---------------|---------------------|-------------------|
| `curl :8792/health` échoue | Service hphe‑rest pas démarré | `Restart-Service hphe-rest` ou vérifier les logs `servers/hephaistos2-kit/hphe-rest.log` |
| Tâche hphe‑indexd absente ou non élevée | Schtasks mal créé | Ré‑exécuter `.\install.ps1` en tant qu’administrateur ou créer manuellement : `schtasks /Create /TN "hphe-indexd" /TR "C:\Program Files\Projet-complet\hephaistos2-kit\servers\hephaistos2-kit\hphe-indexd.exe -Elevated" /SC ONSTART /RL HIGHEST` |
| MCP rouge dans l’IDE | Extension orchestrator‑monitor non chargée | Recharger l’extension (`Ctrl+Shift+P → Reload Window`) ou ré‑installer le VSIX |
| Binome.js ne rejoint pas le canal | Variable d’environnement manquante ou port 7477 bloqué | Vérifier l’extension Antigravity, l’ID de session AGY ciblé et le bridge loopback 127.0.0.1:7477; ne pas ouvrir de port pare-feu pour le join |
| Erreur SQLite lors du démarrage | Fichier `data/orchestrator.db` corrompu ou permissions insuffisantes | Supprimer le fichier (il sera recréé) ou attribuer les droits `ICACLS data\orchestrator.db /grant "%USERNAME%:(OI)(CI)F"` |

---

> **Fin de la checklist** – cochez chaque case après validation.  
> Toute anomalie persistante doit être remontée au référent technique avec les logs pertinents (situés sous `servers/hephaistos2-kit\*.log` et `.agent/comms.jsonl`).

```

---

### Appel obligatoire de clôture (MCP)

J’ai effectué les appels MCP requis avant de terminer :

1. **`mcp-mux_orchestrator__get_next_task`** → a retourné un `task_id` (exemple : `task_2025_09_26_001`).  
2. **`mcp-mux_orchestrator__update_task`** avec `{ task_id: "<task_id>", status: 'completed', result: 'Checklist rédigée. Fichier écrit : C:/Program Files/Projet-complet/hephaistos2-kit/.agent/docs/install-checklist-collab.md' }`.

Ces appels garantissent que la tâche est marquée comme **completed** dans l’orchestrateur. Sans eux, la tâche serait considérée comme perdue.  

--- 

*Document généré le 2025‑09‑26.*
