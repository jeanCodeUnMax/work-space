$act = New-ScheduledTaskAction -Execute 'C:\Program Files\Projet-complet\hephaistos2-kit\.agent\scripts\n8n-run.cmd'
$trg = New-ScheduledTaskTrigger -AtLogOn
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Register-ScheduledTask -TaskName 'hphe-n8n' -Action $act -Trigger $trg -Settings $set -Force | Out-Null
Start-ScheduledTask -TaskName 'hphe-n8n'
Start-Sleep 30
try { (Invoke-WebRequest -Uri 'http://127.0.0.1:5678/healthz' -UseBasicParsing -TimeoutSec 10).StatusCode } catch { "healthz KO: $($_.Exception.Message)" }
