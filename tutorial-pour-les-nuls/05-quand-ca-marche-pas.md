# Étape 4 — Quand ça marche pas (le docteur est là)

> **Objectif** : réparer les pannes courantes, comme un médecin mais pour ton PC.

---

## 🩺 Les symptômes et les remèdes

### Symptôme : "hphe-indexd ne démarre pas"

**Diagnostic** : la tâche planifiée n'existe pas ou n'est pas élevée.

**Remède** :
```powershell
# En admin
pwsh -File install.ps1 -Elevated -SkipBuild
```

### Symptôme : "curl :8792 ne répond pas"

**Diagnostic** : `hphe-rest` n'est pas lancé.

**Remède** :
```powershell
# Vérifie le log
Get-Content "C:\Program Files\servers\hephaistos2-kit\data\hphe-rest.log" -Tail 20

# Relance le service
Restart-Service hphe-rest -Force -ErrorAction SilentlyContinue
# Ou lance le .cmd manuellement
& "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.cmd"
```

### Symptôme : "MCP rouge dans l'IDE"

**Diagnostic** : l'extension `orchestrator-monitor` n'est pas chargée ou mal installée.

**Remède** :
```powershell
pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly
# Si version < 0.0.54, réinstalle :
pwsh -File .agent\setup\install-extension-hub.ps1
```
Puis `Ctrl+Shift+P` → `Developer: Reload Window`.

### Symptôme : "Bridge 7477 muet"

**Diagnostic** : l'extension n'a pas spawné `ws-bridge/bridge.js`.

**Remède** :
1. Vérifie que `orchestrator-monitor` est activé dans l'IDE
2. Reload window
3. Si toujours muet, lance manuellement :
   ```powershell
   node "extensions\orchestrator-monitor\ws-bridge\bridge.js"
   ```

### Symptôme : "Le binôme ne reçoit pas les messages"

**Diagnostic** : les `join` n'ont pas été faits, ou les `convId` sont obsolètes.

**Remède** :
```powershell
node .agent/agent-bridge/binome.js --as devin join
node .agent/agent-bridge/binome.js --as agy join
node .agent/agent-bridge/binome.js pair
```

### Symptôme : "Le message arrive dans une nouvelle conversation"

**Diagnostic** : c'est le bug des versions < 0.0.54. La route ACP n'existait pas.

**Remède** : installe la 0.0.54+ (voir `02-installation.md`).

### Symptôme : "worker NIM ne répond pas"

**Diagnostic** : clé NVIDIA manquante ou modèle non disponible.

**Remède** :
```powershell
# Vérifie les clés
$env:NVIDIA_API_KEY
$env:NVIDIA_API_KEY_2

# Vérifie les modèles disponibles
# (via MCP hphe-mcp : available_models)
```

### Symptôme : "PowerShell 5.1 plante sur les scripts"

**Diagnostic** : les scripts avec accents/em-dashes sans BOM UTF-8.

**Remède** : on a déjà corrigé les `.ps1` du kit. Si tu en as un qui plante, réencode-le en UTF-8 avec BOM :
```powershell
$content = Get-Content "script.ps1" -Raw
[System.IO.File]::WriteAllText("script.ps1", $content, [System.Text.UTF8Encoding]::new($true))
```

### Symptôme : "tâche failed: spawn node syntaxe incorrecte"

**Diagnostic** : le message contient des apostrophes qui cassent la commande Windows.

**Remède** : évite les `'` dans les messages de `dispatch_task`, ou échappe-les.

---

## 🧰 La trousse à outils (commandes utiles)

| Commande | À quoi ça sert |
|---|---|
| `install.ps1 -Elevated` | Installe tout |
| `install-extension-hub.ps1 -CheckOnly` | Vérifie tout sans toucher |
| `setup-agent-surfaces.ps1 -Verify` | Vérifie les règles |
| `binome.js join` | Publie l'ID de conversation |
| `binome.js send "..."` | Envoie un message |
| `binome.js tail` | Lit les derniers messages |
| `hphe-mcp.exe --tool hphe_health` | Santé du moteur |
| `Test-NetConnection 127.0.0.1 -Port 7477` | Teste le bridge |

---

## 🆘 Si rien ne marche

1. Relance `install.ps1 -Elevated` en admin
2. Relance `install-extension-hub.ps1` (sans `-CheckOnly`)
3. Relance `setup-agent-surfaces.ps1`
4. Reload Devin et Antigravity
5. Si toujours cassé, regarde les logs :
   - `servers/hephaistos2-kit/data/*.log`
   - `.agent/comms.jsonl`
   - `extensions/orchestrator-monitor/out/extension.js` (erreurs)

---

## ✅ Dernier recours

Si vraiment rien ne fonctionne :
- Copie le message d'erreur exact
- Regarde dans `.agent/REGISTRY.md` les problèmes connus
- Demande à ton binôme (Devin ou Antigravity) avec le canal
