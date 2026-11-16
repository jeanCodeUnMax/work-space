@echo off
REM Lance n8n hors contexte MSYS : corrige les vars converties par Git Bash.
set "N8N_PUBLIC_API_ENDPOINT=/api"
REM Fallback disque Obsidian Hub : autorise fs/path dans les noeuds Code.
set "NODE_FUNCTION_ALLOW_BUILTIN=fs,path,os"
REM n8n Assistant (instance-ai) : LLM via NVIDIA NIM (endpoint OpenAI-compatible, gratuit).
set "N8N_INSTANCE_AI_ENABLED=true"
set "N8N_INSTANCE_AI_MODEL_URL=https://integrate.api.nvidia.com/v1"
set "N8N_INSTANCE_AI_MODEL=deepseek-ai/deepseek-v4.1-flash"
set "N8N_INSTANCE_AI_UTILITY_MODEL=openai/gpt-oss-20b"
set "N8N_INSTANCE_AI_MODEL_API_KEY=%NVIDIA_API_KEY%"
n8n.cmd start >> "%USERPROFILE%\.n8n\n8n-run.log" 2>&1
