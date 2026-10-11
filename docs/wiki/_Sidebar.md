### everything-search MCP

*Thin stdio MCP client over the live Everything.exe index — ~15.8M entries, ms latency, zero admin.*

- [[Home]]
- [[Architecture]]
- [[IPC-Protocol]]
- [[Tools-Reference]]
- [[Query-Syntax]]
- [[Security]]
- [[Benchmarks]]
- [[Dev-Guide]]

**Sources**
- `server.py` — MCP registry + JSON-RPC loop
- `everything_ipc.py` — WM_COPYDATA/QUERY2 client
- `fs_tools.py` — fs tools + .mcp-access engine
- `docs/GUIDE.md` — local guide
