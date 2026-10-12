# Runs elevated: registers EverythingMcpIndex (rebuild/deltas every 15 min).
$ErrorActionPreference = 'Stop'
$py = "C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe"
$script = "C:\Program Files\Everything\everything-mcp\build_index.py"
$log = "C:\Program Files\Everything\everything-mcp\task.log"

try {
    $action = New-ScheduledTaskAction -Execute $py -Argument "`"$script`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 15) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME `
        -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName "EverythingMcpIndex" -Action $action `
        -Trigger $trigger -Principal $principal -Force | Out-Null
    "task registered OK" | Out-File $log -Encoding utf8
} catch {
    "task registration FAILED: $_" | Out-File $log -Encoding utf8
}
