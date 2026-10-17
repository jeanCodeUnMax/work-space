# Changelog — everything-mcp

## 1.1.0 — 2026-10-17

Gouvernance des processus, sécurité machine modeste et fiabilisation du pont binome.

| Changement | Détail |
|---|---|
| Mutex Single-Flight ACP (`agent-adapters.js`) | Verrouillage anti-doublon d'injection ACP par couple `providerId/sessionId` avec TTL absolu de 120 s et libération systématique en `finally`. |
| Concurrence CLI bornée | Throttle limitant à 2 le nombre de workers CLI concurrents et priorisation système sous `BELOW_NORMAL_PRIORITY_CLASS`. |
| Maintenance réactive (`tools/reap-and-reconcile.ps1`) | Script unifié d'orchestration exploitant les outils MCP `reconcile_tasks` et `reap_ghosts` pour purger les fantômes et requalifier les tâches orphelines. |
| Fiabilisation `binome.js` | Correction du match de cascade cible quand `peerCascade` est null (évite le handshake frauduleux sur target vide). |
| Portabilité `setup-collab/configurer-devin-agents.ps1` | Déclaration explicite du paramètre `$TargetWorkspace` et interpolation robuste des noms d'agents `$($ag.Name)`. |
| Documentation d'architecture | Publication de l'étude de faisabilité anti-zombies alignée 100% Rust dans `docs/architecture/ETUDE-FAISABILITE-ANTI-ZOMBIES-ACP-CLI.md`. |

## 1.0.2 — 2026-10-12

VSIX 100% autonome côté Python : le binaire Rust `hphe-mcp.exe` est embarqué et
spawné directement. Fin définitive de `spawn python ENOENT`. Fallback Python
conservé (`preferHphe`).

| Changement | Détail |
|---|---|
| `hphe-mcp.exe` embarqué dans `extension/server/` (2.53 MB) | `mcpClient.js` le spawn en priorité ; plus d'interpréteur à détecter |
| Nouvelles options `everythingSearch.preferHphe` / `hpheBinaryPath` | Bascule binaire Rust / Python par réglage |
| Script `package-vsix.sh` | Build Rust + copie + `vsce package` en une commande |

## 1.0.1 — 2026-10-12

VSIX autonome : corrige `spawn python ENOENT` sur les machines sans
checkout du repo ou sans `python` dans le PATH.

| Commit | Changement |
|---|---|
| `d3804a4` | Serveur MCP bundlé dans l'extension (`server/`) + auto-détection de l'interpréteur (`python` → `python3` → `py -3`) |

## 1.0.0 — 2026-10-11

Première version stable. Le MCP est un client fin au-dessus de l'index vivant
d'Everything.exe (IPC `WM_COPYDATA` / QUERY2) ; l'extension IDE fournit le
panneau de recherche et d'exploration.

### Extension — interface & navigation

| Commit | Changement |
|---|---|
| `d363475` | Grip de preview + dossiers favoris |
| `1e2da71` | Mode navigation type navigateur de fichiers |
| `45670fd` | Favoris = raccourcis de navigation (pas des scopes) |
| `a5df1bd` | Historique ◀ ▶, drop vers favoris, i18n FR/EN/ES/DE |
| `57ef2b2` | Loupe de retour recherche + split favoris fichiers/dossiers |
| `732dbcd` | Favoris dossiers en tuiles verticales dans la barre de nav |
| `47ab45d` | Fix crash TDZ qui tuait le panneau + disques/clouds enrichis |
| `ccb3beb` | Chips à gauche + resize colonnes non-proportionnel |
| `81a80b3` | Séparateurs invisibles dans la barre de navigation |
| `d9cdb38` | En-tête fixe séparée + colonnes réordonnables par drag |
| `d1d48ce` | Poignée de resize de la preview déplacée en bas |
| `799ec81` | Scroll global : le grip reste toujours atteignable |
| `56793b8` | La vue PC (disques) devient l'écran d'accueil par défaut |

### Intégration agent (Devin)

| Commit | Changement |
|---|---|
| `a0aecbc` | Submit to agent — injection dans le chat Devin |
| `5def91d` | Fix drop sur la barre de nav rejeté silencieusement |
| `1367506` | ActionTypes réellement routés par le workbench Devin |
| `9efd507` | Submit via `fileMention` natif (vraies puces fichier) |
| `0eef298` | Chemin absolu injecté à côté de chaque mention |

### Serveur & sécurité

| Commit | Changement |
|---|---|
| `36706f1` | Preview texte universel + profil `default` épinglé |
| `c126f22` | Résolution dynamique d'Everything.exe (install exotique) |
