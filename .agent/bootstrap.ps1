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

# 2. WS Bridge orchestrator-monitor (:7477)
# Dans le kit, l'extension VS Code le lance elle-même ; dans les projets
# synchronisés (ou si l'extension est absente/rechargée), on le démarre ici.
$BridgeScript = Join-Path $PSScriptRoot "..\extensions\orchestrator-monitor\ws-bridge\bridge.js"
$bridgeUp = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', 7477)
    $tcp.Close()
    $bridgeUp = $true
} catch { }
if (-not $bridgeUp -and (Test-Path $BridgeScript)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        Start-Process node -ArgumentList "`"$BridgeScript`"" -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
}

# Sortie immédiate pour ne pas bloquer l'agent
exit 0
