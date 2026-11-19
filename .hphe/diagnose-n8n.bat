@echo off
echo ========================================
echo DIAGNOSTIC n8n via cli-anything-n8n
echo ========================================
echo.
echo [1/3] cli-anything-n8n status
cli-anything-n8n status
echo.
echo [2/3] cli-anything-n8n health
cli-anything-n8n health
echo.
echo [3/3] cli-anything-n8n config test
cli-anything-n8n config test
echo.
echo ========================================
echo TERMINE - Copie-colle cette sortie ici
echo ========================================
pause