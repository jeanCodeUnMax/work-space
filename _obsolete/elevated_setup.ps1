# Runs elevated: registers the EverythingMcpIndex scheduled task and does a
# first index build right away. Output goes to setup.log for verification.
$ErrorActionPreference = 'Continue'
$py = "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe"
$script = "C:\Program Files\Everything\everything-mcp\build_index.py"
$log = "C:\Program Files\Everything\everything-mcp\setup.log"

"=== elevated setup $(Get-Date) ===" | Out-File $log -Encoding utf8

schtasks /create /tn "EverythingMcpIndex" /tr "`"$py`" `"$script`"" /sc minute /mo 15 /rl HIGHEST /f *>> $log

& $py $script *>> $log

"=== done ===" | Out-File $log -Append -Encoding utf8
