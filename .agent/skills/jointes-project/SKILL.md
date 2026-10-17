---
name: jointes-project
description: "Établit un binôme vérifié entre Antigravity (AGY) et un agent pair explicitement désigné (OpenCode, Devin, Hermes, Kilo) via le protocole binôme Hephaistos. Utilise STRICTEMENT la cible retournée par l'utilisateur (ou /chat-id) sans aucun fallback automatique vers Devin."
argument-hint: "<agent> [bloc de session /chat-id]"
triggers:
  - user
---

# `/jointes` & `/jointes-project` — Protocole Binôme et Appariement Inter-Agents

> Ce skill assure l'appariement bidirectionnel strict entre Antigravity (`agy` via `hub`) et un agent pair (`opencode`, `devin`, `hermes`, `kilo`) sans confusion de session, sans auto-ciblage et SANS jamais tenter de connecter Devin par défaut si une autre cible est spécifiée.

## 1. Règle Fondamentale : Utilisation Stricte de la Cible Fournie par l'Utilisateur

Quand l'utilisateur invoque `/jointes` ou fournit les métadonnées de session (générées par `/chat-id` ou renseignées manuellement), par exemple :
```
sessionId: acp/opencode/ses_eb65d7bf0ffeI3Ym2UE5SjN9CR
providerId: opencode
transport: acp
```
L'assistant DOIT OBLIGATOIREMENT :
1. **Extraire les coordonnées cibles :**
   - **`PEER`** : `agent` ou `providerId` du bloc (ex : `opencode`).
   - **`PEER_VIA`** : `transport` du bloc (ex : `acp`).
   - **`PEER_SESSION_ID`** : `sessionId` du bloc (ex : `acp/opencode/ses_eb65d7bf0ffeI3Ym2UE5SjN9CR`).
2. **Identifier la session locale AGY :**
   - **`SELF_SESSION_ID`** : obtenu via `node .agent/agent-bridge/chat-id.js --agent agy --via hub`.
3. **INTERDICTION DU BLIND FALLBACK VERS DEVIN :**
   - Ne JAMAIS exécuter `binome.js pair` ou `binome.js join` sans spécifier explicitement `--peer <PEER> --peer-via <PEER_VIA> --to <PEER_SESSION_ID>`.
   - Si la cible est `opencode`, la commande DOIT cibler `opencode`, JAMAIS `devin`.
   - Ne JAMAIS s'envoyer la demande à soi-même (`--to` ne doit JAMAIS égaler `--self`).

---

## 2. Procédure d'Exécution Exacte

### Étape 1 : Résolution de la session AGY locale
```powershell
node .agent/agent-bridge/chat-id.js --agent agy --via hub
```
Exemple de retour : `"a4e18ca7-8d53-44b4-883d-8e480f41553a"`.

### Étape 2 : Émission du Handshake de Join vers le Pair Exact
```powershell
node .agent/agent-bridge/binome.js --as agy --via hub --self <SELF_SESSION_ID> --peer <PEER> --peer-via <PEER_VIA> --to <PEER_SESSION_ID> --session binome join
```
*Exemple concret avec OpenCode :*
```powershell
node .agent/agent-bridge/binome.js --as agy --via hub --self a4e18ca7-8d53-44b4-883d-8e480f41553a --peer opencode --peer-via acp --to acp/opencode/ses_eb65d7bf0ffeI3Ym2UE5SjN9CR --session binome join
```

### Étape 3 : Vérification de l'État du Binôme avec la Cible Exacte
```powershell
node .agent/agent-bridge/binome.js --as agy --via hub --self <SELF_SESSION_ID> --peer <PEER> --peer-via <PEER_VIA> --to <PEER_SESSION_ID> --session binome pair
```
*Vérifier que le JSON retourné contient :*
- `"peer": "<PEER>"` (ex. `opencode`, et non `devin`)
- `"peerCascade": "<PEER_SESSION_ID>"`
- `"established": true` (ou `hint: "en attente d'un ACK"`)

### Étape 4 : Envoi de Directives ou Messages au Pair
```powershell
node .agent/agent-bridge/binome.js --as agy --via hub --self <SELF_SESSION_ID> --peer <PEER> --peer-via <PEER_VIA> --to <PEER_SESSION_ID> send "Consigne..."
```
Ou via injection directe ACP :
```powershell
node .agent/agent-bridge/acp-inject.js --provider <PEER> --session <PEER_SESSION_ID> --prompt "Consigne..."
```

---

## 3. Anti-Patrons Stricts
- **INTERDIT :** Exécuter `node binome.js pair` sans arguments qui retombe silencieusement sur `--peer devin`.
- **INTERDIT :** Tenter de connecter Devin quand l'utilisateur fournit les identifiants d'OpenCode, d'Hermes ou de Kilo.
- **INTERDIT :** Ignorer le bloc retourné par `/chat-id` fourni en invite de commande.
