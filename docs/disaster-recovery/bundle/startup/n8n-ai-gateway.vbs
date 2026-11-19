' n8n-ai-gateway.vbs - lance la passerelle OpenAI-compatible n8n (127.0.0.1:11435) sans fenetre.
' Routes: agy/*, devin/*, ollama-local/*, ollama-cloud/*
Dim shell, fso, wmi, found
Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\.\root\cimv2")
found = False
For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%n8n-ai-gateway.mjs%'")
    found = True
Next
If Not found Then
    shell.CurrentDirectory = "C:\data-sys\hephaistos2-kit"
    shell.Run "cmd /c node .agent\scripts\n8n-ai-gateway.mjs >> .agent\logs\n8n-ai-gateway.log 2>&1", 0, False
End If
