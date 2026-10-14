# Étape 3 — Le ping-pong (le walkie-talkie Devin ↔ Antigravity)

> **Objectif** : faire que Devin et Antigravity se parlent en direct, sans passer par des messages copiés-collés à la main.

---

## 📻 C'est quoi le ping-pong ?

Imagine deux enfants avec des talkies-walkies. Chacun a sa fréquence (son ID de conversation). Quand l'un parle, l'autre entend **dans sa conversation**, pas ailleurs.

- **Devin** parle dans `acp/devin-cli/clumsy-cockroach` (ou ta session actuelle)
- **Antigravity** parle dans `db362c86-cdb8-4ec9-94f5-1abed85abc98` (ou sa session actuelle)

Le canal passe par :
- **Devin → Antigravity** : `agy-hub.js` → Connect-RPC → `SendUserCascadeMessage`
- **Antigravity → Devin** : `devin-hub.js` → WebSocket 7477 → `wake_devin` → focus + `explainAndFixProblem` → `session/prompt`

---

## 🚀 Lancer le ping-pong (3 étapes)

### Étape 1 — Devin publie son ID

Dans le projet (`C:\Program Files\Projet-complet\hephaistos2-kit`), tape :

```powershell
node .agent/agent-bridge/binome.js --as devin join
```

Ça écrit dans `.agent/comms.jsonl` : `"src":"devin","kind":"handshake"` avec ton `convId`.

### Étape 2 — Antigravity publie son ID

Idem, mais depuis le côté Antigravity (son terminal ou son agent) :

```powershell
node .agent/agent-bridge/binome.js --as agy join
```

### Étape 3 — On envoie un message test

Depuis Devin :

```powershell
node .agent/agent-bridge/binome.js --as devin send "coucou agy, tu me reçois ?"
```

Si tout marche, le message apparaît dans la conversation d'Antigravity.

Et depuis Antigravity :

```powershell
node .agent/agent-bridge/binome.js --as agy send "coucou devin, je t'entends"
```

Le message arrive ici.

---

## 🧪 Le script de test automatique

Dans `scripts/` :

```powershell
.\3-teste-le-ping-pong.ps1
```

Ça fait les deux `join` et envoie un message dans chaque sens. Tu vois tout se passer.

---

## 🔧 Si le ping-pong ne marche pas

| Problème | Pourquoi | Solution |
|---|---|---|
| `binome.js` ne trouve pas le bridge | Le port 7477 n'écoute pas | Lance `install-extension-hub.ps1 -CheckOnly` et reload l'extension |
| Le message n'arrive pas | Focus sur la mauvaise session | La 0.0.54 restaure le focus automatiquement — vérifie qu'elle est installée |
| `convId` absent | `join` pas lancé | Relance `binome.js --as <agent> join` |
| `wake-noroute` | Cible inconnue | Vérifie que les deux `join` ont bien écrit dans `.agent/comms.jsonl` |

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

- [ ] `binome.js --as devin join` a écrit un handshake
- [ ] `binome.js --as agy join` a écrit un handshake
- [ ] `binome.js --as devin send` arrive chez agy
- [ ] `binome.js --as agy send` arrive chez devin

→ **Passer à** `05-quand-ca-marche-pas.md` si besoin
