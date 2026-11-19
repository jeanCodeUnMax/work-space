' run-hidden.vbs "<commande complete>" — lance une commande sans aucune fenetre console.
' Usage : wscript.exe //nologo run-hidden.vbs "cmd /c ""C:\chemin\script.bat"""
Dim cmd
cmd = WScript.Arguments(0)
CreateObject("WScript.Shell").Run cmd, 0, False
