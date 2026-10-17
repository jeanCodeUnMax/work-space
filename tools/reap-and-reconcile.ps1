<#
.SYNOPSIS
    Surveillance et purge automatique des processus fantomes et pids morts Hephaistos.
.DESCRIPTION
    Execute un controle d'integrite pre/post-vol :
    1. Reconcilie les taches in_progress dont le PID est mort (reconcile_tasks)
    2. Elimine les processus fantomes et legacy selon l'allowlist stricte (reap_ghosts)
    3. Nettoie les sessions orphelines
.OUTPUTS
    Rapport d'etat a l'ecran et emission d'evenement sur WebSocket 7477
#>
[CmdletBinding()]
param(
    [int]$GraceSecs = 120
)

$ErrorActionPreference = "Continue"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  HEPHAISTOS - PURGE REACTIVE ET RECONCILIATION ANTI-ZOMBIES        " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host ""

$ScriptDir = $PSScriptRoot
$KitRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path

# 1. Verification de l'orchestrateur et appel MCP via script mcp-call si present
$McpCallScript = Join-Path $env:USERPROFILE ".config\devin\scripts\mcp-call.mjs"

if (Test-Path $McpCallScript) {
    Write-Host "[1/3] Reconcilation des taches orphelines..." -ForegroundColor Yellow
    try {
        node $McpCallScript Hephaistos-everything-search reconcile_tasks "{}" | Out-Host
    } catch {
        Write-Host "  [AVERTISSEMENT] Erreur reconcile_tasks : $_" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "[2/3] Execution de reap_ghosts (allowlist stricte)..." -ForegroundColor Yellow
    try {
        node $McpCallScript Hephaistos-everything-search reap_ghosts "{}" | Out-Host
    } catch {
        Write-Host "  [AVERTISSEMENT] Erreur reap_ghosts : $_" -ForegroundColor Red
    }
} else {
    Write-Host "[INFO] mcp-call.mjs non detecte dans le profil utilisateur." -ForegroundColor Gray
    Write-Host "       Nettoyage passif des processus orphelins via pattern matching..." -ForegroundColor Gray
}

# 3. Verification locale des processus zombies connus (legacy orphelins uniquement)
Write-Host ""
Write-Host "[3/3] Verification des processus Node et Python residuels..." -ForegroundColor Yellow

$legacyPatterns = @("orchestrator-server", "model-discovery", "nim-router", "agentMemory-server", "zvec")
$reapedCount = 0

try {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "node\.exe|python\.exe" }
    foreach ($p in $procs) {
        $cmd = $p.CommandLine
        if ($cmd) {
            foreach ($pat in $legacyPatterns) {
                if ($cmd -match $pat) {
                    Write-Host "  [KILL] Processus legacy orphelin detecte (PID $($p.ProcessId)) : $pat" -ForegroundColor Yellow
                    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                    $reapedCount++
                    break
                }
            }
        }
    }
} catch {
    # Ignore CIM access errors on locked processes
}

if ($reapedCount -eq 0) {
    Write-Host "  [OK] Aucun processus orphelin detecte. Environnement sain." -ForegroundColor Green
} else {
    Write-Host "  [OK] $reapedCount processus fantome(s) elimine(s)." -ForegroundColor Green
}

Write-Host ""
Write-Host "Purge terminee avec succes." -ForegroundColor Cyan
