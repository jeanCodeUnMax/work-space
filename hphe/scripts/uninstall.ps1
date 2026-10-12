#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Arrete et supprime la tache planifiee du demon hphe-indexd.

.DESCRIPTION
    Arrete le processus hphe-indexd.exe en cours d'execution, desactive et supprime la tache planifiee.
    Permet optionnellement de supprimer les snapshots et journaux dans %ProgramData%\hphe.

.PARAMETER TaskName
    Nom de la tache planifiee a desinstaller (defaut: "HpheIndexDaemon").

.PARAMETER CleanData
    Si specifie, nettoie les donnees et logs dans %ProgramData%\hphe.
#>

param(
    [string]$TaskName = "HpheIndexDaemon",
    [switch]$CleanData = $false
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Yellow
Write-Host " Desinstallation du demon hphe-indexd" -ForegroundColor Yellow
Write-Host "================================================================================" -ForegroundColor Yellow

# 1. Verification des privileges administrateur
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "[ERREUR] Ce script doit etre execute dans une invite PowerShell elevee (Run as Administrator)."
    exit 1
}

# 2. Arret de la tache planifiee
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "[*] Arret de la tache planifiee '$TaskName'..." -ForegroundColor Cyan
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    Write-Host "[*] Suppression de la tache planifiee '$TaskName'..." -ForegroundColor Cyan
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[+] Tache planifiee supprimee avec succes." -ForegroundColor Green
} else {
    Write-Host "[!] La tache planifiee '$TaskName' n'est pas enregistree." -ForegroundColor Gray
}

# 3. Terminaison d'eventuels processus orphelins hphe-indexd
$procs = Get-Process -Name "hphe-indexd" -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "[*] Arret des processus hphe-indexd restants..." -ForegroundColor Cyan
    Stop-Process -Name "hphe-indexd" -Force -ErrorAction SilentlyContinue
}

# 4. Nettoyage optionnel des donnees
if ($CleanData) {
    $DataDir = "$env:ProgramData\hphe"
    if (Test-Path $DataDir) {
        Write-Host "[*] Suppression du repertoire de donnees : $DataDir" -ForegroundColor Yellow
        Remove-Item -Path $DataDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "[+] Repertoire de donnees supprime." -ForegroundColor Green
    }
}

Write-Host "================================================================================" -ForegroundColor Green
Write-Host " Desinstallation terminee avec succes." -ForegroundColor Green
Write-Host "================================================================================" -ForegroundColor Green
