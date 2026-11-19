@echo off
rem Demarrage session : n8n en fenetre visible (cmd /k = reste ouverte)
if not exist "C:\data-sys\n8n\packages\cli\bin\n8n" exit /b 1
netstat -ano | findstr /C:":5678 " | findstr LISTENING >nul && exit /b 0
start "n8n" /D "C:\data-sys\n8n" cmd /k "node packages\cli\bin\n8n start"
