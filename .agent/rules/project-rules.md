---
trigger: always_on
description: Reglas Obligatorias y Anti-Patrones — CLI-Anything
---
# Reglas Obligatorias del Proyecto (CLI-Anything)
Estas reglas han sido registradas en Obsidian Second Brain y son de OBLIGATORIO CUMPLIMIENTO en cada intervencion del agente en este workspace:
## Anti-Patrones y Trampas Prohibidas (Errores Recurrentes)
- **INTERDIT :** Interdiction de faire des sleep passifs dans PowerShell et interdiction de dispatcher des workers sans ping prealable via ping-models.mjs
- **INTERDIT :** Interdiction de faire des sleep passifs dans PowerShell et interdiction de dispatcher des workers sans ping prealable via ping-models.mjs

## 🔒 ORCHESTRATEUR HEPHAISTOS — PASSAGE OBLIGATOIRE (ordre utilisateur du 17/10/2026)

**INTERDICTION ABSOLUE de contourner l'orchestrateur Hephaistos et son MCP.**

- Toute délégation à un agent ou worker passe UNIQUEMENT par les outils MCP de l'orchestrateur : `dispatch_task` (avec `agent_name`, `provider`, `model` explicites), `create_task`, `update_task`, `list_tasks`, `get_next_task`.
- JAMAIS de worker/agent lancé en processus détaché hors orchestrateur (`nohup`, `spawn` direct, `Start-Process`, `&` bash) — un process invisible du dashboard est un worker sauvage : interdit.
- Supervision UNIQUEMENT par les canaux réactifs de l'architecture : `list_tasks`, `task_events`, WebSocket `127.0.0.1:7477`, `comms.jsonl`, named pipe `\.\pipe\hphe-index`. La vérité = l'état de l'orchestrateur.
- **INTERDIT de se référer aux processus Windows** (Get-Process, tasklist, PID) pour justifier l'état des workers — si le dashboard dit zéro, la réponse est zéro.
- JAMAIS de `sleep`/attente passive (PowerShell ou Bash).
- Toute panne de worker → tâche requalifiée via `update_task`, remontée Beacon, consignée dans le Second Cerveau Obsidian.

**SEULE EXCEPTION** : le hub de communication directe agent↔agent via les procédures **`/jointes`** et **`/chat-id`** (protocole binôme / agent-bridge), et uniquement quand l'utilisateur demande explicitement une connexion directe.

## ⚡ GOUVERNANCE MACHINE MODESTE & SÉCURITÉ RESSOURCES (17/10/2026)
- **Throttle CLI** : Maximum 2 workers CLI simultanés autorisés. Toute tâche au-delà est mise en file d'attente (pending).
- **Priorité Système** : Tous les workers CLI doivent s'exécuter sous la priorité `BELOW_NORMAL_PRIORITY_CLASS`.
- **Mutex ACP** : Interdiction absolue d'instancier des doublons de cascades dans l'IDE. Vérification obligatoire via `acquireAcpLock()` dans `agent-adapters.js`.

## 📦 POLITIQUE STRICTE DE DÉPLOIEMENT GIT (DOUBLE REMOTE PRIVATE)
- **Remotes Autorisés Exclusivement** :
  1. `origin` : Organisation projet provisoire (`https://github.com/projet-temporaire/...`)
  2. `personal` : Dépôt personnel de Boss (`https://github.com/lascard-m/...`)
- **Interdiction formelle** de pousser sur toute autre organisation ou tiers.
- **Confidentialité** : Tous les dépôts doivent obligatoirement rester en statut **PRIVATE**.
- **Audit de Sécurité** : Vérification systématique de l'absence de clés ou secrets dans le stage avant tout commit.
