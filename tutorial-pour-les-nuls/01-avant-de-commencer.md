# Étape 0 — Avant de commencer

> **Objectif** : préparer ton PC comme on prépare un gâteau. Si un ingrédient manque, le gâteau ne lève pas.

---

## 🧾 La liste des ingrédients

Tu as besoin de 5 choses :

| Ingrédient | Comment vérifier ? | Si tu ne l'as pas |
|---|---|---|
| Windows + NTFS | Tu es sous Windows, normal | Installe Windows (lol) |
| PowerShell 7 | Ouvre PowerShell, tape `pwsh -v` | Télécharge-le sur github.com/powershell/powershell |
| Rust (cargo) | Tape `cargo --version` | Installe depuis rustup.rs |
| Node.js 18+ | Tape `node --version` | Installe depuis nodejs.org |
| Les clés magiques NVIDIA | Regarde si `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` sont dans tes variables d'environnement | Demande à ton admin ou crée un compte NVIDIA NIM |

> **Important** : les deux clés NVIDIA sont indispensables pour les workers `nim1` et `nim2`. Sans elles, les agents ne pourront pas bosser gratuitement.

---

## 🧪 Le test rapide (30 secondes)

Ouvre PowerShell et colle ça :

```powershell
Write-Host "=== Test des prerequis ==="
if (Get-Command pwsh -ErrorAction SilentlyContinue) { Write-Host "[OK] PowerShell 7" } else { Write-Host "[MANQUE] PowerShell 7" }
if (Get-Command cargo -ErrorAction SilentlyContinue) { Write-Host "[OK] Rust" } else { Write-Host "[MANQUE] Rust" }
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "[OK] Node.js" } else { Write-Host "[MANQUE] Node.js" }
if ($env:NVIDIA_API_KEY) { Write-Host "[OK] NVIDIA_API_KEY" } else { Write-Host "[MANQUE] NVIDIA_API_KEY" }
if ($env:NVIDIA_API_KEY_2) { Write-Host "[OK] NVIDIA_API_KEY_2" } else { Write-Host "[MANQUE] NVIDIA_API_KEY_2" }
```

Si tout est `[OK]`, tu peux passer à l'étape suivante. Sinon, installe ce qui manque et relance le test.

---

## 📁 Où sont les fichiers ?

| Endroit | C'est quoi ? | Tu y touches ? |
|---|---|---|
| `C:\Program Files\Projet-complet\hephaistos2-kit\` | Le projet (on code ici) | Oui, c'est là qu'on installe |
| `C:\Program Files\servers\hephaistos2-kit\` | Le runtime (ça tourne ici) | Non, install.ps1 s'en charge |
| `C:\Program Files\servers\everything-mcp\` | Un pont vers l'ancien système | Non, c'est juste un lien |

> **Règle d'or** : on code dans `Projet-complet`, ça tourne dans `servers`. Ne mélange pas.

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
- [ ] PowerShell 7 (`pwsh -v` fonctionne)
- [ ] Rust (`cargo --version` fonctionne)
- [ ] Node.js 18+ (`node --version` fonctionne)
- [ ] `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` dans les variables d'environnement

→ **Passer à** `02-installation.md`
