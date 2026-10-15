# 🧸 Tutorial pour les nuls — Hephaistos2-Kit

> **C'est quoi ?** Un kit qui transforme ton PC en moteur de recherche ultra-rapide et qui fait parler les agents IA (Devin et Antigravity) comme un walkie-talkie.  
> **Pour qui ?** Toi, même si tu n'as jamais touché à l'installation avant.  
> **Combien de temps ?** Environ 10 minutes si tout se passe bien.

---

## 🗺️ La carte du monde (on voyage ensemble)

| Étape | Fichier | C'est quoi ? |
|---|---|---|
| 0 | `01-avant-de-commencer.md` | Ce qu'il faut préparer (comme sortir les chaussures avant de marcher) |
| 1 | `02-installation.md` | On installe tout (comme faire un puzzle, on pose les pièces) |
| 2 | `03-verification.md` | On vérifie que tout marche (comme tester une recette) |
| 3 | `04-le-ping-pong.md` | Comment Devin et Antigravity se parlent (le walkie-talkie) |
| 4 | `05-quand-ca-marche-pas.md` | Si ça coince (on débloque ensemble) |

> **Astuce** : suis les étapes dans l'ordre. Ne saute pas d'étape, c'est comme oublier une chaussette — ça se sent après.

---

## 🚀 La version ultra-rapide (pour les impatients)

Si tu es pressé, ouvre PowerShell 7 en administrateur et tape :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\1-installe-moi.ps1
```

Puis relance Devin et Antigravity. C'est tout !

---

## 🧰 Ce que tu vas installer (en gros)

| Morceau | C'est quoi ? | Où ça va ? |
|---|---|---|
| **hphe-indexd** | Un petit robot qui lit tous les fichiers de ton disque dur NTFS en une seconde | `C:\Program Files\servers\hephaistos2-kit\` |
| **hphe-mcp** | Le cerveau qui répond aux questions des agents IA | Idem |
| **hphe-rest** | Un répondeur automatique pour les tests rapides | Idem + démarrage auto |
| **Extensions VSIX** | Les deux téléphones : `orchestrator-monitor` et `hephaistos-kit-search` | `~/.devin/extensions/` ou `~/.vscode/extensions/` |
| **Scripts binôme** | Le walkie-talkie entre Devin et Antigravity | `.agent/agent-bridge/` dans le projet |
| **Règles + skills** | Les bonnes habitudes et les livres de cuisine pour les agents | `~/.claude/`, `~/.gemini/`, `~/.config/devin/` |

---

## 🆘 En cas de problème

- **Ça ne démarre pas ?** → Va voir `05-quand-ca-marche-pas.md`
- **Tu veux juste vérifier ?** → Lance `.\2-verifie-tout.ps1` dans `scripts/`
- **Tu veux vérifier un binôme déjà établi ?** → Lance `3-teste-le-ping-pong.ps1` dans `scripts/` (lecture seule; aucun message envoyé)

---

## 🎯 Checklist finale (tu coches comme une liste de courses)

- [ ] Le robot d'indexation (`hphe-indexd`) tourne
- [ ] Le cerveau (`hphe-mcp`) répond
- [ ] Le répondeur (`hphe-rest`) écoute sur le port 8792
- [ ] Les extensions VSIX sont installées dans Devin
- [ ] Devin et Antigravity se parlent (ping-pong)
- [ ] Les workers NIM répondent quand on les appelle

Si tout est coché, bravo ! Tu as installé le kit. 🎉
