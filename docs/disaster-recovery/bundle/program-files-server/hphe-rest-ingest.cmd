@echo off
rem Hephaistos ingest worker dedie (split 19/11) - isole le gel d'ingestion
rem de la gateway :8792. Ecoute :8793 (port libre, meme toolset).
set HPHE_INSTALL_ROOT=%~dp0..\..
if not defined HPHE_CONTENT_DIR set HPHE_CONTENT_DIR=%HPHE_INSTALL_ROOT%\data\content-index
if not defined HPHE_VEC_DIR set HPHE_VEC_DIR=%HPHE_INSTALL_ROOT%\migrated-vec
if not defined HPHE_ORCH_DB set HPHE_ORCH_DB=%HPHE_INSTALL_ROOT%\data\orchestrator.db
if not defined HPHE_MEMORY_ROOT set HPHE_MEMORY_ROOT=%HPHE_INSTALL_ROOT%\data\agentmemory
if not defined HPHE_INGEST_ROOTS set HPHE_INGEST_ROOTS=C:\data-sys\hephaistos2-kit
if not defined HPHE_INGEST_SCAN set HPHE_INGEST_SCAN=C:\data-sys\hephaistos2-kit
if not defined HPHE_INGEST_INTERVAL_S set HPHE_INGEST_INTERVAL_S=900
if not defined EVERYTHING_MCP_ACCESS_FILE set EVERYTHING_MCP_ACCESS_FILE=%~dp0.mcp-access
if not defined EVERYTHING_MCP_ROOTS set EVERYTHING_MCP_ROOTS=%HPHE_INSTALL_ROOT%;%CD%
:loop
"%~dp0hphe-rest.exe" --addr 127.0.0.1:8793 --profile rest >> "%HPHE_INSTALL_ROOT%\data\hphe-rest-ingest.log" 2>&1
echo %DATE% %TIME% hphe-rest-ingest termine - relance dans 10s >> "%HPHE_INSTALL_ROOT%\data\hphe-rest-ingest.log"
timeout /t 10 /nobreak >nul
goto loop
