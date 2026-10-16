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
# Si version < 0.0.57, réinstalle :
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

**Remède** : dans Devin, lance `/jointes <agent>` et sélectionne le mode (ACP ou CLI) et l’ID de session si demandé. Pour vérifier en lecture seule, reprends les mêmes options `--peer`, `--peer-via`, `--self` et `--to` avec `binome.js pair`. Si `established` vaut `false`, n’envoie rien; vérifie le provider/session et refais le join. L’ancien historique ne compte pas.

### Symptôme : "Le message arrive dans une nouvelle conversation"

**Diagnostic** : la cible ACP n’est pas connue ou n’a pas pu être focalisée; ou une ancienne extension ne respecte pas encore la route explicite.

**Remède** : garde l'extension `orchestrator-monitor` à jour (>= 0.0.57). Les envois vers ACP tiers restent fail-closed (`skipped`) tant qu'un send provider-spécifique n'est pas disponible; ne réessaie pas en envoyant vers le chat Devin, une autre session ou le transport CLI.

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
| `binome.js --as devin --self <id> pair` | Vérifie en lecture seule un pair frais |
| `binome.js --as devin --self <id> send "..."` | Envoie seulement via le pair frais vérifié |
| `binome.js tail` | Lit les derniers messages et handshakes |
| `hphe-mcp.exe --tool hphe_health` | Santé du moteur |
| `Test-NetConnection 127.0.0.1 -Port 7477` | Teste le bridge |

---

## 🆘 Si rien ne marche

1. Relance `install.ps1 -Elevated` en admin
2. Relance `install-extension-hub.ps1` (sans `-CheckOnly`)
3. Relance `setup-agent-surfaces.ps1`
4. Recharge l’IDE uniquement après installation/mise à jour d’une extension; une modification de `.agent/agent-bridge/binome.js` se teste sans redémarrage en relançant `/jointes AGY`
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
