# Guide de mapping skills <-> commandes plugin-devin

## Table execute_skill_* -> skills .agent/skills

| Commandement plugin | Skill source | Fichier SKILL.md |
|---------------------|------------|------------------|
| execute_skill_jointes | jointes | .agent/skills/jointes/SKILL.md |
| execute_skill_binome | binome | .agent/skills/binome/SKILL.md |
| execute_skill_flux | flux | .agent/skills/flux/SKILL.md |
| execute_skill_bleubite-dispatch | bleubite-dispatch | .agent/skills/bleubite-dispatch/SKILL.md |

## Table mcp_* -> outils hphe-mcp

Le manifeste `manifest.json` déclare `mcp_<outil>` pour chaque outil extrait de `.agent/flux/mcp-tools.json` (65 outils). Exemples :
- `mcp_everything_search` -> outil `everything_search` du MCP
- `mcp_content_search` -> outil `content_search`
- `mcp_semantic_search` ->outil `semantic_search`
- `mcp_hybrid_search` ->outil `hybrid_search`
- ... (et ainsi de suite pour les 65 outils)

Chaque `mcp_<outil>` dans `commands` du manifeste appelle `callTool('<outil>', args)` via le proxy stdio.

## Ajout d'une skill

1. Écrire / mettre à jour `.agent/skills/<nom>/SKILL.md` avec la définition de la skill.
2. Ajouter une entrée dans `skills-to-plugin-commands.json` :
   ```json
   {
     "execute_skill_<nom>": {
       "input": { "agent": "str", "task": "str" },
       "output": "any"
     }
   }
   ```
3. Le loader `src/skills.js` lit ce mapping et dispatch `execute_skill_<nom>` vers le bon handler (MCP ou tâche locale).
4. Si la skill utilise un outil MCP, ajoute `mcp_<outil>` dans `manifest.json` commands et assure que le proxy le supporte.

## commande activity_feed
- Appelle `getLastEntries(n, {hideSensitive:true})` depuis `src/comms.js`.
- Formate via `activity-panel.js` et affiche dans le panneau d'activité du canvas.