param(
    [string]$ExpectedVersion = '0.0.54',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ext  = Join-Path $root 'extensions\orchestrator-monitor'
$script:ok = 0; $script:warn = 0; $script:fail = 0
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Pass($m) { $script:ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { $script:warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { $script:fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }

if (-not $CheckOnly) {
    Step '[1/6] Build orchestrator-monitor (npm i + tsc + vsce)'
    Push-Location $ext
    $vsix = $null
    try {
        if (-not (Test-Path 'node_modules')) { npm install | Out-Null }
        npm run compile 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { Pass 'tsc compile OK' } else { Fail 'tsc a echoue'; Pop-Location; exit 1 }
        npx --yes @vscode/vsce package 2>&1 | Out-Null
        $vsix = Get-ChildItem *.vsix | Sort-Object { [version]($_.BaseName -replace '.*-','') } | Select-Object -Last 1
        if ($vsix) { Pass "VSIX produit : $($vsix.Name)" } else { Fail 'pas de .vsix produit'; Pop-Location; exit 1 }
    } finally { Pop-Location }

    Step '[2/6] Installation du VSIX'
    $installed = $false
    foreach ($cli in @('code', 'devin', 'windsurf')) {
        $cmd = Get-Command $cli -ErrorAction SilentlyContinue
        if ($cmd) {
            & $cli --install-extension "$($vsix.FullName)" --force 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Pass "installe via '$cli --install-extension' - RELOAD la fenetre (Ctrl+Shift+P -> Developer: Reload Window)"
                $installed = $true; break
            }
        }
    }
    if (-not $installed) { Warn "aucun CLI IDE trouve - installer a la main : palette 'Extensions: Install from VSIX...' -> $($vsix.FullName)" }
} else {
    Step '[1/6] Build & Install - sautes (-CheckOnly)'
}

Step '[3/6] Version extension installee vs attendue'
$extDirs = @()
$extDirs += Get-ChildItem "$env:USERPROFILE\.devin\extensions\hephaistos.orchestrator-monitor-*" -ErrorAction SilentlyContinue
$extDirs += Get-ChildItem "$env:USERPROFILE\.vscode\extensions\hephaistos.orchestrator-monitor-*" -ErrorAction SilentlyContinue
$extDirs += Get-ChildItem "$env:USERPROFILE\.codeium\windsurf\extensions\hephaistos.orchestrator-monitor-*" -ErrorAction SilentlyContinue

$foundVersion = $null
$latestDir = $null
foreach ($d in $extDirs) {
    $pkg = Join-Path $d.FullName 'package.json'
    if (Test-Path $pkg) {
        try {
            $v = (Get-Content $pkg -Raw | ConvertFrom-Json).version
            if (-not $foundVersion -or [version]$v -gt [version]$foundVersion) {
                $foundVersion = $v
                $latestDir = $d.FullName
            }
        } catch {}
    }
}
if ($foundVersion) {
    if ([version]$foundVersion -ge [version]$ExpectedVersion) {
        Pass "orchestrator-monitor v$foundVersion detectee (attendue >= $ExpectedVersion, chemin: $latestDir)"
    } else {
        Warn "orchestrator-monitor v$foundVersion obsolette (attendue >= $ExpectedVersion) - relancer sans -CheckOnly pour maj"
    }
} else {
    Fail "orchestrator-monitor non detectee dans les extensions IDE (attendue >= $ExpectedVersion)"
}

Step '[4/6] Antigravity - CLI, extension et hub'
$agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (Test-Path $agy) { Pass "agy.exe trouve : $agy" } else { Fail 'agy.exe absent - installer Antigravity' }
$hubs = Get-CimInstance Win32_Process -Filter "Name='agy.exe'" |
    Where-Object { $_.CommandLine -match '--hub' -and $_.CommandLine -match '--hub-port' }
if ($hubs) {
    foreach ($h in $hubs) {
        $port = [regex]::Match($h.CommandLine, '--hub-port[ =](\d+)').Groups[1].Value
        Pass "hub agy actif (PID $($h.ProcessId), port $port)"
    }
} else { Warn 'aucun hub agy actif - demarre avec le panneau Antigravity de l IDE' }

Step '[5/6] Surfaces de regles et canal binome'
# Surfaces de regles
$surfScript = Join-Path $PSScriptRoot 'setup-agent-surfaces.ps1'
if (Test-Path $surfScript) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $surfScript -Verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Pass 'surfaces de regles conformes (devin, claude, windsurf, gemini)' }
    else { Warn 'surfaces de regles non conformes - lancer setup-agent-surfaces.ps1 pour resynchroniser' }
} else { Warn "script surfaces introuvable : $surfScript" }

# IDs binome publies
$commsPath = Join-Path $root '.agent\comms.jsonl'
if (Test-Path $commsPath) {
    $cLines = Get-Content $commsPath -Tail 80 -ErrorAction SilentlyContinue
    $hasDevin = $cLines | Where-Object { $_ -match '"src":"devin"' -and $_ -match '"convId":' }
    $hasAgy   = $cLines | Where-Object { $_ -match '"src":"agy"' -and $_ -match '"convId":' }
    if ($hasDevin -and $hasAgy) {
        Pass 'canal binome : IDs devin et agy publies dans comms.jsonl'
    } else {
        Warn 'canal binome : IDs incomplets (lancer node .agent/agent-bridge/binome.js join)'
    }
} else { Warn 'comms.jsonl absent - canal binome non initialise' }

Step '[6/6] Sante des services et bridge WS 7477'
$t = Test-NetConnection 127.0.0.1 -Port 7477 -WarningAction SilentlyContinue -InformationLevel Quiet
if ($t) { Pass 'ws-bridge 7477 vivant (orchestrator-monitor actif)' }
else { Warn 'ws-bridge 7477 muet - verifier le demarrage du monitor ou relancer' }

try { $r = Invoke-RestMethod 'http://127.0.0.1:7478/health' -TimeoutSec 3; Pass "a2a-gateway : $($r | ConvertTo-Json -Compress)" }
catch { Warn 'a2a-gateway (7478) down - optionnel (node a2a-gateway\server.js)' }

$bc = Get-Service BeaconCollector -ErrorAction SilentlyContinue
if ($bc -and $bc.Status -eq 'Running') { Pass 'BeaconCollector Running' }
else { Warn 'BeaconCollector arrete - Restart-Service BeaconCollector -Force (admin)' }

Write-Host "`nRESULTAT : $script:ok OK, $script:warn avertissement(s), $script:fail echec(s)" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
