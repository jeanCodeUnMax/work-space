# Plugin Hephaistos Devin

## Installation

1. Placer le dossier `plugin-devin` dans le répertoire des plugins Devin (ou le charger manuellement).
2. S'assurer que `hphe-mcp.exe` est accessible via la variable d'environnement `HPHE_MCP_PATH` ou au même niveau que ce plugin.
3. Lancer Devin et activer le plugin via la commande `devin plugin enable hephaistos-devin`.

## Utilisation

Le plugin expose les commandes `execute_skill_<nom>` pour chaque skill normalisé (jointes, binome, flux, bleubite-dispatch).

Exemple d'appel via l'interface Devin :

```
execute_skill_jointes {"agent": "some-agent"}
```

Le plugin :

- Lance `hphe-mcp.exe` une seule fois (mcp-proxy.js) et réutilise le processus stdio JSON-RPC.
- Proxie les calls `tools/call` vers les outils RPC exposés par hphe-mcp.
- Gère le timeout, les erreurs JSON-RPC et le cleanup des promesses en attente.

## Permissions et élévation NTFS

Le manifeste `plugin.json` déclare une élévation NTFS avec justification limitée à la lecture seule de l'index `$MFT` via le serveur MCP. Aucun droit d'écriture directe n'est requis ; l'élévation n'est justifiée que pour l'indexation `everything_search`. Un consentement utilisateur est demandé au premier lancement.

- **Portée** : lecture seule (`read`)
- **Chemins** : racine du workspace `C:\Program Files\Projet-complet\hephaistos2-kit`
- **Justification** : index NTFS `$MFT en lecture seule via hphe-mcp.exe` ; le plugin n'écrit jamais directement en NTFS élève.

## Développement

- `src/mcp-proxy.js` : gestionnaire singleton du processus stdio JSON-RPC. Voir les commentaires pour les timeouts, pendingCalls, buffer robuste et validation args.
- `src/index.js` : enregistre les commandes `execute_skill_*` et appelle `mcp-proxy.callTool`.
- `src/skills.js` : loader dynamique de `skills-to-plugin-commands.json` + fonctions `executeSkill`/`listSkills`.
- `validateArgs` : vérifie la whitelist d'outils connue et les types avant d'appeler le MCP.

## Points ouverts

- Persistance du choix thème icône (voir theme-switcher-spec.md).
- Compléter les handlers `execute_skill_*` dans `src/index.js` via `mcp-proxy.callTool`.
- Générer/populer les dossiers de thèmes alternatifs (dwarves, starwars, etc.).