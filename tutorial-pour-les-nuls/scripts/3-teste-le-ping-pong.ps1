<#
.SYNOPSIS
    Teste le canal ping-pong Devin <-> Antigravity.
.DESCRIPTION
    Fait les join, envoie un message test dans chaque sens,
    et montre les derniers messages du canal.
.EXAMPLE
    pwsh -File 3-teste-le-ping-pong.ps1
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$comms = "$root\.agent\comms.jsonl"

Write-Host "=== Test ping-pong binome ===" -ForegroundColor Cyan

# 1) Verifie que le bridge 7477 est vivant
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 7477)
    $tcp.Close()
    Write-Host "[OK] Bridge WS 7477 vivant" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Bridge 7477 muet — lance install-extension-hub.ps1 d'abord" -ForegroundColor Red
    exit 1
}

# 2) Verifie que binome.js existe
$binome = "$root\.agent\agent-bridge\binome.js"
if (-not (Test-Path $binome)) { Write-Host "[ERREUR] binome.js introuvable : $binome" -ForegroundColor Red; exit 1 }

# 3) Join devin (on est dans devin)
Write-Host "`n[1/4] Devin publie son ID..."
& node $binome --as devin join

# 4) Join agy (si on peut — sinon on simule)
Write-Host "`n[2/4] Antigravity publie son ID (depuis son cote)..."
Write-Host "  Si tu es dans Antigravity, fais-le aussi : node $binome --as agy join"

# 5) Envoie un message test de devin vers agy
Write-Host "`n[3/4] Devin envoie un message test..."
$msg = "TEST-PING-PONG-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
& node $binome --as devin send "$msg — dis coucou si tu me recois"

# 6) Montre les derniers messages
Write-Host "`n[4/4] Derniers messages du canal :"
if (Test-Path $comms) {
    Get-Content $comms -Tail 5 | ForEach-Object {
        $j = $_ | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($j) { Write-Host "  $($j.ts) [$($j.src)->$($j.dst)] $($j.text.Substring(0,[Math]::Min(60,$j.text.Length)))..." }
    }
} else { Write-Host "  (comms.jsonl pas encore cree)" }

Write-Host "`n=== Fin du test ===" -ForegroundColor Cyan
Write-Host "Si tu vois le message dans la conversation d'Antigravity, c'est bon."
Write-Host "Sinon, va voir 05-quand-ca-marche-pas.md`n"
