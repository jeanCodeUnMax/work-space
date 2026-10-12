$pids = 44556,37716,42980,44516,38864,33292,13712,2684,28532
Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ProcessId } | ForEach-Object {
  $cmd = if ($_.CommandLine) { $_.CommandLine } else { '(no cmdline)' }
  if ($cmd.Length -gt 170) { $cmd = $cmd.Substring(0,170) }
  Write-Output ("PID {0} : {1}" -f $_.ProcessId, $cmd)
}
