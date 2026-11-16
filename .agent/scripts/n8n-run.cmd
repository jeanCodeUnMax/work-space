@echo off
REM Lance n8n hors contexte MSYS : corrige les vars converties par Git Bash.
set "N8N_PUBLIC_API_ENDPOINT=/api"
n8n.cmd start >> "%USERPROFILE%\.n8n\n8n-run.log" 2>&1
