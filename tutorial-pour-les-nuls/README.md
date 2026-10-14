# Guide d'installation pas-a-pas — Hephaistos2-Kit

> **C'est quoi ?** Un kit qui transforme ton PC en moteur de recherche ultra-rapide et qui relie deux intelligences artificielles (Devin et Antigravity) comme avec un talkie-walkie.  
> **Pour qui ?** Pour toi, meme si tu n'as jamais installe de serveur ni tape de ligne de commande complexe.  
> **Combien de temps ?** Moins de 10 minutes en suivant les etapes tranquillement.

---

## La carte du parcours (on avance pas a pas)

| Etape | Fichier | Ce que l'on fait |
|---|---|---|
| 0 | `01-avant-de-commencer.md` | Ce qu'il faut preparer (comme mettre ses chaussures avant de sortir) |
| 1 | `02-installation.md` | On installe tout (comme assembler un jeu de construction, piece par piece) |
| 2 | `03-verification.md` | On teste que tout fonctionne (comme gouter un plat avant de servir) |
| 3 | `04-le-ping-pong.md` | On teste le talkie-walkie entre Devin et Antigravity |
| 4 | `05-quand-ca-marche-pas.md` | La trousse de secours si un voyant reste rouge |

> **Regle d'or** : suis bien les etapes dans l'ordre, du chapitre 0 au chapitre 4. Ne saute rien.

---

## La methode express en un seul clic

Si tes cles sont deja pretes et que tu veux aller vite :
1. Fais un clic droit sur l'icone de **PowerShell 7**.
2. Choisis **Executer en tant qu'administrateur**.
3. Copie et colle cette commande :

```powershell
cd "C:\Program Files\Projet-complet\hephaistos2-kit\tutorial-pour-les-nuls\scripts"
.\1-installe-moi.ps1
```

Une fois termine, recharge les fenetres de Devin et Antigravity. Tout est en place.

---

## Les elements installes (explique simplement)

| Element | A quoi ca sert ? | Ou c'est range ? |
|---|---|---|
| **hphe-indexd** | Le robot d'indexation. Il scanne tous les disques en une seconde chrono. | `C:\Program Files\servers\hephaistos2-kit\` |
| **hphe-mcp** | Le cerveau de liaison. Il repond aux questions des assistants IA. | Idem |
| **hphe-rest** | Le repondeur rapide. Il permet de verifier en une seconde que le moteur tourne. | Idem + demarrage auto |
| **Extensions VSIX** | Les modules d'ecran : ils affichent le tableau de bord dans ton editeur de code. | `~/.devin/extensions/` ou `~/.vscode/extensions/` |
| **Passerelle binome** | Le talkie-walkie entre Devin et Antigravity pour travailler en equipe. | `.agent/agent-bridge/` dans le projet |
| **Regles et skills** | Les guides de travail pour que les IA respectent tes methodes. | `~/.claude/`, `~/.gemini/`, `~/.config/devin/` |

---

## En cas de doute ou de panne

- **Tu veux verifier si tout est operationnel ?** Lance `.\2-verifie-tout.ps1` dans le dossier `scripts/`.
- **Tu veux tester l'envoi d'un message ?** Lance `.\3-teste-le-ping-pong.ps1` dans le dossier `scripts/`.
- **Quelque chose bloque ?** Ouvre `05-quand-ca-marche-pas.md` pour trouver la solution immediate.

---

## Liste de verification finale

- [ ] Le robot d'indexation (`hphe-indexd`) est actif
- [ ] Le cerveau (`hphe-mcp`) repond
- [ ] Le repondeur rapide (`hphe-rest`) repond sur le port 8792
- [ ] L'extension `orchestrator-monitor` est installee dans Devin
- [ ] Devin et Antigravity s'echangent des messages (ping-pong valide)
- [ ] Les modeles distants repondent a l'appel

Quand chaque point est valide, ton systeme est pret a l'emploi.
