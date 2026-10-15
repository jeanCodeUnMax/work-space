<#
.SYNOPSIS
    Vérifie en lecture seule un binôme Devin <-> Antigravity déjà établi.
.DESCRIPTION
    Vérifie le bridge local et lit le résultat de binome.js pair. Ne publie pas de handshake et n'envoie aucun message.
.EXAMPLE
    pwsh -File 3-teste-le-ping-pong.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$binome = Join-Path $root '.agent\agent-bridge\binome.js'

Write-Host "=== Vérification du binôme ===" -ForegroundColor Cyan

try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', 7477)
    $tcp.Close()
    Write-Host '[OK] Bridge WS 7477 vivant' -ForegroundColor Green
} catch {
    Write-Host '[WARN] Bridge 7477 muet; le contrôle de paire continue en lecture seule' -ForegroundColor Yellow
}

if (-not (Test-Path $binome)) {
    Write-Host "[ERREUR] binome.js introuvable : $binome" -ForegroundColor Red
    exit 1
}

Push-Location $root
try {
    $raw = & node $binome --as devin pair 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[ERREUR] binome.js pair a échoué' -ForegroundColor Red
        exit 1
    }
    $pair = ($raw | Out-String) | ConvertFrom-Json
    if (-not $pair.established) {
        Write-Host '[WARN] Aucun pair frais vérifié. Lance /jointes AGY dans Devin.' -ForegroundColor Yellow
        exit 1
    }
    Write-Host "[OK] Pair frais : $($pair.me)=$($pair.myCascade) ⇄ $($pair.peer)=$($pair.peerCascade) (pairId=$($pair.pairId))" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Vérification impossible : $_" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}

Write-Host 'Contrôle terminé sans publier de handshake ni envoyer de message.' -ForegroundColor Cyan
