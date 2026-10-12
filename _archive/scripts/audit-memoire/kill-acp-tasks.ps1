# Tue les process lances par la task acp-backup "Auto-Ingest Workspace"
# (le kit est le seul detenteur legitime de l'ingestion).

# 1) Le pont REST spawne par acp-backup (PID 44556 identifie dans son log)
$acpBridge = Get-CimInstance Win32_Process -Filter "ProcessId=44556" -ErrorAction SilentlyContinue
if ($acpBridge) { Stop-Process -Id 44556 -Force; Write-Output "pont acp (44556) tue" }

# 2) Tout pwsh/powershell/sqlite3/node dont la cmdline mentionne acp-backup .agent scripts
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'acp-backup[\\/]+\.agent[\\/]+scripts'
}
foreach ($p in $targets) {
  Write-Output ("kill {0} ({1}) : {2}" -f $p.ProcessId, $p.Name, $p.CommandLine.Substring(0,[Math]::Min(120,$p.CommandLine.Length)))
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $targets) { Write-Output "aucun process acp .agent restant" }

# 3) Verification ports
Start-Sleep -Seconds 1
netstat -ano | Select-String ":8001|:8002" | Select-String "LISTEN"
