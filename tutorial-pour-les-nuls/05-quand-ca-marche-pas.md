# Etape 4 — Quand ca ne marche pas (la trousse de secours)

> **Objectif** : resoudre les pannes les plus courantes rapidement, sans paniquer.

---

## Les situations courantes et leurs solutions

### Situation 1 : "hphe-indexd ne demarre pas"

**Cause** : la tache planifiee Windows n'a pas pu etre creee avec les privileges administrateur.

**Solution** :
1. Fais un clic droit sur l'icone PowerShell 7 -> **Executer en tant qu'administrateur**.
2. Lance la commande :
```powershell
pwsh -File install.ps1 -Elevated -SkipBuild
```

---

### Situation 2 : "Le repondeur REST (port 8792) ne repond pas"

**Cause** : le service d'arriere-plan `hphe-rest` n'est pas encore lance.

**Solution** :
```powershell
# 1. Regarde les dernieres lignes du journal
Get-Content "C:\Program Files\servers\hephaistos2-kit\data\hphe-rest.log" -Tail 20 -ErrorAction SilentlyContinue

# 2. Relance manuellement le service
Start-Process -FilePath "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.cmd" -WindowStyle Minimized
```

---

### Situation 3 : "Le voyant MCP reste rouge dans l'editeur"

**Cause** : l'extension `orchestrator-monitor` n'a pas ete rechargee ou la version installee est inferieure a la 0.0.53.

**Solution** :
```powershell
pwsh -File .agent\setup\install-extension-hub.ps1
```
Puis, dans Devin : appuie sur `Ctrl+Shift+P` -> tape `Developer: Reload Window`.

---

### Situation 4 : "Le bridge port 7477 est silencieux"

**Cause** : l'extension n'a pas encore lance le pont reseau en arriere-plan.

**Solution** :
1. Dans Devin, ouvre le panneau lateral de l'extension `Hephaistos Orchestrator Monitor`.
2. Fais `Ctrl+Shift+P` -> `Developer: Reload Window`.
3. Si le port reste inerte, tu peux le demarrer directement en console de test :
```powershell
node "extensions\orchestrator-monitor\ws-bridge\bridge.js"
```

---

### Situation 5 : "Le binome ne recoit aucun message"

**Cause** : les deux assistants n'ont pas publie leur adresse de conversation (`convId`), ou une ancienne adresse est restee stockee.

**Solution** :
Re-synchronise les deux cotes :
```powershell
node .agent/agent-bridge/binome.js --as devin join
node .agent/agent-bridge/binome.js --as agy join
node .agent/agent-bridge/binome.js pair
```

---

### Situation 6 : "Un worker distant NIM ne repond pas"

**Cause** : une cle NVIDIA manque dans les variables d'environnement.

**Solution** :
Verifie que les deux cles sont bien affichees par cette commande :
```powershell
$env:NVIDIA_API_KEY
$env:NVIDIA_API_KEY_2
```
Si une cle est vide, consulte l'etape `01-avant-de-commencer.md` pour l'ajouter.

---

### Situation 7 : "Tache echouee : spawn node syntaxe incorrecte (erreur OS 123)"

**Cause** : la commande de dispatch a ete envoyee sans preciser le dossier de travail (`workspace`), ou le message contient des apostrophes non protegees sous Windows.

**Solution** :
Passe toujours le chemin complet dans le parametre `workspace` :
`workspace: "C:\Program Files\Projet-complet\hephaistos2-kit"`

---

## La trousse a outils (commandes utiles a conserver)

| Ce que tu veux faire | La commande exacte a taper |
|---|---|
| Installer ou reparer tout le systeme | `pwsh -File install.ps1 -Elevated` |
| Verifier la sante generale sans rien modifier | `pwsh -File tutorial-pour-les-nuls\scripts\2-verifie-tout.ps1` |
| Verifier les regles des agents | `pwsh -File .agent\setup\setup-agent-surfaces.ps1 -Verify` |
| Tester le talkie-walkie | `pwsh -File tutorial-pour-les-nuls\scripts\3-teste-le-ping-pong.ps1` |
| Consulter les derniers messages du carnet | `node .agent/agent-bridge/binome.js tail` |
| Tester la sante du moteur central | `& "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe" --tool hphe_health` |
| Verifier l'ecoute du port reseau 7477 | `Test-NetConnection 127.0.0.1 -Port 7477` |

---

## La procedure de remise a zero propre

Si rien ne semble repondre :
1. Ferme Devin et Antigravity.
2. Ouvre **PowerShell 7 en administrateur**.
3. Lance successivement :
```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit"
pwsh -File install.ps1 -Elevated -SkipBuild
pwsh -File .agent\setup\install-extension-hub.ps1
pwsh -File .agent\setup\setup-agent-surfaces.ps1
```
4. Rouvre Devin et Antigravity.
5. Lance `pwsh -File tutorial-pour-les-nuls\scripts\2-verifie-tout.ps1` pour confirmer que tous les feux sont au vert.
