@echo off
REM Expose hphe-mcp (stdio) en SSE loopback pour le noeud MCP Client d'n8n.
REM Usage : hphe-mcp-sse.cmd  ->  http://127.0.0.1:8400/sse (+ POST /message)
set "HPHE_VEC_DIR=C:/Program Files/servers/hephaistos2-kit/migrated-vec"
set "HPHE_PIPE=\.\pipe\hphe-index"
set "HPHE_CONTENT_DIR=C:/Program Files/servers/hephaistos2-kit/data/content-index"
set "HPHE_ORCH_DB=C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db"
set "HPHE_MEMORY_ROOT=F:/Sqlite-DB/agentmemory"
set "EVERYTHING_MCP_AGENT=external"
supergateway --stdio "\"C:/Program Files/servers/hephaistos2-kit/extension/server/hphe-mcp.exe\"" --outputTransport sse --port 8400 --host 127.0.0.1 --logLevel info >> "%USERPROFILE%\.n8n\hphe-mcp-sse.log" 2>&1
