# Étape 0 — Avant de commencer

> **Objectif** : préparer ton PC comme on prépare un gâteau. Si un ingrédient manque, le gâteau ne lève pas.

---

## 🧾 La liste des ingrédients

Tu as besoin de 5 choses :

| Ingrédient | Comment vérifier ? | Si tu ne l'as pas |
|---|---|---|
| Windows + NTFS | Tu es sous Windows, normal | Installe Windows (lol) |
| PowerShell 7 | Ouvre PowerShell, tape `pwsh --version` | Télécharge-le sur github.com/powershell/powershell |
| Git | Tape `git --version` | Installe depuis git-scm.com |
| Rust (cargo) | Tape `cargo --version` | Installe depuis rustup.rs |
| Node.js 18+ | Tape `node --version` | Installe depuis nodejs.org |
| Les clés NVIDIA *(optionnel)* | `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` dans les variables d'environnement | Crée un compte NVIDIA NIM |

> **À savoir** : les clés NVIDIA ne servent qu'aux workers gratuits `nim1`/`nim2`. **Sans elles l'installation fonctionne** — le moteur, le MCP, l'extension et le binôme sont OK ; seules les tâches déléguées aux workers NIM échoueront.

---

## 🧪 Le test rapide (30 secondes)

Ouvre PowerShell et colle ça :

```powershell
Write-Host "=== Test des prerequis ==="
if (Get-Command pwsh -ErrorAction SilentlyContinue) { Write-Host "[OK] PowerShell 7" } else { Write-Host "[MANQUE] PowerShell 7" }
if (Get-Command git -ErrorAction SilentlyContinue) { Write-Host "[OK] Git" } else { Write-Host "[MANQUE] Git" }
if (Get-Command cargo -ErrorAction SilentlyContinue) { Write-Host "[OK] Rust" } else { Write-Host "[MANQUE] Rust" }
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "[OK] Node.js" } else { Write-Host "[MANQUE] Node.js" }
if ($env:NVIDIA_API_KEY) { Write-Host "[OK] NVIDIA_API_KEY" } else { Write-Host "[INFO] NVIDIA_API_KEY absente (workers NIM uniquement)" }
if ($env:NVIDIA_API_KEY_2) { Write-Host "[OK] NVIDIA_API_KEY_2" } else { Write-Host "[INFO] NVIDIA_API_KEY_2 absente (workers NIM uniquement)" }
```

Si tout est `[OK]`, tu peux passer à l'étape suivante. Sinon, installe ce qui manque et relance le test.

---

## 📁 Où sont les fichiers ?

Le projet peut être cloné **n'importe où** — les scripts détectent leur propre position. Choisis un dossier, clone, et n'oublie pas les sous-modules :

```powershell
git clone --recurse-submodules <url-du-repo> hephaistos2-kit
# ou si le dépôt est déjà cloné sans les sous-modules :
cd <chemin-vers-le-repo>
git submodule update --init --recursive
```

| Endroit | C'est quoi ? | Tu y touches ? |
|---|---|---|
| `<repo>` = le dossier du clone | Le projet (on code ici) | Oui, c'est là qu'on installe |
| `%ProgramFiles%\servers\hephaistos2-kit\` | Le runtime (ça tourne ici) | Non, `install.ps1` s'en charge (surcharge : `-InstallRoot` ou `HPHE_INSTALL`) |

> **Règle d'or** : on code dans le dossier du repo, ça tourne dans le runtime installé. Ne mélange pas. Tous les chemins se règlent par paramètres (`-ProjectRoot`, `-InstallRoot`, `-MemoryRoot`…) ou variables d'environnement — rien n'est imposé.

---

## 🔑 Les clés NVIDIA (comment les mettre)

Si tu n'as pas les clés dans tes variables d'environnement :

1. Ouvre **Paramètres Windows** → **Comptes** → **Variables d'environnement** (ou tape `sysdm.cpl` dans Win+R)
2. Clique sur **Variables d'environnement**
3. Dans la partie **Utilisateur**, ajoute :
   - `NVIDIA_API_KEY` = ta clé compte 1
   - `NVIDIA_API_KEY_2` = ta clé compte 2
4. Ferme et rouvre PowerShell pour que ça prenne effet.

---

## ✅ Récapitulatif

Avant de passer à l'installation, tu dois avoir :
- [ ] Windows avec NTFS
- [ ] PowerShell 7 (`pwsh --version` fonctionne)
- [ ] Git (`git --version` fonctionne)
- [ ] Rust (`cargo --version` fonctionne)
- [ ] Node.js 18+ (`node --version` fonctionne)
- [ ] Le repo cloné avec `--recurse-submodules` (ou `git submodule update --init --recursive` fait)
- [ ] *(optionnel)* `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` pour les workers NIM

→ **Passer à** `02-installation.md`
