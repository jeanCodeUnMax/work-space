# AGENT System Bootstrap (Asynchrone)
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Configuration - CORRECTION: scripts sont dans scripts/
$ScriptsDir = Join-Path $PSScriptRoot "scripts"
$MonitorScript = Join-Path $ScriptsDir "monitor.js"
$IngestScript = Join-Path $ScriptsDir "auto-ingest.ps1"

# 1. Vérifier et lancer l'Ingestion
# (le Monitor :3055 n'est plus lancé — remplacé par l'extension orchestrator-monitor)
$ingestRunning = Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*auto-ingest.ps1*" }
if (-not $ingestRunning) {
    Start-Process pwsh -ArgumentList "-ExecutionPolicy Bypass -File `"$IngestScript`" -Mode auto" -WindowStyle Hidden -ErrorAction SilentlyContinue
}

# Sortie immédiate pour ne pas bloquer l'agent
exit 0
