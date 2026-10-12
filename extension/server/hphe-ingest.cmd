@echo off
rem Ingestion incrementale automatisee (remplace .agent\scripts\ingest-workspace.ps1)
set HPHE_CONTENT_DIR=C:\Program Files\servers\hephaistos2-kit\data\content-index
set HPHE_VEC_DIR=C:\Program Files\servers\hephaistos2-kit\migrated-vec
"C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe" --tool content_ingest --args "{\"root\":\"C:\Program Files\servers\hephaistos2-kit\",\"project_tag\":\"hephaistos2-kit\"}"
