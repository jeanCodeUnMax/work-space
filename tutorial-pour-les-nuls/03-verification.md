# Etape 2 — La verification (on goute la recette)

> **Objectif** : s'assurer que chaque moteur tourne pour de vrai, sans se contenter d'un simple "OK".

---

## La commande magique tout-en-un

Dans **PowerShell 7** (pas besoin de droits administrateur ici) :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\2-verifie-tout.ps1
```

Ce script teste les 6 fonctions cles en 5 secondes.

---

## Si tu veux tester chaque piece a la main

### Test 1 — Le robot d'indexation (hphe-indexd)

Ce robot lit les fichiers sur tes disques a toute vitesse :

```powershell
schtasks /Query /TN "hphe-indexd"
```

Tu dois lire **"En cours"**, **"Prêt"** ou **"Ready"**. Si la tache est absente :
`pwsh -File install.ps1 -Elevated -SkipBuild`

### Test 2 — Le repondeur de sante (hphe-rest)

Il verifie que le serveur repond aux requetes :

```powershell
curl http://127.0.0.1:8792/health
```

Tu dois obtenir une reponse JSON avec `"status":"healthy"` ou `"status":"ok"`. Si la connexion echoue :

```powershell
Start-Process -FilePath "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.cmd" -WindowStyle Minimized
```

### Test 3 — Le cerveau central (hphe-mcp)

Il repond directement aux questions de tes agents IA :

```powershell
& "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe" --tool hphe_health
```

Tu dois voir les informations de connexion du serveur et `"status": "healthy"`.

### Test 4 — La ligne telephonique interne (WebSocket 7477)

C'est le canal par lequel l'extension parle aux scripts :

```powershell
Test-NetConnection 127.0.0.1 -Port 7477
```

Tu dois voir `TcpTestSucceeded : True`. Si le resultat est `False`, recharge Devin (`Ctrl+Shift+P` -> `Developer: Reload Window`).

### Test 5 — La conformite des regles

Verifie que tous les agents partagent les memes directives de travail :

```powershell
pwsh -File .agent\setup\setup-agent-surfaces.ps1 -Verify
```

Le script doit afficher 4 lignes de succes (Devin CLI, Devin IDE, Windsurf, Antigravity) et `0 non conforme`.

### Test 6 — La liaison binome et l'extension

Controle l'extension et la publication des identifiants dans le journal :

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly
```

Toutes les verifications doivent ressortir au vert.

---

## Tableau recapitulatif des commandes de diagnostic

| Element | Commande a copier | Resultat recherche |
|---|---|---|
| Indexation | `schtasks /Query /TN "hphe-indexd"` | En cours / Pret |
| Sante REST | `curl http://127.0.0.1:8792/health` | status: healthy |
| Cerveau MCP | `& "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe" --tool hphe_health` | status: healthy |
| Ligne 7477 | `Test-NetConnection 127.0.0.1 -Port 7477` | TcpTestSucceeded : True |
| Regles | `pwsh -File .agent\setup\setup-agent-surfaces.ps1 -Verify` | 4 conforme(s), 0 non conforme(s) |
| Extension | `pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly` | 0 echec(s) |

---

## Validation avant de continuer

- [ ] Les 6 tests sont valides
- [ ] Le port 7477 est joignable
- [ ] Les regles sont conformes

Prochaine etape : `04-le-ping-pong.md`.
