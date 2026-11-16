@echo off
REM Lance n8n hors contexte MSYS : corrige les vars converties par Git Bash.
set "N8N_PUBLIC_API_ENDPOINT=/api"
REM Fallback disque Obsidian Hub : autorise fs/path dans les noeuds Code.
set "NODE_FUNCTION_ALLOW_BUILTIN=fs,path,os"
REM n8n Assistant (instance-ai) : LLM via OmniRoute local (gateway :20128).
REM Pool de 437 modeles (nvidia, openrouter, groq, mistral, gemini, ollama-cloud,
REM huggingface, aihorde, pollinations, kilo-gateway...) avec auto-fallback.
set "N8N_INSTANCE_AI_ENABLED=true"
set "N8N_INSTANCE_AI_MODEL_URL=http://127.0.0.1:20128/v1"
set "N8N_INSTANCE_AI_MODEL=auto"
set "N8N_INSTANCE_AI_UTILITY_MODEL=auto"
set "N8N_INSTANCE_AI_MODEL_API_KEY=%OMNIROUTE_API_KEY%"
REM Busqueda web del assistant: Brave Search API (clave de entorno, nunca en repo).
set "INSTANCE_AI_BRAVE_SEARCH_API_KEY=%BRAVE_API_KEY%"
n8n.cmd start >> "%USERPROFILE%\.n8n\n8n-run.log" 2>&1
