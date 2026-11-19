' mcp-mux-http-bridge.vbs - lance le bridge HTTP/SSE mcp-mux (127.0.0.1:5682) sans fenetre.
Dim shell, wmi, found
Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\.\root\cimv2")
found = False
For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%mcp-mux-http-bridge.mjs%'")
    found = True
Next
If Not found Then
    shell.CurrentDirectory = "C:\data-sys\n8n"
    shell.Run "cmd /c node .agent\scripts\mcp-mux-http-bridge.mjs >> .agent\logs\mcp-mux-http-bridge.log 2>&1", 0, False
End If
