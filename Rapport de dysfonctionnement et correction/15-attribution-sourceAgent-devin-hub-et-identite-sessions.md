# Rapport 15 — Attribution mensongère `sourceAgent='agy'` dans devin-hub + confusion d'identité entre sessions

Date : 2026-10-20. Enquête : Cash (`acp/devin-cli/quiet-comb`), ordre Boss.

## Faits

- Sur `F:/doc_Obsidian/Doc/.agent/comms.jsonl`, des envois faits par Cash vers les sessions ACP coéquipières (`scrawny-thorn`, `morning-riverbed`, `equal-level`, `maple-lizard`) via `node devin-hub.js send "<msg>" <cascadeId>` ont tous été journalisés **`agy→devin`** au lieu de `devin→<cible>`.
- Cause racine : `devin-hub.js` ligne ~104 — `sendToDevin(text, cascadeId, port = 7477, sourceAgent = 'agy')`. Tout appelant ne passant pas le 4e argument (CLI `send`, orchestrateur) signe `agy` par défaut. `binome.js` passait déjà `me` correctement — le défaut ne frappait que les chemins non-binôme.
- Conséquence : lecture du bus = messages attribués à Tango alors qu'ils venaient de Cash ; sessions coéquipières incapables de savoir qui parlait. Le Boss a qualifié les sessions de « schizophréniques » — le bus mentait.
- Incident associé (constat, pas bug) : `wakeDevin` (extension.js) n'injecte que si `acp.focusedSessionId === target` ; la ligne `wake-acp-focus: A -> B` du bus = *focus avant → focus après* (livraison correcte), pas une erreur de routage. Effet de bord assumé : `vscode.open` vole l'onglet focalisé de l'observateur.
- Incident disciplinaire : un agent a annoncé sur le bus « inventaire terminé (33 plugins) » trois fois alors que `INVENTAIRE_outils_plugins.md` faisait 0 octet — repris par la règle « preuve par le disque ».

## Corrections appliquées

- `devin-hub.js` : `sourceAgent` défaut → `process.env.HEPHAISTOS_AGENT || 'devin-hub'` ; CLI `send` accepte `--as <agent>`. `node --check` vert. Patch appliqué aux **deux** copies tenues à l'identique : kit canonique (`hephaistos2-kit/.agent/agent-bridge/`) et workspace (`F:\doc_Obsidian\Doc\.agent\agent-bridge\`).
- Protocole PING/PONG canonique rédigé : `docs/protocole-binome/README.md` §9 (résolution d'identité par `chat-id.js`, `PING`/`PONG` sur `comms.jsonl`, noms fixes Tango=agy, roster `EQUIPE.md`, `acp-list` comme inventaire des sessions, signature des livrables).
- Miroir équipe : `99_Labo/EQUIPE.md` §2 dans le vault.

## Leçons (reprises dans le protocole)

1. Un paramètre par défaut qui désigne un agent réel est un mensonge en attente. Défauts honnêtes : nom du composant (`devin-hub`) ou `unknown`, jamais un agent nommé.
2. Toute annonce « terminé » cite un artefact : chemin + taille sur disque. Sinon = non fait.
3. `acp-list` filtré `userMessageCount > 0` = seul inventaire fiable des sessions joinables ; les brouillons 0-message n'existent pas pour l'équipe.
4. `HEPHAISTOS_AGENT` devient la variable d'identité canonique à exporter par tout script de pont.

## Copie

Ce rapport est dupliqué dans `F:\doc_Obsidian\Doc\Rapport de dysfonctionnement et correction\` (convention vault) et référencé dans `docs/protocole-binome/README.md` §9.

## Addendum 16:10Z — double-log bus + discipline hub

- Second dysfonctionnement observé : chaque `binome.js send` produisait **deux** entrées `comms.jsonl` (~1 ms d'écart) — `binome.js` loggue le prompt ET `agy-hub.js:183` le re-loggue. Corrigé par dedup dans `comms.js` (entrées identiques `{src,dst,kind,text}` à <2 s ignorées, handshakes exclus). Vérifié : envoi suivant apparaît 1×.
- Discipline hub pour `agy` (Tango) gravée dans `docs/protocole-binome/README.md` §10 : réponse = `comms.js log reply`, jamais de `wake_agy`/nouvelle cascade pour répondre, conversation fixe 721750ab, `tail` avant d'agir, un ping/un pong/silence.
- Copie `comms.js` synchronisée kit ↔ vault (identiques).

## Addendum 18:20Z — livraison ACP à la mauvaise fenêtre (root cause trouvée)

- Le message destiné à `acp/devin-cli/morning-riverbed` est arrivé dans le chat `quiet-comb` : `wakeDevin`/`wakeAcpAgent` focalisaient la cible via `vscode.open` sur `vscode-cascade-editor:///cascade-<id>` (onglet ACP) puis soumettaient `explainAndFixProblem` — qui livre dans le **panneau chat Devin**, surface distincte dont la conv active n'était pas la cible.
- Correctif `extension.ts` (2 blocs) : `openCascadeIdInChatPanel` en premier — ouvre la session cible DANS le panneau chat où la soumission arrive réellement ; `vscode.open` relégué en fallback. `tsc` vert, `out/extension.js` redéployé sur les 3 emplacements (kit, `.devin`, `.cursor`). **Rechargement de l'hôte d'extension requis** pour prise d'effet.
- `acp-inject.js` ne couvre pas `devin-cli` (providers injectables : opencode, hermes, kilo…) — pour les sessions ACP de l'IDE, le wake focusé reste le seul canal ; désormais il cible le bon panneau.

## Addendum 18:45Z — un seul tunnel : le démon ws-bridge 7477

- Violation d'architecture : `binome.js sendToPeer` (branche `hub`) appelait `agy-hub.js` en **Connect-RPC direct** vers agy.exe — contournement du démon : pas de routage central, pas de `replyToCascadeId` (les réponses d'agy n'étaient jamais relayées dans la conv de l'expéditeur → ouvertures de fenêtres parasites côté Antigravity), logs divergents.
- Correctif : `devin-hub.js` gagne `sendToAntigravity(text, agyCascadeId, replyToCascadeId)` qui émet `wake_antigravity` sur 7477 ; `binome.js` branche `hub` passe désormais par ce tunnel avec `replyToCascadeId` = session émettrice (l'extension relaie la réponse AGY dans la conv Devin de l'expéditeur). Fallback RPC direct conservé uniquement pour `ask` si le démon est down.
- **Règle gravée** : tout message inter-agents passe par `ws://127.0.0.1:7477` (orchestrator-monitor). Les transports (devin chat, agy hub, acp-inject, CLI) sont des *sorties* du démon, jamais des canaux parallèles directs. Test : message tunnel envoyé `sent:true`, bus = 1 entrée (dedup OK).
