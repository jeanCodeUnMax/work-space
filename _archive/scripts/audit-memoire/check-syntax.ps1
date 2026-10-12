foreach ($f in 'F:\Promgramation-teste\Hephaistos-Kit\.agent\scripts\ingest-workspace.ps1','F:\Promgramation-teste\Hephaistos-Kit\.agent\scripts\start-workspace.ps1','F:\Promgramation-teste\Hephaistos-Kit\.agent\scripts\memory-maintenance.ps1') {
  $errs = $null
  $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $f -Raw), [ref]$errs)
  Write-Output ("{0} : {1} erreur(s)" -f (Split-Path $f -Leaf), $errs.Count)
  $errs | ForEach-Object { Write-Output ("  " + $_.Message) }
}
