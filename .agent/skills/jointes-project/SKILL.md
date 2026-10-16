---
name: jointes-project
description: Établit un binôme vérifié entre Antigravity (AGY) et une session Devin, ACP ou CLI, sans fallback de transport (skill workspace).
argument-hint: "<agent>"
triggers:
  - user
---

# `/jointes-project <agent>` (skill workspace; commande globale canonique : `/jointes`)

Appliquer `docs/protocole-binome/README.md` (copie injectée : `.agent/docs/protocole-binome/README.md`, sinon `$HEPHAISTOS_KIT/docs/protocole-binome/README.md`). Dans Antigravity, utiliser impérativement l'identité AGY réelle (`--as agy --via hub`) ; ne jamais simuler Devin ni un autre pair.

Résoudre le helper avant usage :

```bash
BRIDGE=".agent/agent-bridge"
if [ ! -f "$BRIDGE/binome.js" ] && [ -n "$HEPHAISTOS_KIT" ]; then BRIDGE="$HEPHAISTOS_KIT/.agent/agent-bridge"; fi
[ -f "$BRIDGE/binome.js" ] || { echo "REFUS: agent-bridge introuvable (definir HEPHAISTOS_KIT)"; exit 1; }
```

1. Identifier l'identifiant exact de la session AGY avec :
   `node "$BRIDGE/chat-id.js" --agent agy --via hub`
2. Résoudre le pair et le transport demandés. Exiger un ID de session exact ; demander à l'utilisateur de choisir en cas d'ambiguïté d'agent, de transport ou de session.
3. Envoyer une seule requête ciblée avec l'identité réelle AGY :
   `node "$BRIDGE/binome.js" --as agy --via hub --self <agySessionId> --peer <agent> --peer-via <transport> --to <peerSessionId> --session binome join`
4. N'annoncer le succès du pairage qu'après réception d'un ACK réciproque frais du pair réel et lorsque le vérificateur indique `established: true` avec `pairId`, `session`, IDs, transports, providers et horodatages correspondants (< 15 min).

Ne jamais simuler un autre agent, ne jamais router vers une session déduite ou la plus récente, ne pas créer de conversation de remplacement, et ne jamais utiliser `agy-hub.js discover`. Ne révéler aucun jeton CSRF ni secret.
