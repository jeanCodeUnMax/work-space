@echo off
rem Hephaistos REST gateway - SANS boucle d'ingestion (split anti-gel 19/11).
rem L'ingestion tourne dans hphe-rest-ingest.cmd (:8793) pour que /health
rem ne gele jamais pendant un cycle d'ingestion.
rem Securise (revue) : profil d'acces [rest] borne + roots + auth token.
set HPHE_INSTALL_ROOT=%~dp0..\..
if not defined HPHE_CONTENT_DIR set HPHE_CONTENT_DIR=%HPHE_INSTALL_ROOT%\data\content-index
if not defined HPHE_VEC_DIR set HPHE_VEC_DIR=%HPHE_INSTALL_ROOT%\migrated-vec
if not defined HPHE_ORCH_DB set HPHE_ORCH_DB=%HPHE_INSTALL_ROOT%\data\orchestrator.db
if not defined HPHE_MEMORY_ROOT set HPHE_MEMORY_ROOT=%HPHE_INSTALL_ROOT%\data\agentmemory
set HPHE_INGEST_ROOTS=
set HPHE_INGEST_SCAN=
if not defined EVERYTHING_MCP_ACCESS_FILE set EVERYTHING_MCP_ACCESS_FILE=%~dp0.mcp-access
if not defined EVERYTHING_MCP_ROOTS set EVERYTHING_MCP_ROOTS=%HPHE_INSTALL_ROOT%;%CD%
:loop
"%~dp0hphe-rest.exe" --addr 127.0.0.1:8792 --profile rest >> "%HPHE_INSTALL_ROOT%\data\hphe-rest.log" 2>&1
echo %DATE% %TIME% hphe-rest termine - relance dans 10s >> "%HPHE_INSTALL_ROOT%\data\hphe-rest.log"
timeout /t 10 /nobreak >nul
goto loop
