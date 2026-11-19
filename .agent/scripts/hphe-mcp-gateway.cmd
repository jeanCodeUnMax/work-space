@echo off
rem hphe-mcp-gateway — supergateway :8767 (stdio mcp-mux -> MCP Streamable HTTP)
rem Relance au boot via Startup\hphe-mcp-gateway.vbs. Log: .agent\mcp-gateway.log
set MSYS_NO_PATHCONV=1
cd /d "C:\Program Files\Projet-complet\hephaistos2-kit"
npx -y supergateway --stdio "node C:/Users/Administrator/AppData/Roaming/npm/node_modules/mcp-mux/src/shim.mjs --config C:/Users/Administrator/.config/mcp-mux/mcp-mux.json" --outputTransport streamableHttp --port 8767 --host 127.0.0.1 --streamableHttpPath /mcp --healthEndpoint /healthz --logLevel info >> "C:\Program Files\Projet-complet\hephaistos2-kit\.agent\mcp-gateway.log" 2>&1
