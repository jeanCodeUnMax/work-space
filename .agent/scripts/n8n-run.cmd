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
set "N8N_INSTANCE_AI_MODEL=devin-cli-agentic/swe-1-7"
set "N8N_INSTANCE_AI_UTILITY_MODEL=nvidia/deepseek-ai/deepseek-v4.1-flash"
set "N8N_INSTANCE_AI_MODEL_API_KEY=%OMNIROUTE_API_KEY%"
REM Recherche web du assistant : Brave Search API (cle d'environnement, jamais en repo).
set "INSTANCE_AI_BRAVE_SEARCH_API_KEY=%BRAVE_API_KEY%"
n8n.cmd start >> "%USERPROFILE%\.n8n\n8n-run.log" 2>&1
