# Changelog — everything-mcp

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
