@echo off
rem bridge-api : passerelle HTTP -> ws-bridge pour n8n et clients REST.
rem Lancee par la tache planifiee hphe-bridge-api au logon.
cd /d "%~dp0..\.."
start "" /min "C:\nvm4w\nodejs\node.exe" "%~dp0bridge-api.mjs"
