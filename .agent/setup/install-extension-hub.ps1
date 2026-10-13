# Hephaistos - install extension monitor + verif hub Antigravity (2026-10-07)
# Usage : pwsh -ExecutionPolicy Bypass -File .agent\setup\install-extension-hub.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ext  = Join-Path $root 'extensions\orchestrator-monitor'
$script:ok = 0; $script:warn = 0; $script:fail = 0
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Pass($m) { $script:ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { $script:warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { $script:fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }

Step '[1/5] Build orchestrator-monitor (npm i + tsc + vsce)'
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

Step '[2/5] Installation du VSIX'
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

Step '[3/5] Antigravity - extension + exe'
$agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (Test-Path $agy) { Pass "agy.exe trouve : $agy" } else { Fail 'agy.exe absent - installer Antigravity' }
$extList = & code --list-extensions 2>$null
if ($extList -match 'antigravity') { Pass 'extension google-antigravity presente' }
else { Warn 'extension google-antigravity non detectee via code - verifier dans l IDE' }

Step '[4/5] Hub Antigravity (discovery)'
$hubs = Get-CimInstance Win32_Process -Filter "Name='agy.exe'" |
  Where-Object { $_.CommandLine -match '--hub' -and $_.CommandLine -match '--hub-port' }
if ($hubs) {
  foreach ($h in $hubs) {
    $port = [regex]::Match($h.CommandLine, '--hub-port[ =](\d+)').Groups[1].Value
    Pass "hub agy actif (PID $($h.ProcessId), port $port)"
  }
} else { Warn 'aucun hub agy actif - il demarre avec l extension Antigravity dans l IDE (ouvrir le panneau Antigravity)' }

Step '[5/5] Sante des services'
try { $r = Invoke-RestMethod 'http://127.0.0.1:7478/health' -TimeoutSec 3; Pass "a2a-gateway : $($r | ConvertTo-Json -Compress)" }
catch { Warn 'a2a-gateway (7478) down - node a2a-gateway\server.js' }
$t = Test-NetConnection 127.0.0.1 -Port 7477 -WarningAction SilentlyContinue -InformationLevel Quiet
if ($t) { Pass 'ws-bridge 7477 ecoute (monitor actif)' } else { Warn 'ws-bridge 7477 muet - le monitor est inerte : Reload Window' }
$bc = Get-Service BeaconCollector -ErrorAction SilentlyContinue
if ($bc -and $bc.Status -eq 'Running') { Pass 'BeaconCollector Running' } else { Warn 'BeaconCollector arrete - Restart-Service BeaconCollector -Force (admin)' }

Write-Host "`nRESULTAT : $ok OK, $warn avertissement(s), $fail echec(s)" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 } else { exit 0 }
