# Etape 0 — Avant de commencer
 
> **Objectif** : preparer ton ordinateur comme on prepare les ingredients d'un gateau. Si un ingredient essentiel manque, le gateau ne peut pas cuire.

---

## La liste des ingredients indispensables

Pour que le kit fonctionne, tu as besoin de ces 5 elements :

| Element | Comment verifier ? | Que faire s'il manque ? |
|---|---|---|
| **Windows avec disque NTFS** | Tu es sous Windows, tes disques sont en NTFS par defaut | Rien a faire, c'est le standard sous Windows |
| **PowerShell 7** | Ouvre une fenetre et tape `pwsh -v` | Telecharge-le sur github.com/powershell/powershell |
| **Node.js (version 18+)** | Ouvre une fenetre et tape `node -v` | Telecharge l'installeur sur nodejs.org |
| **Rust (cargo)** | Tape `cargo --version` | Installe-le depuis rustup.rs (facultatif si les binaires sont deja presents) |
| **Cles d'acces NVIDIA** | Verifie la presence de `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` | Cree un compte gratuit sur build.nvidia.com pour obtenir tes cles |

> **A retenir** : les deux cles NVIDIA permettent de faire travailler les agents legers gratuitement. Sans elles, les fonctions de delegation autonome ne peuvent pas tourner.

---

## Le test rapide de verification (30 secondes)

Ouvre **PowerShell 7** et colle ce bloc de test :

```powershell
Write-Host "=== Test des prerequis ==="
if (Get-Command pwsh -ErrorAction SilentlyContinue) { Write-Host "[OK] PowerShell 7" } else { Write-Host "[MANQUE] PowerShell 7" }
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "[OK] Node.js" } else { Write-Host "[MANQUE] Node.js" }
if (Get-Command cargo -ErrorAction SilentlyContinue) { Write-Host "[OK] Rust (cargo)" } else { Write-Host "[INFO] Rust absent (mode binaire possible)" }
if ($env:NVIDIA_API_KEY) { Write-Host "[OK] Variable NVIDIA_API_KEY" } else { Write-Host "[MANQUE] Variable NVIDIA_API_KEY" }
if ($env:NVIDIA_API_KEY_2) { Write-Host "[OK] Variable NVIDIA_API_KEY_2" } else { Write-Host "[MANQUE] Variable NVIDIA_API_KEY_2" }
```

Si les voyants obligatoires sont `[OK]`, tu peux passer a la suite.

---

## Ou sont ranges les dossiers ?

| Dossier | Ce que c'est | Est-ce que tu y touches ? |
|---|---|---|
| `C:\Program Files\Projet-complet\hephaistos2-kit\` | L'atelier de travail (le code source et les scripts) | Oui, c'est la qu'on lance les commandes |
| `C:\Program Files\servers\hephaistos2-kit\` | La salle des machines (les executables en service) | Non, le script d'installation range tout automatiquement |
| `C:\Program Files\servers\everything-mcp\` | L'ancienne passerelle de compatibilite | Non, c'est gere en coulisses |

> **Regle de securite** : on travaille dans `Projet-complet`, et les services tournent dans `servers`. Ne deplace aucun fichier manuellement.

---

## Comment enregistrer tes cles NVIDIA

Si tes cles ne sont pas encore enregistrees dans Windows :

1. Appuie sur les touches `Touche Windows + R`.
2. Tape `sysdm.cpl` puis valide avec Entree.
3. Va dans l'onglet **Parametres systeme avances**, puis clique sur **Variables d'environnement** en bas a droite.
4. Dans la section superieure (**Variables utilisateur**), clique sur **Nouvelle** :
   - Nom de variable : `NVIDIA_API_KEY`
   - Valeur de variable : colle ta premiere cle
5. Recommence pour la deuxieme cle :
   - Nom de variable : `NVIDIA_API_KEY_2`
   - Valeur de variable : colle ta deuxieme cle
6. Valide par OK partout, puis ferme et rouvre PowerShell.

---

## Validation avant de continuer

Avant d'ouvrir la page suivante, assure-toi d'avoir :
- [ ] PowerShell 7 fonctionnel (`pwsh -v`)
- [ ] Node.js installe (`node -v`)
- [ ] Les variables `NVIDIA_API_KEY` et `NVIDIA_API_KEY_2` definies

Prochaine etape : `02-installation.md`.
