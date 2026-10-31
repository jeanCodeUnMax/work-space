---
name: n8n
description: Piloter l'instance n8n locale (workflows, exécutions, credentials, webhooks) via le proxy auth 5680, le harness cli-anything-n8n ou l'API REST. Use when n8n, workflow automation, exécution n8n, webhook n8n, ou intégration extension hephaistos-chats.
triggers:
  - n8n
  - /n8n
  - workflow n8n
  - n8n workflow
  - webhook n8n
---

Piloter n8n local — `C:\data-sys\n8n` (monorepo v2.46, `packages/cli/bin/n8n`).

## Chaîne de connexion (obligatoire)

- **UI/iframe extension** : `http://127.0.0.1:5680` — proxy auth (`hephaistos2-kit/.agent/scripts/n8n-auth-proxy.mjs`), injecte le cookie de session → pas de /signin. Routes `/ctl/*` → `/rest/*` pour agents.
- **Backend brut** : `http://127.0.0.1:5678` — API `/rest/*` et `/api/v1` (clé API en `X-N8N-API-KEY`).
- **Démarrage** : bouton n8n de l'extension (terminal visible) ou `node packages/cli/bin/n8n start` depuis `C:\data-sys\n8n`. Premier boot jusqu'à ~90 s.

## CLI-Anything (recommandé, 55+ cmd)

```bash
cd C:\data-sys\CLI-Anything\n8n\agent-harness
python -m cli_anything.n8n --url http://127.0.0.1:5680 health
python -m cli_anything.n8n --url http://127.0.0.1:5680 workflow list --json
python -m cli_anything.n8n --url http://127.0.0.1:5680 workflow get <id> --json
python -m cli_anything.n8n --url http://127.0.0.1:5680 workflow activate <id>
python -m cli_anything.n8n --url http://127.0.0.1:5680 execution list --limit 10
python -m cli_anything.n8n --url http://127.0.0.1:5680 template search "<mot-clé>"
```

Groupes : `workflow`, `execution`, `credential`, `tag`, `variable`, `template`, `node`, `health`, `status`, `config`, `expression`, `completions`.

## API REST directe

```bash
curl http://127.0.0.1:5680/ctl/workflows            # équivalent /rest/workflows authentifié
curl http://127.0.0.1:5680/api/v1/workflows         # API publique v1
```

## CLI officiel (option)

```bash
npx @n8n/cli --url=http://127.0.0.1:5680 workflow list
```

## Règles

- Jamais d'appel direct à `:5678` sans clé API — passer par `:5680`.
- Ne jamais révéler `N8N_EMAIL`/`N8N_PASSWORD` (`.env` workspace, gitignored).
- Workflows prod : activer avant que le webhook production réponde ; URL test via "Listen for test event".
- Doc complète : `Documentation/n8n/` du vault (README, workflows, data-expressions, api-cli-mcp, advanced-patterns, local-setup) ou `https://docs.n8n.io`.
