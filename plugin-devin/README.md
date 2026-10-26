# Plugin Hephaistos Devin

## Installation

1. Placer le dossier `plugin-devin` dans le dossier des plugins de Devin.
2. S'assurer que `hphe-mcp.exe` est accessible via la variable d'environnement `HPHE_MCP_PATH` ou dans `<workspace>/hphe/target/release/`.
3. Redémarrage de Devin.

## Usage

- `activity_feed` : affiche les N dernières entrées du journal partagé `.agent/comms.jsonl`.
- `execute_skill_<nom>` : exécute une skill normalisée (jointes, binome, flux, bleubite-dispatch).
- Les outils MCP sont exposés via JSON-RPC stdio (initialize, tools/list, tools/call).

## Permissions

- `ntfsElevation` : requis uniquement pour la lecture de l'index NTFS `$MFT` via `everything_search` dans le MCP. Le plugin n'écrit jamais directement en NTFS élevé. Un consentement d'installation est demandé.

## Dossiers clés

- `src/comms.js` : lecteur journal partagé (JSONL) avec filtrage sensible.
- `src/activity-panel.js` : formatage affichage des entrées.
- `src/index.js` : enregistrement des commandes du plugin.
- `skills-to-plugin-commands.json` : mapping skill -> commande.
- `plugin.json` : manifeste plugin.

## Dépannage

- Vérifier que `hphe-mcp.exe` tourne et retourne des outils via `tools/list`.
- Les logs d'activité apparaissent dans la console du plugin au lancement de `activity_feed`.
- En cas d'erreur JSON-RPC, vérifier la console pour les détails.