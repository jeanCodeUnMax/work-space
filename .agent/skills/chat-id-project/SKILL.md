---
name: chat-id-project
description: Affiche l'identifiant exact de la session active Antigravity (AGY) ou ACP focalisée, sans la joindre ni lui envoyer de message (skill workspace).
triggers:
  - user
  - model
---

# `/chat-id-project` (skill workspace; commande globale canonique : `/chat-id`)

Cette commande est en lecture seule. Résoudre le helper avant usage (copie injectée du workspace, sinon canonique du kit) :

```bash
BRIDGE=".agent/agent-bridge"
[ -f "$BRIDGE/chat-id.js" ] || BRIDGE="C:/Program Files/Projet-complet/hephaistos2-kit/.agent/agent-bridge"
[ -f "$BRIDGE/chat-id.js" ] || { echo "REFUS: chat-id.js introuvable"; exit 1; }
```

Dans ce workspace, exécuter :

```text
node "$BRIDGE/chat-id.js" --agent agy --via hub
```

Retourner le `sessionId` (ou `cascadeId`) exactement comme affiché pour permettre la copie manuelle. Ne jamais envoyer de message, ne pas réveiller ni joindre la session. Si ce helper n'est pas disponible, utiliser `node "$BRIDGE/agy-hub.js" current` ; ne jamais lancer `agy-hub.js discover`, ne jamais exposer de jeton CSRF et ne jamais choisir un identifiant dans l'historique par seule récence.
