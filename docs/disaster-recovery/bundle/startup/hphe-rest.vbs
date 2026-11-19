' hphe-rest.vbs — lance la gateway REST (:8792, sans ingestion) et le worker
' d'ingestion dédié (:8793, hphe-rest-ingest.cmd) sans fenetre. Split 19/11.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest.cmd""", 0, False
sh.Run "cmd /c ""C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-rest-ingest.cmd""", 0, False
