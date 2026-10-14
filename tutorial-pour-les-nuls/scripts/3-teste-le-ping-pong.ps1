<#
.SYNOPSIS
    Teste le canal ping-pong Devin <-> Antigravity.
.DESCRIPTION
    Fait les join, envoie un message test dans chaque sens,
    et montre les derniers messages du canal.
.PARAMETER As
    Qui envoie le test ('devin' par defaut, ou 'agy').
.EXAMPLE
    pwsh -File 3-teste-le-ping-pong.ps1
    pwsh -File 3-teste-le-ping-pong.ps1 -As agy
#>
[CmdletBinding()]
param(
    [ValidateSet('devin', 'agy')]
    [string]$As = 'devin'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "$root\install.ps1")) {
    $root = "C:\Program Files\Projet-complet\hephaistos2-kit"
}
$comms = "$root\.agent\comms.jsonl"
$binome = "$root\.agent\agent-bridge\binome.js"

Write-Host "=== Test ping-pong binome ===" -ForegroundColor Cyan
Write-Host "Role actif pour ce test : $As"

# 1) Verifie que le bridge 7477 est vivant
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 7477)
    $tcp.Close()
    Write-Host "[OK] Bridge WS 7477 vivant" -ForegroundColor Green
} catch {
    Write-Host "[ERREUR] Bridge 7477 muet — verifie que l'extension orchestrator-monitor est active" -ForegroundColor Red
    exit 1
}

# 2) Verifie que binome.js existe
if (-not (Test-Path $binome)) {
    Write-Host "[ERREUR] binome.js introuvable : $binome" -ForegroundColor Red
    exit 1
}

# 3) Publication de l'ID courant
Write-Host "`n[1/3] Publication de l'identifiant ($As)..."
& node $binome --as $As join

# 4) Envoi du message test vers le binome
$peer = if ($As -eq 'devin') { 'agy' } else { 'devin' }
Write-Host "`n[2/3] Envoi d'un message test vers $peer..."
$msg = "TEST-PING-PONG-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
& node $binome --as $As send "$msg — coucou $peer, transmission validee"

# 5) Affichage des derniers echanges
Write-Host "`n[3/3] Derniers messages du canal comms.jsonl :"
if (Test-Path $comms) {
    Get-Content $comms -Tail 6 | ForEach-Object {
        $j = $_ | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($j) {
            $txt = if ($j.text) { $j.text.Substring(0, [Math]::Min(70, $j.text.Length)) } else { "($($j.kind))" }
            Write-Host "  $($j.ts) [$($j.src) -> $($j.dst)] $txt"
        }
    }
} else {
    Write-Host "  (comms.jsonl pas encore cree)"
}

Write-Host "`n=== Fin du test ===" -ForegroundColor Cyan
Write-Host "Si le message apparait chez ton binome ($peer), la liaison fonctionne."
Write-Host "En cas de silence, consulte 05-quand-ca-marche-pas.md`n"
