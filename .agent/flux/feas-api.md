# API-ANALYSE: Mécanismes de plugin Devin Desktop

## Structure par mécanisme

### 1. Répertoire de plugin Devan (.devin/plugins)

Le plugin Devin s'installe dans le répertoire `.devin/plugins` à la racine du workspace utilisateur. La structure typique comprend :

```
.devin/plugins/
├── plugin-name/
│   ├── package.json          # Métadonnées plugin (nom, version, description)
│   ├── skills/               # Compétences/actionneurs
│   │   ├── *.ts              # Définitions de skills
│   │   └── index.ts          # Point d'entrée skills
│   ├── rules/                # Règles de comportement
│   │   ├── *.md              # Règles Markdown
│   │   └── index.ts          # Point d'entrée règles
│   ├── mcp/                  # Configuration MCP server
│   │   ├── server.ts         # Déclaration serveur MCP
│   │   └── tools/            # Outils MCP exposés
│   ├── commands/             # Commandes CLI personnalisées
│   │   ├── register.ts       # Enregistrement commandes
│   │   └── *.ts              # Implémentations
│   ├── settings/             # Paramètres utilisateur
│   │   ├── schema.json       # Schéma de configuration
│   │   └── defaults.yaml     # Valeurs par défaut
│   └── package.json          # Dépendances plugin
```

### 2. Mécanisme Skills (Compétences/actionneurs)

Les skills dans Devin sont des modules TypeScript qui étendent les capacités de l'IDE :

```typescript
// skills/exemple.ts
export const name = "exemple-skill";
export const description = "Effectue des tâches X,Y,Z";

export async function execute(context: SkillContext) {
  // Accès aux outils Devin
  const { files, terminal, api } = context;
  
  // Actions possibles
  await files.read(path);
  await terminal.exec(command);
  await api.call(endpoint);
  
  return { result, metadata };
}
```

**Points d'extension Hephaistos2-kit :**
- `skills/flux/` - Gestionnaires de flux de travail
- `skills/jointes/` - Modules d'intégration jointure
- `skills/binome/` - Compétences de collaboration binôme

### 3. Mécanisme Rules (Règles de comportement)

Les règles définissent les contraintes et guides de comportement pour l'assistant IA :

```markdown
# rules/heuristiques.md
## Directives générales
1. Priorité aux solutions sécurisées
2. Préférence pour les approches incrémentales
3. Documentation obligatoire pour les modifications

## Interdits
- Ne pas modifier les fichiers de configuration système
- Ne pas exécuter de code non vérifié sans confirmation
```

**Déclarations Hephaistos2-kit plugin-side :**
- Règles de formatage de code spécifiques au kit
- Directives d'architecture et patterns à suivre
- Contraintes de sécurité propres au projet

### 4. Mécanisme MCP Server (Model Context Protocol)

Le plugin peut exposer un serveur MCP qui fournit des outils et contexte à l'assistant IA :

```typescript
// mcp/server.ts
import { McpServer } from "@model-context-protocol/server";

const server = new McpServer({
  name: "hephaistos2-kit",
  version: "1.0.0",
});

server.tool("create-file", {
  schema: {
    path: "string",
    content: "string",
  },
  handler: async ({ path, content }) => {
    // Implémentation
    await fs.writeFile(path, content);
    return { success: true };
  },
});

server.tool("run-analysis", {
  schema: {
    target: "string",
  },
  handler: async ({ target }) => {
    // Lancer analyse Hephaistos
    return { result: await hephaistos.analyze(target) };
  },
});
```

**Exposition Hephaistos2-kit :**
- Serveur MCP `hphe` (Hephaistos) pour l'analyse de code
- Outils d'inspection d'architecture
- Points de terminaison de jointure de flux

### 5. Mécanisme Commands (Commandes personnalisées)

Les commandes étendent le palette de commandes de Devin :

```typescript
// commands/create-plugin.ts
import { registerCommand } from "@devin/command-registry";

registerCommand({
  name: "hephaistos:create-skill",
  description: "Crée une nouvelle skill Hephaistos",
  handler: async () => {
    // Scaffold de skill
    const skillPath = await promptForPath();
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(
      path.join(skillPath, "index.ts"),
      getSkillTemplate()
    );
    return { success: true, path: skillPath };
  },
});
```

### 6. Mécanisme Settings (Configuration utilisateur)

Le plugin peut définir des paramètres par défaut et un schéma de configuration :

```json
// settings/schema.json
{
  "type": "object",
  "properties": {
    "hephaistos2": {
      "type": "object",
      "properties": {
        "autoAnalyze": { "type": "boolean", "default": true },
        "analysisDepth": { "type": "integer", "minimum": 1, "maximum": 5, "default": 3 },
        "mcpEndpoint": { "type": "string", "format": "uri" }
      }
    }
  }
}
```

**Configuration Hephaistos2-kit :**
- Point de terminaison MCP par défaut
- Profondeur d'analyse par défaut
- Activation/désactivation des flux automatiques

## Conclusion existante (référence cli-anything-plugin)

D'après l'inspection précédente du fichier `.agent/flux/speckled-inspect.txt` :

> "Le plugin Devin complète les extensions, il ne les remplace pas"
> 
> Le plugin référence est `cli-anything-plugin` situé dans `F:\Promgramation-teste\CLI-Anything`. Il installe :
> - Des compétences d'auto-vérification CLI
> - Des règles de formatage projet-specific
> - Un serveur MCP pour l'inspection de dépendances
> - Des commandes de génération de rapports
> - Des paramètres de configuration utilisateur

## Déclarations plugin-side Hephaistos2-kit

Basé sur l'architecture Hephaistos2-kit, le plugin peut déclarer :

1. **Skills flux** : Modules d'orchestration de workflows multi-étapes
2. **Jointes** : Composants d'intégration avec outils externes
3. **Binôme** : Fonctionnalités de collaboration en temps réel
4. **Rules** : Règles d'architecture et patterns de code
5. **MCP server hphe** : Serveur d'exposition de contexte Hephaistos
6. **Commands** : Scaffolding et génération de composants
7. **Settings** : Préférences d'analyse et de traitement

Cette structure permet une intégration transparente où Hephaistos2-kit s'étend via les mécanismes natifs de Devin sans remplacer l'interface utilisateur existante.
