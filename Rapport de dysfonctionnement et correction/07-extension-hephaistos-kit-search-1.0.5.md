# 07 — extension hephaistos-kit-search 1.0.5 : correctifs webview et packaging VSIX

- **Date :** 2026-10-19
- **Taches :** #498, #501 (rejetee puis reprise)
- **Composant :** `extension/src/searchView.js`, `extension/media/panel.js`, VSIX 1.0.5
- **Detecteur :** Tango · **Correcteur :** agent 5 (devin) via #498

## Symptome

Deux bugs sur l'extension `hephaistos-kit-search` :

1. **Persistance** : les dossiers epingles/deposes (`dirFavChips`, `crumbsEl`) disparaissaient au reload — l'etat reposait sur `vscode.setState()` cote webview, volatile.
2. **Creation fs** : `actNewFile`/`actNewDir`/`_fsCreate` echouaient ou ciblaient un mauvais repertoire sans ligne selectionnee — `dirForCreate()` ne regardait que `selectedItems()` et renvoyait `null` en mode browse.

## Cause racine

Etat de navigation confie a la couche volatile webview plutot qu'a `context.workspaceState`/`globalState` cote extension host ; resolution du repertoire cible non contextualisee (pas de fallback `state.cwd` -> racine workspace).

## Correction appliquee

- IPC bidirectionnel `saveFolderHistory`/`getFolderHistory` dans `searchView.js` ; persistance dans `context.globalState` (cle `panelState`), injection a `resolveWebviewView` via `window.__HPHE_BOOT__`.
- Resolution en cascade : selection (dossier) -> parent (fichier) -> `state.cwd` (browse) -> racine workspace ; indicateur visuel de cible ; refresh apres `fsCreated`.
- Rebuild et packaging `hephaistos-kit-search-1.0.5.vsix` (10,7 MB) conserve dans `extension/` sans installation — installation sur validation Boss uniquement.

## Verification et prevention

- Artefact VSIX verifie sur disque ; tache #501 requalifiee (livrable factice nim2) puis reelle via #498.
- Regle : tout packaging est conserve non installe jusqu'a validation explicite.
