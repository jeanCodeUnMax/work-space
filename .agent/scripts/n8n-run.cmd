@echo off
REM Lance n8n hors contexte MSYS : corrige les vars converties par Git Bash.
set "N8N_PUBLIC_API_ENDPOINT=/api"
REM Fallback disque Obsidian Hub : autorise fs/path dans les noeuds Code.
set "NODE_FUNCTION_ALLOW_BUILTIN=fs,path,os"
REM n8n Assistant (instance-ai) : LLM via OmniRoute local (gateway :20128).
REM Pool de 2202 modeles (nvidia, openrouter, groq, mistral, gemini, ollama-cloud,
REM huggingface, aihorde, pollinations, kilo-gateway, devin-cli-agentic...).
REM Modele principal : Devin CLI (swe-1-7) via le bridge ACP OmniRoute (dva/*).
REM Utilitaire : deepseek-v4.1-flash gratuit via le pool nvidia.
set "N8N_INSTANCE_AI_ENABLED=true"
set "N8N_INSTANCE_AI_MODEL_URL=http://127.0.0.1:20128/v1"
REM Le provider doit etre 'custom' (endpoint OpenAI-compatible) : n8n envoie
REM tout ce qui suit le 1er '/' comme nom de modele a OmniRoute, qui resout
REM ensuite son propre provider (devin-cli-agentic, nvidia...).
set "N8N_INSTANCE_AI_MODEL=custom/devin-cli-agentic/swe-1-7"
set "N8N_INSTANCE_AI_UTILITY_MODEL=custom/nvidia/deepseek-ai/deepseek-v4.1-flash"
set "N8N_INSTANCE_AI_MODEL_API_KEY=%OMNIROUTE_API_KEY%"
REM Recherche web du assistant : Brave Search API (cle d'environnement, jamais en repo).
set "INSTANCE_AI_BRAVE_SEARCH_API_KEY=%BRAVE_API_KEY%"
REM Sandbox : service local n8n-sandbox-local (:18080) - executions sur l'hote,
REM NON isolees (pas de Docker). Cle lue depuis api-key.txt, jamais en dur.
for /f "usebackq delims=" %%k in ("C:\Program Files\servers\n8n-sandbox-local\api-key.txt") do set "N8N_SANDBOX_SERVICE_API_KEY=%%k"
set "N8N_SANDBOX_SERVICE_URL=http://127.0.0.1:18080"
set "N8N_INSTANCE_AI_SANDBOX_ENABLED=true"
set "N8N_INSTANCE_AI_SANDBOX_PROVIDER=n8n-sandbox"
REM Ops & Business Suite : re-application du patch UI (ecrase par les mises a jour npm).
set "OPS_DIST=%APPDATA%\npm\node_modules\n8n\node_modules\n8n-editor-ui\dist"
if exist "%OPS_DIST%\index.html" (
  copy /y "C:\Program Files\servers\n8n-ops-suite\ops-menu.js" "%OPS_DIST%\static\ops-menu.js" >nul 2>&1
  findstr /c:"ops-menu.js" "%OPS_DIST%\index.html" >nul || powershell -NoProfile -Command "(Get-Content '%OPS_DIST%\index.html' -Raw).Replace('</body>', '<script src="/static/ops-menu.js?v=2"></script></body>') | Set-Content '%OPS_DIST%\index.html' -NoNewline"
)
n8n.cmd start >> "%USERPROFILE%\.n8n\n8n-run.log" 2>&1
