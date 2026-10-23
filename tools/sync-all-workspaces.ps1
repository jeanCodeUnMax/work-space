<#
.SYNOPSIS
    Resynchronise la couche .agent Hephaistos2-Kit sur TOUS les workspaces.
.DESCRIPTION
    Enumere les workspaces des racines projets (par defaut
    C:\Program Files\Projet-complet et F:\Promgramation-teste) et appelle
    .agent\scripts\sync-agent-layer.ps1 sur chacun.

    - hephaistos2-kit est EXCLU (source de verite — jamais cible).
    - Sont traites : tout dossier ayant deja .agent (update) ou .git (inject).
    - Jonctions/reparse points et dossiers sans .agent ni .git : ignores.
    - PAS de -Force : les fichiers racine existants (.env, .gitignore, AGENTS.md...)
      des workspaces sont conserves ; seuls les absents sont deposes.
    - Chaque sync tourne dans un powershell enfant (isolation des erreurs).

.PARAMETER DryRun
    Liste ce qui serait fait sans rien ecrire.
.EXAMPLE
    pwsh -File tools\sync-all-workspaces.ps1
    pwsh -File tools\sync-all-workspaces.ps1 -DryRun
#>
param(
    [string[]]$Roots = @('C:\Program Files\Projet-complet', 'F:\Promgramation-teste'),
    [string]$SyncScript = "$PSScriptRoot\..\.agent\scripts\sync-agent-layer.ps1",
    [string[]]$SkipDirs = @('hephaistos2-kit'),
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
$SyncScript = (Resolve-Path $SyncScript).Path
if (-not (Test-Path $SyncScript)) { Write-Error "sync-agent-layer.ps1 introuvable: $SyncScript"; exit 1 }

$results = New-Object System.Collections.Generic.List[object]
$start = Get-Date

foreach ($root in $Roots) {
    if (-not (Test-Path $root)) { Write-Warning "racine absente: $root"; continue }
    Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
        $d = $_
        if ($SkipDirs -contains $d.Name) {
            $results.Add([pscustomobject]@{ Workspace = $d.FullName; Mode = 'SKIP'; Copied = 0; Note = 'kit source (exclu)' }) | Out-Null
            return
        }
        if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $results.Add([pscustomobject]@{ Workspace = $d.FullName; Mode = 'SKIP'; Copied = 0; Note = 'jonction/lien' }) | Out-Null
            return
        }
        $hasAgent = Test-Path (Join-Path $d.FullName '.agent')
        $hasGit   = Test-Path (Join-Path $d.FullName '.git')
        if (-not ($hasAgent -or $hasGit)) {
            $results.Add([pscustomobject]@{ Workspace = $d.FullName; Mode = 'SKIP'; Copied = 0; Note = 'pas un workspace (.agent/.git absent)' }) | Out-Null
            return
        }
        $mode = if ($hasAgent) { 'update' } else { 'inject' }
        if ($DryRun) {
            $results.Add([pscustomobject]@{ Workspace = $d.FullName; Mode = "DRY-$mode"; Copied = 0; Note = '' }) | Out-Null
            return
        }
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $SyncScript -Target $d.FullName 2>&1 | Out-String
        $ok = ($LASTEXITCODE -eq 0)
        $copied = 0
        if ($out -match '(\d+)\s+fichier\(s\)\s+\.agent') { $copied = [int]$Matches[1] }
        $results.Add([pscustomobject]@{
            Workspace = $d.FullName
            Mode      = $(if ($ok) { $mode } else { 'ERROR' })
            Copied    = $copied
            Note      = $(if (-not $ok) { ($out -split "`n" | Select-Object -First 1) } else { '' })
        }) | Out-Null
    }
}

$elapsed = (Get-Date) - $start
$results | Sort-Object Workspace | Format-Table Workspace, Mode, Copied, Note -AutoSize | Out-String -Width 220 | Write-Output
$updated = @($results | Where-Object { $_.Mode -eq 'update' }).Count
$injected = @($results | Where-Object { $_.Mode -eq 'inject' }).Count
$errors  = @($results | Where-Object { $_.Mode -eq 'ERROR' }).Count
$skipped = @($results | Where-Object { $_.Mode -eq 'SKIP' }).Count
Write-Output ("DONE: {0} update | {1} inject | {2} error | {3} skip | {4:N0}s | DryRun={5}" -f $updated, $injected, $errors, $skipped, $elapsed.TotalSeconds, [bool]$DryRun)
if ($errors -gt 0) { exit 2 } else { exit 0 }
