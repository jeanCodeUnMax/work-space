# GUIDE OPERATIONNEL DE CONFIGURATION — AGENT COLLABORATEUR

> Ce document est destine a l'agent IA (Devin, Antigravity, Cursor, Windsurf) ou a l'ingenieur operant sur le poste collaborateur distant.
> Suivre strictement cette procedure pour repliquer l'architecture Hephaistos sans aucune configuration manuelle en dur.

---

## 1. Principes Fondamentaux de Portabilite

1. **Zero chemin absolu en dur** : Tous les scripts utilisent des variables d'environnement dynamiques (`$env:USERPROFILE`, `$env:APPDATA`, `$PSScriptRoot`).
2. **Dual-Mode ACP + CLI** :
   - Mode ACP : reserve au protocole binome (`/jointes`), aux communications directes et au chat interactif.
   - Mode CLI : reserve a l'orchestrateur Hephaistos (`dispatch_task`) pour executer des taches d'arriere-plan sans surcharger l'interface graphique.
3. **Concurrence Maitrisee** : Maximum 2 workers CLI simultanes autorises sur la machine hote, classes sous `BELOW_NORMAL_PRIORITY_CLASS`.

---

## 2. Procedure de Deploiement Rapide

### Option A : Lancement via wrapper Windows (Recommande)
Double-cliquer ou executer depuis le terminal :
```cmd
setup-collab\configurer-devin-agents.cmd
```

### Option B : Lancement PowerShell direct
Depuis PowerShell (ou PowerShell 7 `pwsh`) :
```powershell
pwsh -ExecutionPolicy Bypass -File .\setup-collab\configurer-devin-agents.ps1
```

Pour cibler un workspace specifique :
```powershell
pwsh -ExecutionPolicy Bypass -File .\setup-collab\configurer-devin-agents.ps1 -TargetWorkspace "C:\chemin\vers\mon-projet"
```

---

## 3. Ce que le Script Realise Automatiquement

| Etape | Action realisee | Impact |
|---|---|---|
| 1. Environnement | Resolution relative des dossiers sans dependance de chemin fixe | Portabilite 100% |
| 2. Profils IDE | Creation de `.devin` et liaison cascade | Profils reconnus par Devin et Windsurf |
| 3. Provisioning ACP | Execution de `.agent/setup/setup-devin-acp.mjs` | Inscription des providers et PATHs dans `settings.json` |
| 4. Agent-Bridge | Deploiement de `.agent/agent-bridge/` et initialisation de `comms.jsonl` | Activation du protocole `/jointes` et handshake |
| 5. Diagnostic Reseau | Verification de l'accessibilite du bus WebSocket `127.0.0.1:7477` | Detection de l'extension monitor |

---

## 4. Verification Post-Installation

Apres execution, verifier les trois points suivants :
1. **Fichier de configuration Devin** : `%APPDATA%\devin\User\settings.json` doit comporter les sections `devin.acp.enabledAgents` et `devin.acp.agentEnv`.
2. **Pont d'agents** : Le dossier `.agent/agent-bridge/` du projet doit contenir `binome.js`, `acp-inject.js`, `agent-adapters.js`.
3. **Journal de communication** : Le fichier `.agent/comms.jsonl` doit etre present (meme vide au depart).

---

## 5. Depannage et Erreurs Frequentes

- **Port 7477 non detecte** : Normal si l'extension `orchestrator-monitor` n'est pas encore activee dans l'IDE. Demarrer l'IDE ou executer le binaire orchestrateur.
- **Node introuvable** : S'assurer que Node.js (v18+) est installe et present dans le `PATH` systeme.
- **Droits d'execution PowerShell** : Toujours utiliser le flag `-ExecutionPolicy Bypass`.
