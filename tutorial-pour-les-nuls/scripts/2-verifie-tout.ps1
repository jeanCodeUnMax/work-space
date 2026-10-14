<#
.SYNOPSIS
    Verification complete Hephaistos2-Kit — tout tester sans rien casser.
.DESCRIPTION
    Lance tous les tests : indexation, REST, MCP, bridge, regles, binome.
    Pas besoin d'etre administrateur.
.EXAMPLE
    pwsh -File 2-verifie-tout.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "$root\install.ps1")) {
    $root = "C:\Program Files\Projet-complet\hephaistos2-kit"
}

$script:ok = 0; $script:warn = 0; $script:fail = 0

function Pass($m) { $script:ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { $script:warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { $script:fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

Step "Test 1/6 — Robot indexation (hphe-indexd)"
$task = schtasks /Query /TN "hphe-indexd" 2>&1
if ($task -match "En cours|Ready|Running|Prêt|Pret") {
    Pass "hphe-indexd tourne en tâche planifiée"
} else {
    Fail "hphe-indexd absent ou arrete (relancer: install.ps1 -Elevated -SkipBuild)"
}

Step "Test 2/6 — Repondeur REST (port 8792)"
try {
    $r = Invoke-RestMethod "http://127.0.0.1:8792/health" -TimeoutSec 5
    if ($r.status -in @("ok", "healthy")) {
        Pass "hphe-rest OK (status: $($r.status))"
    } else {
        Warn "hphe-rest repond mais status = $($r.status)"
    }
} catch {
    Fail "hphe-rest ne repond pas sur http://127.0.0.1:8792"
}

Step "Test 3/6 — Cerveau MCP (hphe-mcp)"
$mcpCandidates = @(
    "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe",
    "$root\extension\server\hphe-mcp.exe",
    (Get-Command hphe-mcp.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
)
$mcpExe = $mcpCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($mcpExe) {
    & $mcpExe --tool hphe_health 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Pass "hphe-mcp operationnel et connecte au daemon"
    } else {
        Pass "hphe-mcp executable trouve : $mcpExe"
    }
} else {
    Fail "hphe-mcp.exe introuvable (executer 1-installe-moi.ps1)"
}

Step "Test 4/6 — Bridge WebSocket (port 7477)"
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 7477)
    $tcp.Close()
    Pass "bridge WS 7477 vivant (orchestrator-monitor actif)"
} catch {
    Fail "bridge 7477 muet — extension orchestrator-monitor pas chargee dans Devin"
}

Step "Test 5/6 — Surfaces de regles"
$surfScript = "$root\.agent\setup\setup-agent-surfaces.ps1"
if (Test-Path $surfScript) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $surfScript -Verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Pass "surfaces conformes (Devin CLI, Devin IDE, Windsurf, Antigravity)"
    } else {
        Fail "surfaces non conformes (relancer: pwsh -File .agent\setup\setup-agent-surfaces.ps1)"
    }
} else {
    Fail "script surfaces introuvable : $surfScript"
}

Step "Test 6/6 — Canal binome et extension"
$extScript = "$root\.agent\setup\install-extension-hub.ps1"
if (Test-Path $extScript) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $extScript -CheckOnly 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Pass "extension monitor >= 0.0.53 + IDs binome publies dans comms.jsonl"
    } else {
        Fail "extension monitor ou canal binome incomplet"
    }
} else {
    Fail "script extension introuvable : $extScript"
}

Write-Host "`n=== RESULTAT FINAL ===" -ForegroundColor Cyan
Write-Host "OK : $script:ok | Avertissements : $script:warn | Echecs : $script:fail"
if ($script:fail -eq 0) {
    Write-Host "Tout fonctionne a la perfection !`n" -ForegroundColor Green
} else {
    Write-Host "Des points bloquent — consulte 05-quand-ca-marche-pas.md`n" -ForegroundColor Yellow
}
exit $script:fail
