<#
.SYNOPSIS
    Configure le canal binome Devin <-> Antigravity et les hooks Devin.
.DESCRIPTION
    Installe/verifie tout ce qui touche Devin pour le binome :
      - hooks awareness.mjs (session-start, prompt-submit, stop)
      - settings.json : devin.acp.preferredAgent = antigravity-acp
      - binome.js join (publication de l'ID de session)
      - verification bridge WS 7477 + comms.jsonl

    Tous les chemins sont RELATIFS au script (via $PSScriptRoot).
    Aucun chemin absolu codé en dur.
.EXAMPLE
    pwsh -File .agent\setup\setup-devin-binome.ps1
    pwsh -File .agent\setup\setup-devin-binome.ps1 -Verify
#>
[CmdletBinding()]
param(
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$KitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DevinConfig = Join-Path $env:USERPROFILE '.config\devin'

$script:ok = 0; $script:warn = 0; $script:fail = 0
function Pass($m) { $script:ok++;   Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn($m) { $script:warn++; Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Fail($m) { $script:fail++; Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

if ($Verify) {
    Step 'Verification configuration binome Devin'

    # 1. Hooks awareness.mjs dans config.json
    $configFile = Join-Path $DevinConfig 'config.json'
    if (Test-Path $configFile) {
        $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
        $hasHooks = $false
        if ($cfg.hooks) {
            foreach ($evt in @('SessionStart','UserPromptSubmit','Stop')) {
                if ($cfg.hooks.$evt) {
                    $match = $cfg.hooks.$evt | Where-Object { $_.hooks | Where-Object { $_.command -like '*awareness.mjs*' } }
                    if ($match) { $hasHooks = $true; break }
                }
            }
        }
        if ($hasHooks) { Pass 'hooks awareness.mjs dans ~/.config/devin/config.json' }
        else { Fail 'hooks awareness.mjs absents' }
    } else { Fail "config.json Devin introuvable : $configFile" }

    # 2. awareness.mjs present sur disque
    $awareness = Join-Path $KitRoot '.agent\devin\scripts\awareness.mjs'
    if (Test-Path $awareness) { Pass "awareness.mjs present : $awareness" }
    else { Fail "awareness.mjs absent : $awareness" }

    # 3. preferredAgent (config IDE interne — pas dans un settings.json standard)
    # On vérifie juste que l'extension monitor est installée (c'est elle qui gère ACP)
    $extDir = Join-Path $env:USERPROFILE '.devin\extensions'
    if (Test-Path $extDir) {
        $ext = Get-ChildItem $extDir -Filter 'hephaistos.orchestrator-monitor-*' -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($ext) { Pass "extension monitor installee : $($ext.Name)" }
        else { Warn 'extension monitor non detectee dans .devin/extensions' }
    } else { Warn 'dossier .devin/extensions absent' }

    # 4. Bridge 7477
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect('127.0.0.1', 7477)
        $tcp.Close()
        Pass 'bridge WS 7477 vivant'
    } catch { Fail 'bridge 7477 muet — extension orchestrator-monitor pas active' }

    # 5. comms.jsonl avec IDs
    $comms = Join-Path $KitRoot '.agent\comms.jsonl'
    if (Test-Path $comms) {
        $lines = Get-Content $comms -Tail 50
        $hasDevin = $lines | Where-Object { $_ -match '"src":"devin"' -and $_ -match '"convId":' }
        $hasAgy   = $lines | Where-Object { $_ -match '"src":"agy"'   -and $_ -match '"convId":' }
        if ($hasDevin -and $hasAgy) { Pass 'IDs binome publies (devin + agy)' }
        else { Warn 'IDs binome incomplets — relancer binome.js join' }
    } else { Warn 'comms.jsonl absent' }

    Write-Host "`nRESULTAT : $script:ok OK, $script:warn avertissement(s), $script:fail echec(s)" -ForegroundColor Cyan
    if ($script:fail -gt 0) { exit 1 } else { exit 0 }
}

# --- MODE INSTALLATION ---
Step 'Configuration binome Devin'

# 1. Hooks awareness.mjs
$installScript = Join-Path $KitRoot '.agent\devin\install-devin-integration.ps1'
if (Test-Path $installScript) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $installScript 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Pass 'hooks awareness.mjs installes' }
    else { Warn 'install-devin-integration a retourne une erreur' }
} else { Fail "install-devin-integration.ps1 introuvable : $installScript" }

# 2. Extension monitor (gère le canal ACP + bridge 7477)
$extDir = Join-Path $env:USERPROFILE '.devin\extensions'
if (Test-Path $extDir) {
    $ext = Get-ChildItem $extDir -Filter 'hephaistos.orchestrator-monitor-*' -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($ext) { Pass "extension monitor detectee : $($ext.Name)" }
    else { Warn 'extension monitor pas encore installee — lance install-extension-hub.ps1' }
} else { Warn 'dossier .devin/extensions absent — extension monitor pas installee' }

# 3. binome.js join
$binome = Join-Path $KitRoot '.agent\agent-bridge\binome.js'
if (Test-Path $binome) {
    Push-Location $KitRoot
    try {
        $out = & node $binome --as devin join 2>&1
        if ($LASTEXITCODE -eq 0) { Pass 'binome join devin OK' }
        else { Warn "binome join devin a retourne $LASTEXITCODE" }
    } finally { Pop-Location }
} else { Fail "binome.js introuvable : $binome" }

# 4. Verification finale
Step 'Verification finale'
& $PSCommandPath -Verify
exit $LASTEXITCODE
