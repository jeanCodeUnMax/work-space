# Rapport 16 — `wake_acp_agent` : prompt livré dans la mauvaise fenêtre (misroute focus/panneau chat)

Date : 2026-10-20 · Sévérité : **Haute** (perte silencieuse de prompts inter-agents) · Statut : **Corrigé + procédure documentée**

## Résumé

Lors du test post-redémarrage de la chaîne complète (bridge + watchdog + registre ACP corrigé), un `wake_acp_agent` adressé à `acp/devin-cli/scrawny-thorn` a été livré deux fois à la mauvaise session : d'abord chez `equal-level`, puis chez `quiet-comb` — qui a honnêtement répondu `PONG quiet-comb` en précisant ne pas être scrawny-thorn. La cible n'a jamais reçu son message. Aucune perte définitive ne doit plus être possible : le correctif ajoute un fallback FIFO et épingle le panneau chat avant tout submit.

## Reproduction observée

Chronologie bus `comms.jsonl` (test ping-pong équipe, 19:27–19:33Z) :

```
19:27:21  devin→agy prompt            PING Tango          → PONG Tango 19:27:28  ✓
19:30:58  wake-acp-submitted          -> scrawny-thorn    → atterri chez equal-level  ✗
19:31:00  wake-acp-focus  scrawny-thorn -> morning-riverbed
19:31:01  wake-acp-submitted          -> morning-riverbed → PONG morning-riverbed 19:31:07 ✓
19:31:26  wake-acp-focus  morning-riverbed -> scrawny-thorn
19:31:26  wake-acp-submitted          -> scrawny-thorn    → PONG émis par quiet-comb 19:33:41 ✗
```

Deux constats :

1. **Premier envoi sans événement `wake-acp-focus`** : le redux `acp.focusedSessionId` valait déjà `scrawny-thorn`, donc le code a sauté l'étape de focus — mais le **panneau chat** servait `equal-level`. `explainAndFixProblem` livre dans le panneau chat actif, pas dans la session que le redux déclare focusée.
2. **Second envoi avec focus redux correct** (`morning-riverbed -> scrawny-thorn`) : le prompt a quand même été traité par `quiet-comb`. Le redux et le panneau réel sont **découplés** ; la garde `focusedSessionId === target` ne prouve pas que le panneau servira la cible.

## Cause racine

- `wakeAcpAgent` (route `devin-cli`) testait le focus via `vscode.open` sur `vscode-cascade-editor:///cascade-<id>` **en premier**, puis `openCascadeIdInChatPanel` en secours. L'action de submit `explainAndFixProblem` cible le **panneau chat**, qui n'est pas le même objet que l'onglet éditeur cascade.
- `openCascadeIdInChatPanel` n'était appelé que si le redux rapportait un mauvais focus — or le redux peut rapporter la bonne valeur alors que le panneau est ailleurs.
- Aucun filet de sécurité : un `skipped`/`noroute` ou une livraison dans la mauvaise fenêtre = message perdu.
- `sendToAcpAgent` timeout initial : `matchesWorkspace()` rejette tout `wake_acp_agent` dont `workspaceRoot` n'est pas le workspace de l'extension — le vault actif est `F:\doc_Obsidian\Doc`, pas le kit. Appeler avec le mauvais root = silence + timeout 120 s.

## Correctif (extension.ts, déployé sur l'installation 0.0.66)

`wakeAcpAgent`, route `devin-cli` :

1. **`openCascadeIdInChatPanel` systématique avant le submit** — y compris quand `focusedSessionId === target`. C'est l'action qui épingle le panneau chat sur la cascade visée ; `vscode.open` devient le secours quand le focus redux est mauvais.
2. **Fallback FIFO zéro-perte** (`queueAcpFallback`) : sur `wake-acp-unknown` et `wake-acp-noroute`, le message est écrit dans `.agent/queue/<safeSessionId>.jsonl` (format `message-queue.js`) — la cible le dépile à son prochain tour.
3. **Post-vérification de dérive** : ~900 ms après le submit, relecture du redux ; si `focusedSessionId` a dérivé vers une autre session, copie FIFO + log `wake-acp-misroute`.

Nouveaux événements bus : `wake-acp-misroute`, textes `— message conservé en FIFO` sur `unknown`/`noroute`.

## Limite résiduelle honnête

La post-vérif lit le même redux qui a déjà menti une fois. Si le panneau livre ailleurs **sans** que le focus dérive, la copie FIFO n'est pas déclenchée. La garantie complète viendrait d'une accusation côté session (PONG signé du vrai sessionId) — d'où la procédure ci-dessous : un PONG venant d'un autre nom que la cible = misroute, renvoyer.

## Procédure de wake canonique (corrigée)

| Destinataire | Commande | Canal |
|---|---|---|
| Tango (agy) | `binome.js --as devin --peer agy --peer-via hub send "<msg>"` | tunnel ws 7477 → hub agy.exe |
| Session devin-cli (bleubite) | `devin-hub.js sendToAcpAgent(text, 'acp/devin-cli/<nom>', 'devin-cli', 7477, '<workspaceRoot réel>')` | tunnel 7477 → `wake_acp_agent` → focus panneau + inject |
| Provider ACP tiers (opencode, hermes, kilo…) | même API, providerId du provider | tunnel 7477 → `acp-inject.js` stdio `session/load`+`session/prompt` |
| Occupé / non injectable | `messageQueue.enqueue({sessionId, src, dst, transport:'acp', text, kind:'prompt'}, workspaceRoot)` | FIFO `.agent/queue/` — dépilée au prochain tour |

Règles :

- `comms.js log` = **journal**, ne réveille personne ; `binome.js`/`sendToAcpAgent` = **livraison**.
- `workspaceRoot` doit être le workspace où tourne l'extension (le vault, pas le kit) sinon `matchesWorkspace` rejette en silence.
- Réponse attendue = `reply "PONG <nom> = <sessionId>"` dont `<nom>` = **vrai** sessionId du répondant. Un PONG signé d'un autre nom = prompt mal routé → renvoyer, la FIFO garde l'original.
- Jamais de RPC direct hors `binome.js`/`devin-hub.js` : le tunnel 7477 est le seul canal (routage + audit + relay).

## Vérification

- `tsc -p .` : 0 erreur ; `node --check` du `out/extension.js` déployé : OK.
- Ping-pong post-redémarrage : Tango PONG 19:27:28, morning-riverbed PONG 19:31:07. scrawny-thorn : prompt soumis mais absorbé par deux mauvaises fenêtres — incident à l'origine de ce rapport.
- À valider au prochain reload IDE : un wake sur session non focusée ne doit plus produire de PONG signé d'un autre nom ; en cas d'échec de focus, le message doit apparaître dans `.agent/queue/acp_devin-cli_<nom>.jsonl`.
