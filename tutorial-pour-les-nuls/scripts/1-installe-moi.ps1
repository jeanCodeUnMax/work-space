<#
.SYNOPSIS
    Installation Hephaistos2-Kit pour les nuls — un seul clic.
.DESCRIPTION
    Ce script fait tout : verification prerequis, appel install.ps1 -Elevated,
    installation des extensions, synchronisation des regles.
    A lancer en administrateur dans PowerShell 7.
.PARAMETER SkipBuild
    Saute la compilation Rust si les binaires sont deja prets.
.EXAMPLE
    pwsh -File 1-installe-moi.ps1
    pwsh -File 1-installe-moi.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "$root\install.ps1")) {
    $root = "C:\Program Files\Projet-complet\hephaistos2-kit"
}

Write-Host "=== Installation Hephaistos2-Kit (pour les nuls) ===" -ForegroundColor Cyan
Write-Host "Dossier projet : $root"

# 0) Verif admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "`n[ERREUR] Tu dois lancer ce script en administrateur." -ForegroundColor Red
    Write-Host "Fais un clic droit sur PowerShell 7 -> 'Executer en tant qu'administrateur'`n" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Tu es administrateur" -ForegroundColor Green

# 1) Verif prerequis
Write-Host "`n[1/5] Verification des prerequis..."
$prereqOk = $true
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { Write-Host "[MANQUE] PowerShell 7" -ForegroundColor Red; $prereqOk = $false }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "[MANQUE] Node.js" -ForegroundColor Red; $prereqOk = $false }

# Verification Rust ou binaires precompiles
$hasCargo = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
$hasPrebuilt = (Test-Path "C:\Program Files\servers\hephaistos2-kit\extension\server\hphe-mcp.exe") -or (Test-Path "$root\hphe\target\release\hphe-mcp.exe")

if ($hasCargo) {
    Write-Host "[OK] Rust (cargo)" -ForegroundColor Green
} elseif ($hasPrebuilt) {
    Write-Host "[INFO] Rust absent mais binaires precompiles detectes (mode -SkipBuild actif)" -ForegroundColor Yellow
    $SkipBuild = $true
} else {
    Write-Host "[MANQUE] Rust (cargo) requis pour compiler la premiere fois" -ForegroundColor Red
    $prereqOk = $false
}

if (-not $env:NVIDIA_API_KEY) { Write-Host "[MANQUE] Variable NVIDIA_API_KEY" -ForegroundColor Red; $prereqOk = $false }
if (-not $env:NVIDIA_API_KEY_2) { Write-Host "[MANQUE] Variable NVIDIA_API_KEY_2" -ForegroundColor Red; $prereqOk = $false }

if (-not $prereqOk) {
    Write-Host "`nInstalle ce qui manque et relance le script.`n" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Tous les prerequis indispensables sont presents" -ForegroundColor Green

# 2) Install principal
Write-Host "`n[2/5] Installation du runtime (install.ps1 -Elevated)..."
$installArgs = @('-File', "$root\install.ps1", '-Elevated')
if ($SkipBuild) { $installArgs += '-SkipBuild' }
& pwsh @installArgs
if ($LASTEXITCODE -ne 0) { Write-Host "[ERREUR] install.ps1 a echoue (code $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "[OK] Runtime installe" -ForegroundColor Green

# 3) Extensions VSIX
Write-Host "`n[3/5] Installation des extensions VSIX..."
& pwsh -File "$root\.agent\setup\install-extension-hub.ps1"
if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Extension peut-etre pas installee proprement" -ForegroundColor Yellow }
else { Write-Host "[OK] Extensions installees" -ForegroundColor Green }

# 4) Surfaces de regles
Write-Host "`n[4/5] Synchronisation des regles et skills..."
& pwsh -File "$root\.agent\setup\setup-agent-surfaces.ps1"
if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] Surfaces peut-etre pas conformes" -ForegroundColor Yellow }
else { Write-Host "[OK] Surfaces synchronisees" -ForegroundColor Green }

# 5) Verification finale
Write-Host "`n[5/5] Verification finale..."
& pwsh -File "$root\.agent\setup\install-extension-hub.ps1" -CheckOnly
$checkOk = ($LASTEXITCODE -eq 0)

Write-Host "`n=== Resume ===" -ForegroundColor Cyan
if ($checkOk) {
    Write-Host "Tout est bon ! Relance Devin et Antigravity (Reload Window)." -ForegroundColor Green
    Write-Host "Pour tester le ping-pong : .\3-teste-le-ping-pong.ps1`n" -ForegroundColor Cyan
} else {
    Write-Host "Quelques avertissements. Regarde ci-dessus et consulte 05-quand-ca-marche-pas.md`n" -ForegroundColor Yellow
}
exit $LASTEXITCODE
