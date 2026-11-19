' n8n-ops-suite.vbs - lance n8n Ops & Business Suite (127.0.0.1:5683) sans fenetre.
Dim shell, wmi, found
Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\.\root\cimv2")
found = False
For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%n8n-ops-suite.mjs%'")
    found = True
Next
If Not found Then
    shell.CurrentDirectory = "C:\data-sys\n8n"
    shell.Run "cmd /c node .agent\scripts\n8n-ops-suite.mjs >> .agent\logs\n8n-ops-suite.log 2>&1", 0, False
End If
