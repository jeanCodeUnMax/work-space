# Etape 1 — L'installation (le montage du kit)

> **Objectif** : poser chaque element au bon endroit, comme pour assembler un jeu de construction sans perdre de piece.

---

## La commande principale

1. Fais un clic droit sur **PowerShell 7** -> **Executer en tant qu'administrateur**.
2. Copie et colle cette commande :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\1-installe-moi.ps1
```

Le script s'occupe de tout le reste.

---

## Ce qui se passe sous le capot (pour comprendre)

Le script `1-installe-moi.ps1` execute les taches suivantes dans le bon ordre :

1. **Controle administrateur** : s'assure qu'il a les droits pour installer les services.
2. **Controle des prerequis** : verifie PowerShell 7, Node.js et les cles NVIDIA.
3. **Mise en place des binaires** : utilise les executables precompiles ou les compile avec Rust.
4. **Deploiement du serveur** : copie les executables dans `C:\Program Files\servers\hephaistos2-kit\extension\server\`.
5. **Initialisation des donnees** : prepare la base de donnees `orchestrator.db` et l'index de fichiers.
6. **Configuration MCP** : relie le moteur a ton editeur Devin (`mcp_config.json`).
7. **Demarrage automatique** : place `hphe-rest` au demarrage de Windows.
8. **Tache planifiee** : configure `hphe-indexd` pour tourner en arriere-plan en continu.
9. **Extensions VSIX** : installe `orchestrator-monitor` dans Devin.
10. **Synchronisation finale** : diffuse les regles dans toutes les surfaces d'agents.

---

## En cas de besoin : commandes manuelles directes

Si tu preferes lancer les etapes une a une depuis la racine du projet :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit"

# 1. Installation complete avec privileges administrateur
pwsh -File install.ps1 -Elevated

# 2. Si les executables sont deja prets (pas besoin de compiler)
pwsh -File install.ps1 -Elevated -SkipBuild

# 3. Si tu veux sauter uniquement la verification de fin
pwsh -File install.ps1 -Elevated -SkipVerify
```

---

## Installation des extensions VSIX (le tableau de bord)

Les extensions ajoutent l'ecran de controle dans ton editeur de code :

### Methode automatique (recommandee)

Depuis la racine du projet :

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1
```

### Methode manuelle dans l'editeur

1. Dans Devin ou VS Code, appuie sur `Ctrl+Shift+P`.
2. Tape `Extensions: Install from VSIX...` et valide.
3. Choisis le fichier `orchestrator-monitor-*.vsix` le plus recent dans `extensions/orchestrator-monitor/`.
4. Recharge l'editeur : `Ctrl+Shift+P` -> `Developer: Reload Window`.

---

## Diffusion des regles et competences aux agents

Cette etape donne la meme memoire a tous tes assistants :

```powershell
pwsh -File .agent\setup\setup-agent-surfaces.ps1
```

Elle distribue les regles vers :
- Devin CLI (`~/.config/devin/global_rules.md`)
- Devin IDE (`~/.claude/CLAUDE.md`)
- Windsurf (`~/.codeium/windsurf/memories/global_rules.md`)
- Antigravity (`~/.gemini/config/rules/global_rules.md` et `~/.gemini/GEMINI.md`)

---

## Verification de fin d'installation

Apres avoir recharge la fenetre de Devin et Antigravity, verifie que le tableau de bord repond :

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly
```

Tu dois obtenir :
- `[OK] orchestrator-monitor v0.0.53+ detectee`
- `[OK] hub agy actif`
- `[OK] surfaces de regles conformes`
- `[OK] canal binome : IDs devin et agy publies dans comms.jsonl`
- `[OK] ws-bridge 7477 vivant`

---

## Les 4 points a retenir en cas de doute

| Situation | Cause frequente | Solution simple |
|---|---|---|
| Le script refuse de se lancer | Fenetre ouverte sans les droits admin | Clic droit -> Executer en tant qu'administrateur |
| L'extension n'apparait pas | La fenetre n'a pas ete rechargee | Fais `Ctrl+Shift+P` -> `Developer: Reload Window` |
| Le port 7477 est silencieux | L'extension monitor n'a pas demarre | Ouvre le panneau Orchestrator Monitor dans Devin |
| Les regles sont signalees non conformes | Les fichiers ont ete modifies manuellement | Relance `pwsh -File .agent\setup\setup-agent-surfaces.ps1` |

---

## Validation avant de continuer

- [ ] Le script d'installation s'est termine avec succes
- [ ] La commande `-CheckOnly` est validee
- [ ] La fenetre de l'editeur a ete rechargee

Prochaine etape : `03-verification.md`.
