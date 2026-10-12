@echo off
rem Hephaistos REST gateway + boucle d'ingestion automatisee
set HPHE_CONTENT_DIR=C:\Program Files\servers\hephaistos2-kit\data\content-index
set HPHE_VEC_DIR=C:\Program Files\servers\hephaistos2-kit\migrated-vec
set HPHE_ORCH_DB=C:\Program Files\servers\hephaistos2-kit\data\orchestrator.db
set HPHE_MEMORY_ROOT=F:\Sqlite-DB\agentmemory
set HPHE_INGEST_ROOTS=C:\Program Files\servers\hephaistos2-kit
set HPHE_INGEST_INTERVAL_S=900
"C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.exe" --addr 127.0.0.1:8792 >> "C:\Program Files\servers\hephaistos2-kit\data\hphe-rest.log" 2>&1
