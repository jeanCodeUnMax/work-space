<#
.SYNOPSIS
    Installation Hephaistos2-Kit pour les nuls — un seul clic.
.DESCRIPTION
    Ce script fait tout : vérification prérequis, appel install.ps1 -Elevated,
    installation des extensions, synchronisation des règles.
    À lancer en administrateur.
.EXAMPLE
    pwsh -File 1-installe-moi.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Write-Host "=== Installation Hephaistos2-Kit (pour les nuls) ===" -ForegroundColor Cyan
Write-Host "Dossier projet : $root"

# 0) Verif admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "`n[ERREUR] Tu dois lancer ce script en administrateur." -ForegroundColor Red
    Write-Host "Clic droit sur PowerShell 7 -> 'Executer en tant qu'administrateur'`n" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] Tu es administrateur" -ForegroundColor Green

# 1) Verif prerequis
Write-Host "`n[1/5] Verification des prerequis..."
$prereqOk = $true
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { Write-Host "[MANQUE] PowerShell 7" -ForegroundColor Red; $prereqOk = $false }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Write-Host "[MANQUE] Rust (cargo)" -ForegroundColor Red; $prereqOk = $false }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "[MANQUE] Node.js" -ForegroundColor Red; $prereqOk = $false }
if (-not $env:NVIDIA_API_KEY) { Write-Host "[MANQUE] NVIDIA_API_KEY" -ForegroundColor Red; $prereqOk = $false }
if (-not $env:NVIDIA_API_KEY_2) { Write-Host "[MANQUE] NVIDIA_API_KEY_2" -ForegroundColor Red; $prereqOk = $false }
if (-not $prereqOk) { Write-Host "`nInstalle ce qui manque et relance.`n" -ForegroundColor Yellow; exit 1 }
Write-Host "[OK] Tous les prerequis sont la" -ForegroundColor Green

# 2) Install principal
Write-Host "`n[2/5] Installation du runtime (install.ps1 -Elevated)..."
& pwsh -File "$root\install.ps1" -Elevated
if ($LASTEXITCODE -ne 0) { Write-Host "[ERREUR] install.ps1 a plante (code $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
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
    Write-Host "Quelques warnings. Regarde ci-dessus et va voir 05-quand-ca-marche-pas.md`n" -ForegroundColor Yellow
}
exit $LASTEXITCODE
