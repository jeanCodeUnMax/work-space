@echo off
rem Ingestion incrementale automatisee (remplace .agent\scripts\ingest-workspace.ps1)
set HPHE_CONTENT_DIR=C:\Program Files\servers\everything-mcp\data\content-index
set HPHE_VEC_DIR=C:\Program Files\servers\everything-mcp\migrated-vec
"C:\Program Files\servers\everything-mcp\extension\server\hphe-mcp.exe" --tool content_ingest --args "{\"root\":\"C:\Program Files\servers\everything-mcp\",\"project_tag\":\"everything-mcp\"}"
