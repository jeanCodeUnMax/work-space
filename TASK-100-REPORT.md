# T-100 — Rapport : Packaging VSIX + spawn hphe-mcp.exe

**Date** : 2026-10-12
**Workspace** : `c:/Program Files/servers/everything-mcp/.kilo/worktrees/task-344`
**Statut** : ✅ TERMINÉ

## Objectif (PRD phase P6)

> VSIX bundle `hphe-mcp.exe` ; suppression `spawn python` (fin `ENOENT`)

Rendre l'extension VS Code **autonome** : plus besoin de Python installé sur la
machine cible pour lancer le serveur MCP. Le binaire Rust `hphe-mcp.exe` est
embarqué dans le VSIX et spawwné directement.

## Livrables

| Fichier | Rôle | Statut |
|---|---|---|
| `extension/server/hphe-mcp.exe` | Binaire Rust 2.53 MB embarqué | ✅ |
| `extension/src/mcpClient.js` | Détection hphe-mcp.exe en priorité + fallback Python | ✅ |
| `extension/package.json` | Nouvelles options `hpheBinaryPath`, `preferHphe` | ✅ |
| `extension/.vscodeignore` | Commentaire : hphe-mcp.exe inclus volontairement | ✅ |
| `package-vsix.sh` | Script packaging automatisé (build+copy+vsce) | ✅ |
| `everything-search.vsix` | Archive 1.75 MB, 23 fichiers | ✅ |
| `CHANGELOG.md` | Entrée 1.0.2 | ✅ |

## Architecture de spawn (nouvelle)

```
mcpClient._spawn()
  │
  ├─ preferHphe=true (défaut) + hphe-mcp.exe présent ?
  │    └─ OUI → spawn(hphe-mcp.exe)   [aucune dépendance Python]
  │
  └─ fallback : spawn(python -u server.py)
       python → python3 → py -3  (détection existante conservée)
```

## Tests de validation (exécutés)

| Test | Commande | Résultat |
|---|---|---|
| Version binaire | `hphe-mcp.exe --version` | ✅ `hphe-mcp 0.1.0` |
| Handshake initialize | JSON-RPC `initialize` | ✅ `serverInfo` retourné, protocolVersion 2024-11-05 |
| tools/list | JSON-RPC `tools/list` | ✅ 25 outils exposés (everything_*, fs_*, hphe_health...) |
| tools/call | `hphe_health` | ✅ répond `status: degraded` (daemon absent, pas de crash) |
| Syntaxe JS | `node --check mcpClient.js` | ✅ OK |
| VSIX contenu | `unzip -l` | ✅ `hphe-mcp.exe` (2651136 o) + `server.py` présents |
| Packaging E2E | `package-vsix.sh --skip-build` | ✅ VSIX 1.75 MB / 23 fichiers |

## ⚠️ Limitation connue — fallback daemon (IMPORTANT)

Le binaire `hphe-mcp.exe` (Rust) communique **uniquement** avec le daemon
`hphe-indexd` via le pipe nommé `\\.\pipe\hphe-index`. Il n'a **PAS** de
fallback vers `Everything.exe` (contrairement au `server.py` Python qui, lui,
parle à Everything.exe via IPC `WM_COPYDATA`).

**Conséquence sur cette machine de dev** :
- `Everything.exe` tourne (process actif) mais le daemon `hphe-indexd` n'est
  **pas** installé/actif → `everything_search` via hphe-mcp.exe renvoie
  `backend: hphe-pipe, error: Daemon IPC error`.

**Stratégie de bascule recommandée** (à valider avec l'utilisateur avant
déploiement) :
1. Si le daemon `hphe-indexd` est déployé → `preferHphe: true` (défaut). Idéal.
2. Si seul `Everything.exe` est dispo → mettre `preferHphe: false` pour forcer
   le backend Python/Everything.exe.

Le fallback automatique du `_spawn()` couvre le cas « binaire absent/crash »,
mais **pas** le cas « binaire présent + daemon absent » (le binaire répond alors
en mode dégradé sans planter). C'est le seul écart fonctionnel à documenter.

## Options de configuration (extension)

| Setting | Défaut | Rôle |
|---|---|---|
| `everythingSearch.preferHphe` | `true` | Priorité au binaire Rust, fallback Python |
| `everythingSearch.hpheBinaryPath` | `""` | Chemin custom hphe-mcp.exe (sinon bundled) |
| `everythingSearch.serverPath` | `""` | Chemin custom server.py (fallback) |
| `everythingSearch.pythonPath` | `""` | Interpréteur Python (auto-detect si vide) |

## Commandes de reproduction

```bash
# Packaging complet (build Rust + copy + VSIX)
cd "c:/Program Files/servers/everything-mcp/.kilo/worktrees/task-344"
bash package-vsix.sh

# Packaging rapide (binaire déjà buildé)
bash package-vsix.sh --skip-build

# Installer le VSIX
code --install-extension "everything-search.vsix"
```

## Décision backend par défaut (actée)

**`everythingSearch.preferHphe = true` par défaut** (binaire Rust prioritaire).

Justification :
- Objectif littéral de T-100 (« suppression spawn python, fin ENOENT ») : un
  défaut `false` réintroduirait le problème visé sur les machines sans Python.
- Trajectoire PRD (O4) : `hphe-mcp.exe` = backend unique visé.
- Le fallback Python reste opérationnel si le binaire est absent/cassé.
- Le daemon `hphe-indexd` est une dépendance de **déploiement** (phases P4/P5 du
  PRD), pas du packaging — donc hors scope de T-100.

La limitation « daemon absent → mode dégradé » documentée ci-dessus est assumée
et traçable ; elle se résout au déploiement du daemon, pas par un changement de
défaut packaging.

## Résultat

L'objectif P6 « VSIX bundle hphe-mcp.exe ; suppression spawn python (fin ENOENT) »
est **atteint** : le VSIX est autonome côté Python. La dépendance runtime
résiduelle est le daemon `hphe-indexd` (déploiement séparé, phase P4/P5 du PRD).
