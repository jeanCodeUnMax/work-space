# Passerelle IA unifiee pour n8n (Antigravity, Devin, Ollama Local & Cloud)

## Objectif

Connecter l'agent interne de n8n (`Instance AI` dans `Settings > Assistant`) ainsi que les noeuds LLM des workflows (`AI Agent`, `OpenAI Chat Model`) aux 4 fournisseurs locaux et distants via une passerelle OpenAI-compatible unique :

- **Antigravity / Hermes (`agy/*`)** : `agy/hermes`, `agy/gemini-flash`, `agy/sonnet`, `agy/gpt-oss`
- **Devin (`devin/*`)** : `devin/swe-2-high`, `devin/swe-2-flash-high`, `devin/swe-2-max`, `devin/adaptive`
- **Ollama Local (`ollama-local/*`)** : `ollama-local/devstral:24b`, `ollama-local/gemma4:31b`, `ollama-local/gemma4:12b`, `ollama-local/qwen3.5:4b`
- **Ollama Cloud (`ollama-cloud/*`)** : `ollama-cloud/gpt-oss:120b-cloud`, `ollama-cloud/gemma4:31b-cloud`

---

## Architecture

```text
n8n (http://127.0.0.1:<N8N_PROXY_PORT>)
  |-- Instance AI (credential openAiApi "n8n Assistant model")
  |-- Workflows AI Agent (credential openAiApi "Hephaistos AI Gateway")
  |
  v  OpenAI API (http://127.0.0.1:<N8N_AI_GATEWAY_PORT>/v1)
n8n-ai-gateway.mjs
  |-- agy/*          --> Hub Connect-RPC local Antigravity (agy.exe --hub-port)
  |-- devin/*        --> Devin CLI ACP stdio JSON-RPC (devin acp --model <id>)
  |-- ollama-local/* --> Ollama local (http://127.0.0.1:11434/v1)
  |-- ollama-cloud/* --> Ollama Cloud (https://ollama.com/v1 via .env, sinon Ollama local)
```

### Composants

1. **Variables d'environnement** : copier `.env.example` vers `.env` et renseigner ses propres valeurs (ne jamais commiter ni partager `.env`).
2. **Passerelle (`n8n-ai-gateway.mjs`)** :
   - Ecoute sur `http://127.0.0.1:<N8N_AI_GATEWAY_PORT>` (defaut `11435`).
   - Expose `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (JSON et streaming SSE), `POST /v1/embeddings`.
   - Pont `tool_calls` pour `agy/*` et `devin/*` : serialise les `tools` OpenAI dans le prompt et reconvertit les blocs `<tool_call>...</tool_call>` en `tool_calls` OpenAI standard.
3. **Routage par provider** :
   - **Antigravity (`agy/*`)** : decouvre le hub `agy.exe --hub-port=...`, cree une cascade dediee via `StartCascade` (`CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT`) pour ne pas toucher au chat actif, puis envoie et lit la reponse via Connect-RPC.
   - **Devin (`devin/*`)** : lance `devin acp --model <id>` en stdio JSON-RPC (`initialize` -> `session/new` -> `session/prompt`) et collecte les `agent_message_chunk` (evite les blocages TTY/stdin sous Windows).
   - **Ollama Local / Cloud** : proxy transparent (JSON et SSE) vers `OLLAMA_BASE_URL` ou `OLLAMA_CLOUD_URL` (avec `OLLAMA_CLOUD_API_KEY` lu depuis `.env`).
4. **Configuration n8n** :
   - Dans `Settings > Assistant`, configurer un credential `openAiApi` avec `URL = http://127.0.0.1:11435/v1` et un token local factice (la passerelle ne demande pas de secret externe).
   - Pour les workflows, creer un credential `openAiApi` pointant sur la meme URL.

---

## Verification rapide

```powershell
# Lister les modeles exposes
(Invoke-RestMethod http://127.0.0.1:11435/v1/models).data.id

# Tester un appel
node -e "fetch('http://127.0.0.1:11435/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'agy/hermes',messages:[{role:'user',content:'Dis juste OK'}]})}).then(r=>r.json()).then(d=>console.log(d.choices[0].message.content))"
```
