# Modele de securite Hephaistos Devin Plugin

## Elevation NTFS
- **Declaration** : `plugin.json` contient `ntfsElevation: { required: true, scope: ["read"], paths: ["<workspace>"], justification: "Lecture seule de l'index NTFS $MFT via hphe-mcp.exe ; aucun écriture directe en elevation." }`
- **Consentement** : `consentRequired: true` demandé a l'installation (section `Read-Host` dans `install.ps1`).
- **Justification** : L'elvation n'est necessaire que pour accéder au MFT via le MCP ; le plugin n'effectue aucune ecriture en NTFS.

## Outils en ecriture (__confirmed)
- Une liste de 12 outils MCP reputes en ecriture (ex: `everything_index`, `content_insert`, etc.) nécessite un flag `__confirmed: true` dans l'appel `callTool`.
- Le `mcp-proxy.js` vérifie systématiquement ce champ avant d'envoyer la requête; si absent, la requête est rejetée avec `Error: Writing tool requires explicit confirmation`.

## Validation TOOL_SCHEMAS
- Au `initialize`, le proxy charge une whitelist minimale `TOOL_SCHEMAS` (ou récupère le résultat de `tools/list`) et valide chaque appel `callTool` :
  - Nom d'outil présent dans la whitelist.
  - Types des arguments respectés (string, number, boolean, object).
  - Arguments supplémentaires rejetés.
- En cas d'echec, une erreur claire est retournée : `Error: Invalid args for <toolName>`.

## Masquage par défaut comms.jsonl
- Par défaut, `getLastEntries` masque les informations sensibles (tokens, chemins secrets, hexa-longs) via `filterSensitive` avant affichage dans l'activité panel.

## Verification des droits declares
- Le fichier `doc-securite.md` référence chaque outil MCP déclaré dans `manifest.json` et justifie pourquoi l'elevation NTFS est requise (lecture seule index) et quels outils nécessitent `__confirmed`.