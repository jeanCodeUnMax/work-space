# Étape 3 — Le ping-pong (le walkie-talkie Devin ↔ Antigravity)

> **Objectif** : faire que Devin et Antigravity se parlent en direct, sans passer par des messages copiés-collés à la main.

---

## 📻 C'est quoi le ping-pong ?

Imagine deux enfants avec des talkies-walkies. Chacun a sa fréquence (son ID de conversation). Quand l'un parle, l'autre entend **dans sa conversation**, pas ailleurs.

- **Devin** parle dans la session `acp/devin-cli/<slug>` courante (ID relevé dynamiquement)
- **Antigravity** parle dans la conversation sélectionnée dans son hub local (ID confirmé avant le join)

Les exemples d’IDs ne sont jamais à copier d’une ancienne session : un identifiant est éphémère.

Le canal passe par :
- **Devin → Antigravity** : `agy-hub.js` → Connect-RPC → `SendUserCascadeMessage`
- **Antigravity → Devin** : `devin-hub.js` → WebSocket 7477 → `wake_devin` → focus + `explainAndFixProblem` → `session/prompt`

---

## Lancer un binôme vérifié

### Étape 1 — Confirmer les deux sessions

Depuis Devin, vérifie l’ID de la session courante :

```powershell
node .agent/agent-bridge/current-cascade.js
```

Choisis la conversation AGY explicitement avec `agy-hub.js list` puis `current`. S’il y en a plusieurs et que la cible n’est pas certaine, arrête-toi et demande laquelle utiliser. N’utilise pas `agy-hub.js discover` : il affiche le jeton CSRF local.

### Étape 2 — Devin lance `/jointes AGY`

Dans Devin, lance :

```text
/jointes AGY
```

La compétence Devin demande ensuite à la session AGY confirmée d’exécuter son propre handshake avec son ID `--self`. Ne lance pas `binome.js --as agy` depuis Devin : cela simulerait AGY.

### Étape 3 — Vérifier, puis tester l’envoi si souhaité

`/jointes AGY` doit confirmer un ACK frais. Pour vérifier en lecture seule :

```powershell
$devinCascadeId = node .agent/agent-bridge/current-cascade.js
node .agent/agent-bridge/binome.js --as devin --self $devinCascadeId pair
```

Il faut `established: true`, un `pairId` commun et les IDs Devin/AGY exacts. Les requêtes/ACK expirent après 15 minutes.

Ensuite seulement, si tu veux envoyer un test explicite :

```powershell
$agyCascadeId = 'REMPLACER_PAR_LE_CASCADE_ID_EXACT_CHOISI_DANS_AGY_LIST'
$geminiModel = 'Gemini 3.8 Flash (Medium)' # modèle sélectionné dans Gemini; ne pas choisir Argon
node .agent/agent-bridge/binome.js --as devin --via acp --self $devinCascadeId --peer agy --peer-via hub --to $agyCascadeId --session binome --model $geminiModel send "coucou AGY, test du binôme"
```

Sans paire fraîche, `send` échoue. Il ne retombe jamais sur le chat actuellement actif et ne crée aucune conversation de remplacement.

### Autres agents activés

```text
/jointes KiloCode
/jointes Hermes
/jointes NVIDIA NIM
/jointes NVIDIA NIM #2
/jointes OpenRouter
/jointes Devin Cloud
/jointes Mistral Vibe
/jointes OpenCode
```

KiloCode et Hermes peuvent proposer deux transports distincts : session ACP ouverte dans Devin ou session CLI reprise par ID. Si les deux sont disponibles, choisis le mode; si plusieurs sessions existent, choisis l’ID exact. Les autres noms ACP ne sont joignables que si `devin-hub.js acp-list <providerId>` retourne une session existante. Les workers HES `nim1`/`nim2` restent des appels API one-shot, différents des sessions ACP Devin `nim`/`nim2`. `Devin Local` ne peut pas se joindre lui-même. Aucune option/provider ne sera activée automatiquement.

L'extension `orchestrator-monitor` 0.0.58+ fournit l'inventaire ACP **et** l'injection réelle : pour les providers mappés (opencode, antigravity-acp, mistral-vibe, hermes, kilo), le message part en ACP stdio direct vers le processus provider (`session/load` + `session/prompt` sur l'ID exact). Un provider non mappé retourne `skipped`; ne le remplace pas par le chat Devin ni par le transport CLI. Pour AGY hub, passe le modèle exact sélectionné dans Gemini via `--model`; il est résolu vers le token interne du hub et aucun Argon n'est choisi par défaut.

---

## 🧪 Le script de test automatique

Dans `scripts/` :

```powershell
.\3-teste-le-ping-pong.ps1
```

Ce script est un contrôle **en lecture seule** : il vérifie qu’un pair frais est déjà établi. Il ne simule pas AGY, ne lance pas de `join` et n’envoie aucun message.

---

## 🔧 Si le ping-pong ne marche pas

| Problème | Pourquoi | Solution |
|---|---|---|
| `established: false` | ACK absent, `pairId/session` différents ou pair expiré | Relance `/jointes AGY` avec les IDs vérifiés; ne réutilise pas un ancien handshake |
| `send` refuse la cible | Aucun pair frais ou la session locale a changé | Refaire `/jointes AGY`; `send` ne retombe pas sur un chat actif |
| `binome.js` ne trouve pas le bridge | Le port 7477 n'écoute pas | Lance `install-extension-hub.ps1 -CheckOnly` et vérifie le monitor |
| `wake-noroute` / `skipped` | Session ACP inconnue ou impossible à focaliser | Confirme l'ID Devin `acp/devin-cli/...`; ne crée pas de conversation de remplacement |

---

## 📁 Les fichiers du canal

| Fichier | Rôle |
|---|---|
| `.agent/agent-bridge/binome.js` | La CLI du canal (`join`, `send`, `pair`, `tail`) |
| `.agent/agent-bridge/agy-hub.js` | Parle à Antigravity via Connect-RPC |
| `.agent/agent-bridge/devin-hub.js` | Parle à Devin via WebSocket 7477 |
| `.agent/agent-bridge/comms.js` | Écrit/lit `.agent/comms.jsonl` |
| `.agent/comms.jsonl` | Le journal des messages (comme un log) |

---

## ✅ Récapitulatif

- [ ] `/jointes AGY` a obtenu un ACK frais avec le même `pairId/session`
- [ ] `pair` affiche `established: true` avec les IDs Devin et AGY attendus
- [ ] `send` n’est utilisé qu’après ce contrôle et cible le pair vérifié

→ **Passer à** `05-quand-ca-marche-pas.md` si besoin
