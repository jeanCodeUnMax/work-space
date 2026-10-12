$pids = 39484,46012,42660,49412,45744,20788,2684
Write-Output "---- t0 ----"
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { Write-Output ("PID {0} : CPU={1}s WS={2}MB" -f $p, $proc.CPU, [int]($proc.WorkingSet64/1MB)) }
}
Start-Sleep -Seconds 5
Write-Output "---- t+5s ----"
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { Write-Output ("PID {0} : CPU={1}s WS={2}MB" -f $p, $proc.CPU, [int]($proc.WorkingSet64/1MB)) }
}
Write-Output "---- enfants sqlite3 / process fils des pwsh ----"
Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ParentProcessId } | ForEach-Object {
  $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0,[Math]::Min(120,$_.CommandLine.Length)) } else { '(no cmdline)' }
  Write-Output ("PID {0} (parent {1}) {2} : {3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $cmd)
}
