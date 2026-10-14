# Étape 2 — La vérification (on goûte le gâteau)

> **Objectif** : s'assurer que tout fonctionne vraiment, pas juste que le script a dit "OK".

---

## 🧪 La commande magique

Dans PowerShell 7 (pas besoin d'admin) :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\2-verifie-tout.ps1
```

Ça lance tous les tests en une fois.

---

## 🧪 Si tu veux tester à la main

### Test 1 — Le robot d'indexation (hphe-indexd)

```powershell
schtasks /Query /TN "hphe-indexd"
```

Tu dois voir **"En cours"** ou **"Ready"**. Si c'est "Disabled" ou absent, relance `install.ps1 -Elevated`.

### Test 2 — Le répondeur (hphe-rest)

```powershell
curl http://127.0.0.1:8792/health
```

Tu dois voir `{"status":"ok"}` ou `{"status":"healthy"}`. Si ça ne répond pas :

```powershell
# Relance hphe-rest manuellement
Start-Process -FilePath "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.cmd" -WindowStyle Minimized
# Attends 3 secondes et re-teste
sleep 3; curl http://127.0.0.1:8792/health
```

### Test 3 — Le cerveau (hphe-mcp)

```powershell
hphe-mcp.exe --tool hphe_health
```

Tu dois voir des stats sur l'index (nombre de fichiers, mémoire).

### Test 4 — Le bridge WebSocket (le walkie-talkie)

```powershell
Test-NetConnection 127.0.0.1 -Port 7477
```

`TcpTestSucceeded : True` = le bridge écoute. Sinon, l'extension `orchestrator-monitor` n'est pas active dans Devin.

### Test 5 — Les surfaces de règles

```powershell
pwsh -File .agent\setup\setup-agent-surfaces.ps1 -Verify
```

Tu dois voir 4 lignes `[OK]` :
- Devin CLI
- Devin IDE
- Windsurf
- Antigravity

### Test 6 — Le canal binôme

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly
```

Dans la section `[5/6] Surfaces de regles et canal binome`, tu dois voir :
- `canal binome : IDs devin et agy publiés dans comms.jsonl`

Si ce n'est pas le cas, on va le faire à la main dans `04-le-ping-pong.md`.

---

## 📊 Tableau récapitulatif (coche comme une liste)

| Test | Commande | Résultat attendu | Statut |
|---|---|---|---|
| Indexation | `schtasks /Query /TN "hphe-indexd"` | En cours / Ready | ☐ |
| REST | `curl http://127.0.0.1:8792/health` | `{"status":"ok"}` | ☐ |
| MCP | `hphe-mcp.exe --tool hphe_health` | Stats index | ☐ |
| Bridge WS | `Test-NetConnection 127.0.0.1 -Port 7477` | `TcpTestSucceeded : True` | ☐ |
| Règles | `setup-agent-surfaces.ps1 -Verify` | 4x `[OK]` | ☐ |
| Binôme | `install-extension-hub.ps1 -CheckOnly` | `canal binome : IDs publiés` | ☐ |

---

## 🧪 Test réel avec un worker (optionnel mais cool)

Tu veux voir si un worker NIM répond ? Lance :

```powershell
node .agent/agent-bridge/binome.js --as devin send "Test : dis coucou"
```

Puis regarde dans le dashboard `orchestrator-monitor` si la tâche apparaît. Ou lance directement :

```powershell
# Via l'orchestrateur (si tu as le MCP configuré)
dispatch_task(title="Test worker", task_type="test", context="Réponds coucou", agent_name="nim1")
```

---

## ✅ Récapitulatif

- [ ] Tous les tests ci-dessus sont verts
- [ ] Le bridge 7477 est vivant
- [ ] Les surfaces de règles sont conformes
- [ ] Le canal binôme a des IDs publiés

→ **Passer à** `04-le-ping-pong.md`
