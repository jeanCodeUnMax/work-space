# Étape 1 — L'installation (le gros morceau)

> **Objectif** : poser toutes les pièces du kit au bon endroit, comme un Ikea mais sans vis qui manque.

---

## 🎯 La commande magique

Ouvre **PowerShell 7 en administrateur** (clic droit → "Exécuter en tant qu'administrateur") et tape :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\1-installe-moi.ps1
```

C'est tout. Le script fait tout le reste.

---

## 🧩 Ce que le script fait (pour les curieux)

Le script `1-installe-moi.ps1` est un wrapper autour de `install.ps1` qui fait les choses dans l'ordre :

1. **Vérifie que tu es admin** (sinon il s'arrête et te le dit)
2. **Vérifie les prérequis** (PowerShell 7, Rust, Node, clés NVIDIA)
3. **Compile le moteur Rust** (`cargo build --release` dans `hphe/`)
4. **Déploie les binaires** dans `C:\Program Files\servers\hephaistos2-kit\extension\server\`
5. **Crée les dossiers de données** (`data/`, `migrated-vec/`, `memory-database/`)
6. **Seed la base orchestrateur** (agents + provider_prefs)
7. **Configure le MCP** dans Devin (`mcp_config.json`)
8. **Installe l'auto-start** (`hphe-rest` au démarrage)
9. **Crée la tâche planifiée** (`hphe-indexd`, nécessite admin)
10. **Vérifie tout** : extension 0.0.56+, bridge 7477, surfaces de règles, canal binôme

---

## 🧱 Si tu veux faire à la main (ou si le script échoue)

Tu peux lancer les étapes une par une :

```powershell
# 1) Installation complète (depuis la racine du projet)
cd "C:\Program Files\Projet-complet\hephaistos2-kit"
pwsh -File install.ps1 -Elevated

# 2) Si tu veux sauter le build (déjà compilé)
pwsh -File install.ps1 -Elevated -SkipBuild

# 3) Si tu veux sauter les vérifs finales
pwsh -File install.ps1 -Elevated -SkipVerify
```

---

## 📦 Installer les extensions VSIX (les téléphones)

Les extensions se trouvent dans `extensions/orchestrator-monitor/` et `extension/`. Pour les installer :

### Méthode automatique (recommandée)

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1
```

### Méthode manuelle

1. Dans Devin ou VS Code : `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
2. Choisis `extensions/orchestrator-monitor/orchestrator-monitor-0.0.56.vsix`
3. Pareil pour `extension/hephaistos-kit-search.vsix` si besoin
4. **Reload Window** (Ctrl+Shift+P → Developer: Reload Window)

---

## 🧠 Installer les règles et les skills (les bonnes habitudes)

```powershell
pwsh -File .agent\setup\setup-agent-surfaces.ps1
```

Ça copie les règles dans :
- `~/.config/devin/global_rules.md` (Devin CLI)
- `~/.claude/CLAUDE.md` (Devin IDE, bloc marqué)
- `~/.codeium/windsurf/memories/global_rules.md` (Windsurf)
- `~/.gemini/config/rules/global_rules.md` et `~/.gemini/GEMINI.md` (Antigravity)

Et les skills dans :
- `%APPDATA%/devin/skills`
- `~/.config/devin/skills`
- `~/.antigravity/skills`

---

## 🧪 Vérification rapide après install

Une fois que tout est fini, relance **Devin** et **Antigravity** (reload window dans les deux). Puis lance :

```powershell
pwsh -File .agent\setup\install-extension-hub.ps1 -CheckOnly
```

Tu devrais voir :
- `[OK] orchestrator-monitor v0.0.56 installée`
- `[OK] hub agy actif`
- `[OK] surfaces de règles conformes`
- `[OK] canal binome : IDs devin et agy publiés`
- `[OK] ws-bridge 7477 vivant`

Si tout est vert, tu peux passer à `03-verification.md`. Sinon, va voir `05-quand-ca-marche-pas.md`.

---

## ⚠️ Les pièges classiques

| Piège | Pourquoi ça coince | Comment débloquer |
|---|---|---|
| `install.ps1` refuse de se lancer | Pas en admin | Clic droit → Exécuter en tant qu'administrateur |
| `cargo build` échoue | Rust pas installé ou version trop vieille | `rustup update` puis réessaye |
| `hphe-indexd` pas créé | Pas de droits SYSTEM | Relance `install.ps1 -Elevated` en admin |
| Extension pas détectée | Pas de reload après install | `Ctrl+Shift+P` → `Developer: Reload Window` |
| Bridge 7477 muet | L'extension n'a pas démarré | Vérifie que `orchestrator-monitor` est activé, reload |

---

## ✅ Récapitulatif

- [ ] `install.ps1` a tourné sans erreur
- [ ] `install-extension-hub.ps1 -CheckOnly` est tout vert
- [ ] Devin et Antigravity ont été reload

→ **Passer à** `03-verification.md`
