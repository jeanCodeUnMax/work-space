#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installe et demarre le demon hphe-indexd en tant que tache planifiee Windows (RunLevel HIGHEST / SYSTEM).

.DESCRIPTION
    Configure hphe-indexd pour un demarrage automatique au boot du systeme avec les privileges
    SYSTEM / Administrateur requis pour la lecture directe du MFT NTFS et du journal USN.
    Phase P2 Hephaistos Engine.

.PARAMETER BinaryPath
    Chemin source vers le binaire hphe-indexd.exe (par defaut: ..\target\release\hphe-indexd.exe).

.PARAMETER Drive
    Lettre du volume a indexer (defaut: "C").

.PARAMETER InstallDir
    Repertoire d'installation du binaire (defaut: $env:ProgramFiles\hphe).

.PARAMETER TaskName
    Nom de la tache planifiee (defaut: "HpheIndexDaemon").
#>

param(
    [string]$BinaryPath = "",
    [string]$Drive = "C",
    [string]$InstallDir = "$env:ProgramFiles\hphe",
    [string]$TaskName = "HpheIndexDaemon"
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Installation du demon hphe-indexd (Service Windows / Tache Planifiee HIGHEST)" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan

# 1. Verification des privileges administrateur
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "[ERREUR] Ce script doit etre execute dans une invite PowerShell elevee (Run as Administrator)."
    exit 1
}

# 2. Localisation du binaire hphe-indexd.exe
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $BinaryPath) {
    $candidates = @(
        (Join-Path $scriptDir "..\target\release\hphe-indexd.exe"),
        (Join-Path $scriptDir "..\..\target\release\hphe-indexd.exe"),
        (Join-Path $InstallDir "hphe-indexd.exe"),
        (Join-Path $scriptDir "..\target\debug\hphe-indexd.exe")
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) {
            $BinaryPath = (Resolve-Path $cand).Path
            break
        }
    }
}

if (-not (Test-Path $BinaryPath)) {
    Write-Error "[ERREUR] Binaire hphe-indexd.exe introuvable. Executez d'abord 'cargo build --release' dans hphe/."
    exit 1
}

Write-Host "[+] Binaire source detecte : $BinaryPath" -ForegroundColor Green

# 3. Creation des repertoires cibles
$DataDir = "$env:ProgramData\hphe"
$LogsDir = "$DataDir\logs"
$CheckpointsDir = "$DataDir\checkpoints"

foreach ($dir in @($InstallDir, $DataDir, $LogsDir, $CheckpointsDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "[+] Repertoire cree : $dir" -ForegroundColor Gray
    }
}

# 4. Copie du binaire dans Program Files
$targetBinary = Join-Path $InstallDir "hphe-indexd.exe"
if ($BinaryPath -ne $targetBinary) {
    Copy-Item -Path $BinaryPath -Destination $targetBinary -Force
    Write-Host "[+] Binaire deploye dans : $targetBinary" -ForegroundColor Green
}

# 5. Arret de la tache existante si presente
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "[*] Arret et mise a jour de la tache existante $TaskName..." -ForegroundColor Yellow
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# 6. Definition et enregistrement de la tache planifiee (SYSTEM + HIGHEST au boot)
$action = New-ScheduledTaskAction -Execute $targetBinary -Argument "--drive $Drive"
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -Priority 4

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $taskPrincipal `
    -Settings $settings `
    -Description "Demon de recherche haute performance Hephaistos Engine (hphe-indexd) - MFT/USN/IPC" `
    -Force | Out-Null

Write-Host "[+] Tache planifiee '$TaskName' enregistree avec succes (Demarrage au boot, SYSTEM/HIGHEST)." -ForegroundColor Green

# 7. Demarrage immediat du demon
Write-Host "[*] Demarrage du demon..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

# 8. Verification du statut
$status = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Statut du deploiement : $($status.State)" -ForegroundColor Green
Write-Host " Dernier code retour  : $($info.LastTaskResult)" -ForegroundColor Gray
Write-Host " Fichier de log        : $LogsDir\hphe-indexd.log" -ForegroundColor Gray
Write-Host " Tube nomme IPC        : \\.\pipe\hphe-index" -ForegroundColor Gray
Write-Host "================================================================================" -ForegroundColor Cyan
