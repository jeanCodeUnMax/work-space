' ws-bridge-http.vbs - lance le shim HTTP->WS pour n8n (127.0.0.1:7478 -> ws://127.0.0.1:7477) sans fenetre.
' Endpoints: /health, /v1/sessions, /v1/wake-acp, /v1/wake-devin, /v1/wake-agy, /v1/open-chat
Dim shell, wmi, found
Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\.\root\cimv2")
found = False
For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%ws-bridge-http.mjs%'")
    found = True
Next
If Not found Then
    shell.CurrentDirectory = "C:\data-sys\hephaistos2-kit"
    shell.Run "cmd /c node .agent\scripts\ws-bridge-http.mjs >> .agent\logs\ws-bridge-http.log 2>&1", 0, False
End If
