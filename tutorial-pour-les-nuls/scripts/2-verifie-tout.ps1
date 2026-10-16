<#
.SYNOPSIS
    Verification complete Hephaistos2-Kit — tout tester sans rien casser.
.DESCRIPTION
    Lance tous les tests : indexation, REST, MCP, bridge, regles, binome.
    Pas besoin d'admin.
.EXAMPLE
    pwsh -File 2-verifie-tout.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:ok = 0; $script:warn = 0; $script:fail = 0

function Pass($m) { $script:ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { $script:warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { $script:fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

Step "Test 1/6 — Robot indexation (hphe-indexd)"
$task = schtasks /Query /TN "hphe-indexd" 2>&1
if ($task -match "En cours|Ready|Running") { Pass "hphe-indexd tourne" } else { Fail "hphe-indexd absent ou arrete" }

Step "Test 2/6 — Repondeur REST (port 8792)"
try {
    $r = Invoke-RestMethod "http://127.0.0.1:8792/health" -TimeoutSec 5
    if ($r.status -in @('ok', 'healthy')) { Pass "hphe-rest OK" } else { Warn "hphe-rest repond mais pas ok" }
} catch { Fail "hphe-rest ne repond pas" }

Step "Test 3/6 — Cerveau MCP (hphe-mcp)"
$mcp = Get-Command hphe-mcp.exe -ErrorAction SilentlyContinue
if ($mcp) { Pass "hphe-mcp trouve : $($mcp.Source)" } else { Warn "hphe-mcp pas dans PATH (normal, c'est dans servers\...)" }

Step "Test 4/6 — Bridge WebSocket (port 7477)"
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 7477)
    $tcp.Close()
    Pass "bridge 7477 vivant"
} catch { Fail "bridge 7477 muet — extension orchestrator-monitor pas chargee" }

Step "Test 5/6 — Surfaces de regles"
& pwsh -NoProfile -ExecutionPolicy Bypass -File "$root\.agent\setup\setup-agent-surfaces.ps1" -Verify 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Pass "surfaces conformes" } else { Fail "surfaces non conformes" }

Step "Test 6/6 — Canal binome et extension"
& pwsh -NoProfile -ExecutionPolicy Bypass -File "$root\.agent\setup\install-extension-hub.ps1" -CheckOnly 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Pass "extension + binome OK" } else { Fail "extension ou binome KO" }

Write-Host "`n=== RESULTAT FINAL ===" -ForegroundColor Cyan
Write-Host "OK : $script:ok | Warnings : $script:warn | Echecs : $script:fail"
if ($script:fail -eq 0) { Write-Host "Tout fonctionne !`n" -ForegroundColor Green }
else { Write-Host "Des trucs coincent — va voir 05-quand-ca-marche-pas.md`n" -ForegroundColor Yellow }
exit $script:fail
