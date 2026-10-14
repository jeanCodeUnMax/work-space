# Etape 3 — Le ping-pong (le talkie-walkie Devin <-> Antigravity)

> **Objectif** : faire communiquer Devin et Antigravity en direct, sans devoir copier-coller du texte a la main entre deux fenetres.

---

## Comment fonctionne le talkie-walkie ?

Imagine deux personnes avec des appareils radio. Pour s'entendre, chacune doit se caler sur la bonne frequence et dire qui elle est :

1. **Devin** s'annonce et donne son numero de session.
2. **Antigravity** fait la meme chose de son cote.
3. Quand l'un parle, le message s'affiche directement dans la conversation active de l'autre, sans creer de nouvel onglet ni faire sonner d'alerte parasite.

Le chemin emprunte :
- **De Devin vers Antigravity** : un tuyau reseau rapide (Connect-RPC) depose le texte directement dans la session d'Antigravity.
- **D'Antigravity vers Devin** : la commande transite par la ligne interne (port 7477). L'extension remet en avant le bon onglet de discussion et insere le message comme une reponse utilisateur.

---

## Les 3 etapes pour tester la liaison

### Etape 1 — Devin annonce son identifiant

Dans une fenetre PowerShell a la racine du projet (`C:\Program Files\Projet-complet\hephaistos2-kit`) :

```powershell
node .agent/agent-bridge/binome.js --as devin join
```

Cela enregistre la session de Devin dans le carnet de bord (`.agent/comms.jsonl`).

### Etape 2 — Antigravity annonce son identifiant

Depuis le terminal d'Antigravity :

```powershell
node .agent/agent-bridge/binome.js --as agy join
```

Les deux assistants se connaissent desormais.

### Etape 3 — Envoi d'un message test

Pour envoyer un message depuis Devin vers Antigravity :

```powershell
node .agent/agent-bridge/binome.js --as devin send "coucou agy, transmission validee"
```

Le texte arrive directement dans la session live d'Antigravity.

Et pour repondre depuis Antigravity vers Devin :

```powershell
node .agent/agent-bridge/binome.js --as agy send "bien recu devin, le canal fonctionne"
```

Le texte arrive directement dans la fenetre de Devin.

---

## Le script de test automatique

Pour aller plus vite, utilise le script fourni dans le dossier `scripts/` :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\3-teste-le-ping-pong.ps1
```

Il annonce l'agent, envoie un message date et affiche les derniers echanges inscrits dans le carnet.

---

## Si le message n'arrive pas

| Constat | Raison la plus frequente | Action a mener |
|---|---|---|
| Le port 7477 ne repond pas | L'extension monitor n'est pas active | Ouvre le panneau Orchestrator Monitor dans Devin et recharge la fenetre |
| L'identifiant est introuvable | La commande `join` n'a pas ete lancee | Relance `binome.js --as devin join` et `binome.js --as agy join` |
| Erreur "wake-noroute" | La cible n'est plus ouverte dans Devin | Relance `node .agent/agent-bridge/binome.js pair` pour rafraichir |

---

## Les fichiers de la passerelle binome

| Fichier | Role |
|---|---|
| `.agent/agent-bridge/binome.js` | L'outil de commande pour s'annoncer (`join`), envoyer (`send`) ou lire (`tail`) |
| `.agent/agent-bridge/agy-hub.js` | La passerelle qui distribue les messages vers Antigravity |
| `.agent/agent-bridge/devin-hub.js` | La passerelle qui injecte les messages dans l'editeur Devin |
| `.agent/agent-bridge/comms.js` | Le module qui gere l'historique chronologique |
| `.agent/comms.jsonl` | Le carnet de bord ou chaque echange est conserve |

---

## Validation avant de continuer

- [ ] L'identifiant de Devin est publie (`join`)
- [ ] L'identifiant d'Antigravity est publie (`join`)
- [ ] Un message test a traverse avec succes

Prochaine etape : `05-quand-ca-marche-pas.md` si tu rencontres un comportement inattendu.
