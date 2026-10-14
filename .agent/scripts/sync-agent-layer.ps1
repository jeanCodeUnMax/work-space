<#
.SYNOPSIS
    Resynchronise la couche .agent d'un projet cible depuis Hephaistos2-Kit (source de verite).

.DESCRIPTION
    Copie .agent du kit vers le projet cible : ecrase les fichiers communs,
    ajoute les manquants, NE SUPPRIME PAS les fichiers propres au projet
    (ex: rules/local_rules.md) ni les fichiers d'etat runtime.

    Depose aussi (parite v1 'hephaistos-kit init') :
      - .vscode/     : configs IDE partagees — fichiers manquants uniquement,
                       jamais d'ecrasement des settings du projet
      - .ragignore   : exclusions d'ingestion — depose seulement si absent
      - .mcp-access  : acces MCP du projet — depose seulement si absent
      - .gitignore   : ignore universel du kit — depose seulement si absent
      - .gitmodules  : sous-modules moteur (hphe, search-ext, monitor-ext)
      - .env         : squelette env (AGENT_DB_ROOT vide) — jamais de secrets
      - .env.example : meme squelette, reference
      (-Force outrepasse les fichiers racine)

    Fichiers ignores (runtime, jamais propages) :
      - .beacon-learn-state.json, .beacon-offset.json
      - ingestion.log, ingestion.state.json, .ingestion-state.json
      - rag_bridge.pid, rag_bridge_stdout.log, rag_bridge_stderr.log, rag_bridge.log
      - __pycache__/, node_modules/, logs/

.PARAMETER Target
    Chemin racine du projet cible (contient ou contiendra .agent).

.PARAMETER DryRun
    Affiche ce qui serait copie sans rien ecrire.

.PARAMETER Force
    Ecrase aussi les fichiers racine (.ragignore, .mcp-access, .gitignore,
    .gitmodules, .env, .env.example) si le projet en a deja.

.EXAMPLE
    pwsh -File .agent\scripts\sync-agent-layer.ps1 -Target F:\Promgramation-teste\Thot-Agents
    pwsh -File .agent\scripts\sync-agent-layer.ps1 -Target <projet> -DryRun
#>
param(
    [Parameter(Mandatory = $true)][string]$Target,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$KitRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # <kit>/.agent/scripts -> <kit>
$Source = Join-Path $KitRoot '.agent'
$Dest = Join-Path $Target '.agent'

if (-not (Test-Path $Source)) { Write-Error "Source introuvable: $Source"; exit 1 }
if (-not (Test-Path $Target)) { Write-Error "Cible introuvable: $Target"; exit 1 }

$SkipDirs = @('__pycache__', 'node_modules', 'logs')
$SkipFiles = @(
    '.beacon-learn-state.json', '.beacon-offset.json',
    'ingestion.log', 'ingestion.state.json', '.ingestion-state.json',
    'rag_bridge.pid', 'rag_bridge_stdout.log', 'rag_bridge_stderr.log', 'rag_bridge.log'
)

$copied = 0; $skipped = 0
Get-ChildItem -Path $Source -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Source.Length + 1)
    $parts = $rel -split '[\\/]'
    if ($parts | Where-Object { $SkipDirs -contains $_ }) { $skipped++; return }
    if ($SkipFiles -contains $_.Name) { $skipped++; return }
    $dst = Join-Path $Dest $rel
    $same = (Test-Path $dst) -and
            ((Get-FileHash $_.FullName).Hash -eq (Get-FileHash $dst).Hash)
    if (-not $same) {
        if ($DryRun) { Write-Host "  COPY $rel" }
        else {
            New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
            Copy-Item $_.FullName $dst -Force
        }
        $copied++
    }
}

# --- .vscode : configs IDE partagees — fichiers manquants uniquement ---
$vsSrc = Join-Path $KitRoot '.vscode'
$vsCopied = 0; $vsKept = 0
if (Test-Path $vsSrc) {
    Get-ChildItem -Path $vsSrc -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($vsSrc.Length + 1)
        $dst = Join-Path $Target (Join-Path '.vscode' $rel)
        if (Test-Path $dst) { $vsKept++; return }
        if ($DryRun) { Write-Host "  COPY .vscode\$rel" }
        else {
            New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
            Copy-Item $_.FullName $dst -Force
        }
        $vsCopied++
    }
}

# --- fichiers racine du template : deposes si absents (-Force pour ecraser) ---
$RootFiles = @('.ragignore', '.mcp-access', '.gitignore', '.gitmodules', '.env', '.env.example')
$rootResults = @()
foreach ($name in $RootFiles) {
    $src = Join-Path $KitRoot $name
    $dst = Join-Path $Target $name
    if (-not (Test-Path $src)) { $rootResults += "$name : absent-source"; continue }
    if ((Test-Path $dst) -and -not $Force) { $rootResults += "$name : conserve (existant)"; continue }
    $action = if (Test-Path $dst) { 'ecrase (-Force)' } else { 'depose' }
    if ($DryRun) { Write-Host "  COPY $name" }
    else { Copy-Item $src $dst -Force }
    $rootResults += "$name : $action"
}

$mode = if ($DryRun) { '[DRY-RUN]' } else { '' }
Write-Host "$mode $copied fichier(s) .agent a synchroniser vers $Dest ($skipped ignores runtime)" -ForegroundColor Green
Write-Host "$mode .vscode : $vsCopied depose(s), $vsKept conserve(s) | $($rootResults -join ' | ')" -ForegroundColor Green
Write-Host "Note: les fichiers propres au projet (rules/local_rules.md, etc.) sont preserves." -ForegroundColor DarkGray
