# Rapport 20 — Run SWAT d'analyse : bug parsing `devin-hub send`, `ping` global sur cascades ACP, corruption de chemin `fs_write` Bleubite, NIM 503

Date : 2026-10-27 · Auteur déclarant : Devin (`acp/devin-cli/quiet-comb`, orchestrateur du run) · Sévérité : **Haute** (pollution de conversations utilisateur) · Statut : **Partiellement corrigé — documenté**

Contexte : premier run du schéma `swat-orchestrateur` (`schema-yy5cfkox-i1t73`) piloté manuellement pour une mission d'analyse comparative (article « Second Brain » Karpathy vs architecture hephaistos2). Phase de rodage : chaque défaut observé est consigné ici.

## 0. Erreur de doctrine : dispatches vers les conversations de l'utilisateur — **SÉVÉRITÉ HAUTE**

Les sessions `acp/devin-cli/*` du roster (bloom-settee, trusted-robin,
sugary-shoemaker, ionian-helicopter, speckled-enthusiasm, spectacled-dust,
plain-bite…) sont les **conversations propres de l'utilisateur** sur d'autres
phases du projet — pas des Bleubites. Seuls les `chat-*` (fenêtres de
l'extension hephaistos) sont des workers.

Pollution réelle commise ce run :

- `bloom-settee` (conversation « Herald OS » de l'utilisateur) a reçu le prompt
  complet de la mission #735 — l'artefact produit est bon mais la conversation
  de l'utilisateur est polluée.
- `trusted-robin` a reçu un `PING : réponds uniquement PONG` (le `ping --write`
  global, §2) avec switch de focus UI.
- `polished-lipstick` (= la cascade de l'orchestrateur elle-même) a reçu le
  texte parasite « bloom-settee » (bug §1).

**Règle définitive** : dans le schéma `swat-orchestrateur`, le SEUL nœud
`acp/devin-cli` à considérer est l'entrée = l'agent orchestrateur en cours.
Tous les hops de travail vont aux `chat-*`. Ne jamais `devin-hub send` ni
`sendToAcpAgent` ni `ping` vers une session `devin-cli` tierce sans demande
explicite — ce sont des fenêtres de l'utilisateur, pas des exécutants.

**Défaut du schéma à arbitrer par l'utilisateur** : les nœuds « Architecte »
(`bloom-settee`) et « Integrateur-Git » (`sugary-shoemaker`) du schéma actif
sont liés à des conversations utilisateur. Toute mission dispatchée à ces
nœuds pollue ses conversations. Soit les re-pointer vers des fenêtres
dédiées, soit les marquer non-dispatchables.

## 1. `devin-hub.js send` — filtre `--as` avale le texte quand le flag est absent — **CORRIGÉ**

### Reproduction

```
node devin-hub.js send "<prompt>" acp/devin-cli/bloom-settee
→ {"status":"sent","cascadeId":"acp/devin-cli/polished-lipstick","text":"bloom-settee"}
```

### Cause racine

```js
const asIdx = args.indexOf('--as');           // -1 quand absent
const pos = args.filter((a,i) => i !== asIdx && i !== asIdx + 1);
// asIdx === -1 → asIdx+1 === 0 → args[0] (le TEXTE) est filtré.
// pos[0] devient le cascadeId ; cascadeId=null → getActiveCascade().
```

Conséquence : le texte « bloom-settee » a été injecté comme message dans la cascade **active** (fenêtre de l'utilisateur), le prompt complet perdu silencieusement — `status:"sent"` alors que le contenu envoyé était faux. Un agent qui déclare ne prouve rien : seul le contenu de la réponse a trahi l'erreur.

### Correctif appliqué

```js
const pos = asIdx === -1 ? args : args.filter((a, i) => i !== asIdx && i !== asIdx + 1);
```

## 2. `workspace-roster.js ping` sans `--only` — réveille TOUTES les cascades ACP — **DOCUMENTÉ**

`ping` itère sur **toutes** les entrées du roster : les fenêtres `chat-*` (Bleubites, transport `acp-inject`) **et** les sessions `acp/devin-cli/*` (transport `wake_acp_agent` via `sendToAcpAgent`). Hors `devin-cli`, un ping = `openCascadeIdInChatPanel` + submit `PING : réponds uniquement PONG` → **switch de focus UI + prompt injecté dans la session**.

Observé dans `comms.jsonl` : `wake-acp-focus bloom-settee -> trusted-robin` à 15:32 — `trusted-robin` est une cascade Devin, **pas un Bleubite**, et `bloom-settee` était **en plein tour** sur la tâche #735. Le ping peut intercaler un tour parasite dans un agent occupé.

### Règles d'usage retenues

- `ping` se cible : `workspace-roster.js ping --only <sessionId[,…]>` — jamais à blanc.
- Ne jamais pinguer une cascade `devin-cli` en cours de mission (elle répond au PING au milieu de son travail).
- `skipped-self` ne protège que la session courante — pas les autres agents occupés.

### Piste de durcissement (non implémentée)

Ajouter au `ping` un filtre par `group` (défaut : `bleubites` uniquement) ou un garde « status = busy » avant `sendToAcpAgent`. À arbitrer : la liste des entrées pingées devrait refléter le schéma actif, pas tout le roster.

## 3. `fs_write` Bleubite : backslashes doublés → écriture hors workspace — **DOCUMENTÉ**

`chat-mvmtldvy` (provider `nim`) a reçu un chemin avec backslashes dans le prompt injecté. Son `fs_write_text_file` a reçu `C:\\\\Program Files\\…` (backslashes doublés par le modèle), a rapporté « ok » — et a en fait créé `C:\audit-securite-2026-10-27.md` **0 octet**, hors workspace. Fichier fantôme supprimé, contenu récupéré depuis la reply du tour et réécrit par l'orchestrateur au bon chemin.

### Règle d'usage

Dans les prompts injectés aux Bleubites : **chemins absolus en forward slashes** (`C:/Program Files/…`) ou backslash simple — jamais doubles. Demander au worker une relecture `fs_read` de vérification post-écriture. La skill `bleubite-dispatch` exige déjà le chemin absolu ; la corruption par doublement des séparateurs est le cas précis où « ok » ne prouve rien.

## 4. NIM `ResourceExhausted 16/16` — **DOCUMENTÉ**

Retry-2 sur `chat-mvmtldvy` → `NVIDIA NIM HTTP 503 … Worker local total request limit reached (16/16)`. Pool local saturé (probablement les PING parallèles du `ping --write` précédent + fenêtres actives). Pas de boucle de retry : événement `blocked` écrit dans `comms.jsonl`, artefact du tour précédent récupéré.

## 5. Réponse hors-sujet d'un Bleubite — **DOCUMENTÉ**

Premier tour de `chat-mvmtldvy` : artefact écrit mais contenu d'une autre mission (réponse « migration SQLite » sans rapport avec le prompt). Hypothèse : résidu de contexte de la session persistée. Le retry avec prompt resserré a produit un audit correct. Règle : **vérifier le contenu de l'artefact, pas seulement son existence**.

## 6. Incohérence de statut roster — **À INVESTIGUER**

`status` rapporte tous les `chat-*` en `acp-missing` et `restore` répond `no-restore-path`, pourtant `acp-inject --provider hephaistos` livre et reçoit `end_turn` + tool calls réels. Le statut `acp-missing` reflète la liste ACP du provider, pas la disponibilité réelle de la session de l'extension — sémantique trompeuse (on pourrait écarter un agent utilisable).

## 7. Watchdog `mcp_config_drift` — **À INVESTIGUER**

Événement `[WATCHDOG] code=mcp_config_drift` émis à 15:32 pendant le run. Non corrélé à une action directe ; à contrôler (dérive possible de `mcp_config.json` — régression connue du 2026-10-22 sur les env vars sqlite-node).

## Chronologie bus (extraits `comms.jsonl`)

```
15:25:30  prompt "bloom-settee" → polished-lipstick   ✗ (bug §1)
15:25:58  prompt #735 → bloom-settee                   ✓ (après fix)
15:26:04  wake-acp-submitted → bloom-settee            ✓
15:30:36  blocked chat-mvmtldvy : NIM 503              (§4)
15:32:17  [WATCHDOG] mcp_config_drift                  (§7)
15:32:30  wake-acp-focus bloom-settee -> trusted-robin ✗ (§2, ping global)
15:32:35  wake-acp-submitted → trusted-robin           ✗ (§2)
```

## Leçons de rodage

1. Un `sent`/`delivered` n'est jamais une preuve — preuve = artefact sur disque **au bon chemin** + contenu vérifié.
2. `ping --write` global = arme de focus massif ; toujours `--only`.
3. Chemins Bleubites : slashes simples + relecture de vérification.
4. `acp-missing` ne veut pas dire injoignable — tester la livraison réelle avant de déclarer un agent mort.
