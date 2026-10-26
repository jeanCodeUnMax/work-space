# kit-health.ps1 — Checks de santé du kit Hephaistos2
# Exit code 0 si tout OK, 1 sinon.
# Vérifie : hphe-mcp.exe, pipe hphe-index, extensions, plugin, roster, comms.jsonl, port 7477.

param()

$ok = $true
$report = @()

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $report += [pscustomobject]@{
    Name = $Name
    Passed = $Passed
    Detail = $Detail
  }
  if (-not $Passed) { $ok = $false }
}

# 1. hphe-mcp.exe présent + version
try {
  $path = Join-Path $env:ProgramFiles 'Projet-complet\hephaistos2-kit\hphe-mcp.exe'
  if (Test-Path $path) {
    $ver = (Get-Item $path).VersionInfo.FileVersion
    Add-Check "hphe-mcp.exe" $true "Version $ver"
  } else {
    Add-Check "hphe-mcp.exe" $false "Introuvable à $path"
  }
} catch {
  Add-Check "hphe-mcp.exe" $false "Erreur $_"
}

# 2. Pipe hphe-index joignable (stdin/stdout via mcp)
try {
  # Essai de connexion rapide via stdio ; ici on teste juste que le processus peut démarrer
  $process = & 'C:\Program Files\Projet-complet\hephaistos2-kit\hphe-mcp.exe' tools/list 2>&1
  if ($?) { Add-Check "Pipe hphe-index" $true "Réponse obtenue" }
  else { Add-Check "Pipe hphe-index" $false "Pas de réponse"; $process.Close() }
} catch {
  Add-Check "Pipe hphe-index" $false "Erreur $_"
}

# 3. Extensions dans ~/.devin/extensions
$extPath = "$env:HOME/.devin/extensions"
if (Test-Path $extPath) {
  $extCount = (Get-ChildItem $extPath | Measure-Object).Count
  Add-Check "Extensions ~/.devin/extensions" $true "$extCount extension(s) trouvées"
} else {
  Add-Check "Extensions ~/.devin/extensions" $false "Dossier introuvable"
}

# 4. Plugin dans plugins/lock.json
$pluginPath = "plugin-devin/manifest.json"
if (Test-Path $pluginPath) {
  Add-Check "Plugin manifest.json" $true "Fichier présent"
} else {
  Add-Check "Plugin manifest.json" $false "Introuvable"
}

# 5. Roster lisible
$rosterPath = ".agent/agent-bridge/workspace-roster.json"
if (Test-Path $rosterPath) {
  Add-Check "Roster workspace-roster.json" $true "Fichier présent"
} else {
  Add-Check "Roster workspace-roster.json" $false "Introuvable"
}

# 6. comms.jsonl existe
$commsPath = ".agent/comms.jsonl"
if (Test-Path $commsPath) {
  Add-Check "Comms .agent/comms.jsonl" $true "Fichier présent"
} else {
  Add-Check "Comms .agent/comms.jsonl" $false "Introuvable"
}

# 7. Port 7477 (bridge Neo4j/agent-bridge)
try {
  $tcp = New-Object System.Net.Sockets.TcpClient '127.0.0.1', 7477
  $tcp.Close()
  Add-Check "Port 7477" $true "Port ouvert"
} catch {
  Add-Check "Port 7477" $false "Port fermé ou inaccessible"
}

# Rapport
Write-Host "=== RAPPORT DE SANTÉ DU KIT ==="
$report | ForEach-Object {
  $tag = if ($_.Passed) { 'OK' } else { 'FAIL' }
  Write-Host ("[{0}] {1} — {2}" -f $tag, $_.Name, $_.Detail)
}

if ($ok) {
  Write-Host "Santé : TOUT OK"
  exit 0
} else {
  Write-Host "Santé : CERTAINS CHECKS ÉCHOUÉS"
  exit 1
}