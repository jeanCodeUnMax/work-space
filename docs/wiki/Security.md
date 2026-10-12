# Security

## Contrôle d'accès filesystem

Deux couches indépendantes, appliquées dans `hphe-mcp` (`AccessPolicy`) :

```
tool call
  └─► check(path, write)
        ├─► EVERYTHING_MCP_ROOTS — allowlist grossière (env, noms conservés compat)
        └─► .mcp-access          — règles fines par profil d'agent
```

`.mcp-access` (racine du projet / cwd du serveur) :

- `[default]` = profil sans `EVERYTHING_MCP_AGENT` → `allow: **` (Devin, Antigravity)
- `[external]` = agents muxés externes → lecture bornée, `deny-write: **`
- Deny prioritaires sur les grants : `.ssh`, `.gnupg`, `.aws`, `.azure`,
  `**/.env*`, `*.pem`, `*.key`, `*credential*`, `id_rsa*`, `token*.json`,
  `secrets.*`, `AppData/**`, `C:/Program Files/Everything/**`

`everything_search` post-filtre aussi ses résultats par la même politique.

## Secrets — règles du repo

- **Jamais de clé dans un fichier commité.** `NVIDIA_API_KEY`,
  `NVIDIA_API_KEY_2`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` vivent en variables
  d'environnement utilisateur (HKCU) — le `.env` ne contient que
  `AGENT_DB_ROOT` + commentaires.
- `.gitignore` : `.env`, `.env.*` (sauf `!.env.example`), `*.pem`, `*.key`,
  `secrets.*`, `credentials.*`, bases `*.db*`, `data/`, `target/`, logs.
- `.ragignore` : filet SAFETY embarqué (`.env`, `*.key/pem/pfx`, `*.db*`,
  `node_modules`, `target`, `_archive/`…) — empêche l'**ingestion** de zones
  sensibles dans l'index Tantivy.
- Avant tout push : scanner les fichiers trackés
  (`nvapi-`, `sk-`, `ghp_`/`gho_`, `AIza`, `AKIA`, `BEGIN … PRIVATE KEY`).

## Surface réseau

- `hphe-rest` écoute `127.0.0.1:8792` uniquement (loopback).
- `ws-bridge` (monitor) : `127.0.0.1:7477`.
- `hphe-indexd` : named pipe local, aucune socket.
- NIM/embeddings sortants vers `integrate.api.nvidia.com` — clé via env.

## Agents dispatchés — règles durcies

- Commandes en argv (`spawn`), jamais `exec`/concaténation shell
  (cf. `orch.rs` `templateToSpawnPlan` / `resolveCmdShim`).
- Pas de script dispatch-capable dans un workspace agent (anti-récursion).
- Livrable = fichier sur disque ; vérification post-run obligatoire.
