@echo off
setlocal
cd /d "%~dp0"
echo =====================================================================
echo  CONFIGURATION DUAL-MODE AGENTS DEVIN (ACP + CLI) POUR COLLABORATEUR
echo =====================================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurer-devin-agents.ps1" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERREUR] Le script a rencontre une erreur (%ERRORLEVEL%).
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo Configuration terminee avec succes.
pause
exit /b 0