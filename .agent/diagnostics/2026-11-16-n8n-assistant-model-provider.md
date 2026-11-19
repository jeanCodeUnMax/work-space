# n8n Assistant (Instance AI) — Modele & connexion

_Date : 2026-11-16 — Devin / SWAT Hephaistos_

## Configuration active (`C:/data-sys/n8n/.env`)

```env
N8N_INSTANCE_AI_MODEL         = custom/devin/swe-2-high
N8N_INSTANCE_AI_MODEL_URL     = http://127.0.0.1:11435/v1
N8N_INSTANCE_AI_MODEL_API_KEY = <cle de la gateway>
```

## Modele utilise

**`devin/swe-2-high`** — l'assistant n8n parle avec **Devin CLI** comme LLM.

Le prefixe `custom/` signifie : endpoint OpenAI-compatible externe (pas un
provider natif Anthropic/OpenAI). La partie envoyee en amont est
`devin/swe-2-high`.

## Chaine de connexion

```
n8n Assistant (Instance AI)
   |  POST http://127.0.0.1:11435/v1/chat/completions
   |  Authorization: Bearer <N8N_INSTANCE_AI_MODEL_API_KEY>
   |  model: "devin/swe-2-high"
   v
n8n-ai-gateway.mjs  (hephaistos2-kit/.agent/scripts)
   |  routage par prefixe : devin/* | agy/* | ollama-local|cloud/*
   v
Devin CLI headless :  devin -p --model swe-2-high
   |
   v
reponse streamee au format OpenAI  -->  retour a l'Assistant
```

## Modeles exposes par la gateway (:11435)

| Prefixe        | Backend                              | Modeles vus                        |
|----------------|--------------------------------------|------------------------------------|
| `devin/*`      | Devin CLI headless                   | swe-2-high, swe-2-flash-high, swe-2-max, adaptive |
| `agy/*`        | Antigravity / Hermes (hub local)     | hermes, gemini-flash, sonnet, gpt-oss |
| `ollama-local/*` | Ollama local :11434                | modeles locaux                     |
| `ollama-cloud/*` | Ollama Cloud (ou local -cloud)     | modeles -cloud                     |

Changer de cerveau = changer le modele : `custom/agy/sonnet`,
`custom/ollama-local/<modele>` — meme endpoint, autre route.

## Incident du soir & fix permanent

- **Symptome** : `AI_APICallError: connect ECONNREFUSED 127.0.0.1:11435`
- **Cause** : la gateway :11435 etait morte (processus lance a la main,
  non supervise).
- **Fix** : relancee + ajoutee au watchdog `hphe-watchdog` (tache planifiee,
  toutes les 10 min). Check `/v1/models` -> relance auto.

## Couverture watchdog (7 services)

| Service             | Port   | Check         |
|---------------------|--------|---------------|
| hphe-indexd         | tache  | etat task     |
| REST hphe-rest      | :8792  | /health       |
| ws-hub              | :7477  | TCP           |
| mux MCP             | :5682  | TCP           |
| shim /ask           | :7478  | TCP           |
| OmniRoute           | :20128 | TCP           |
| n8n                 | :5678  | /healthz      |
| n8n-ai-gateway      | :11435 | /v1/models    |

Log : `%USERPROFILE%\.hephaistos\logs\watchdog.log`
Force check : `powershell -NoProfile -ExecutionPolicy Bypass -File ~/.hephaistos/scripts/hphe-watchdog.ps1`
