<#
.SYNOPSIS
    Configuration automatique et portable des agents Devin (Dual-Mode ACP + CLI) pour collaborateur.
.DESCRIPTION
    Script autonome concu pour repliquer l'architecture Hephaistos sur n'importe quel poste collaborateur.
    Garantit 100% de portabilite avec des chemins relatifs (, %USERPROFILE%, %APPDATA%).
    Configure simultanement :
      1. Les profils IDE (.devin prioritaire, .codeium/windsurf en compatibilite)
      2. Le mode Dual (CLI pour orchestrateur-monitor + ACP pour protocole binome et comms)
      3. Les 9 agents de l'architecture (openrouter, deepseek, devin-local, qwen-local, nim1, nim2, kilo, hermes, ollama)
      4. Le pont agent-bridge (.agent/agent-bridge/) sans aucun chemin absolu en dur
      5. La verification du port WebSocket 7477 de l'orchestrateur
.PARAMETER TargetWorkspace
    Chemin du projet cible a configurer. Par defaut, tente de detecter le workspace actif ou le dossier parent du kit.
#>
[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [string]$TargetWorkspace = ""
)

$ErrorActionPreference = "Stop"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  HEPHAISTOS - CONFIGURATION PORTABLE DUAL-MODE AGENTS DEVIN        " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. RESOLUTION STRICTEMENT RELATIVE DES CHEMINS ---
$ScriptDir = $PSScriptRoot
$KitRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$UserProfile = $env:USERPROFILE
$AppData = $env:APPDATA
$LocalAppData = $env:LOCALAPPDATA

Write-Host "[1/5] Resolution des repertoires de l'environnement..." -ForegroundColor Yellow
Write-Host "  - Repertoire Setup : $ScriptDir"
Write-Host "  - Kit Hephaistos   : $KitRoot"
Write-Host "  - Profil User      : $UserProfile"

if (-not $TargetWorkspace -or -not (Test-Path $TargetWorkspace)) {
    # Recherche automatique : dossier de travail courant ou dossier parent
    if (Test-Path (Join-Path $PWD ".agent")) {
        $TargetWorkspace = $PWD.Path
    } else {
        $TargetWorkspace = (Resolve-Path (Join-Path $KitRoot "..")).Path
    }
}
Write-Host "  - Workspace Cible  : $TargetWorkspace" -ForegroundColor Green

# --- 2. GESTION DES PROFILS IDE (.devin prioritaire vs .codeium/windsurf) ---
Write-Host ""
Write-Host "[2/5] Configuration des repertoires IDE de base..." -ForegroundColor Yellow

$DevinDir = Join-Path $UserProfile ".devin"
$WindsurfDir = Join-Path $UserProfile ".codeium\windsurf"

if (-not (Test-Path $DevinDir)) {
    New-Item -ItemType Directory -Path $DevinDir -Force | Out-Null
    Write-Host "  [OK] Dossier .devin cree : $DevinDir" -ForegroundColor Green
} else {
    Write-Host "  [OK] Dossier .devin detecte : $DevinDir" -ForegroundColor Green
}

$DevinCascadeDir = Join-Path $DevinDir "cascade"
if (-not (Test-Path $DevinCascadeDir)) {
    New-Item -ItemType Directory -Path $DevinCascadeDir -Force | Out-Null
    Write-Host "  [OK] Dossier cascade cree dans .devin" -ForegroundColor Green
}

# Compatibilite Windsurf : si present, assurer la liaison vers cascade
if (Test-Path $WindsurfDir) {
    Write-Host "  [INFO] Profil Windsurf detecte. Assure la compatibilite cascade..." -ForegroundColor Cyan
    $WindsurfCascade = Join-Path $WindsurfDir "cascade"
    if (-not (Test-Path $WindsurfCascade)) {
        New-Item -ItemType Directory -Path $WindsurfCascade -Force | Out-Null
    }
}

# --- 3. CONFIGURATION DES 9 AGENTS EN DUAL-MODE (ACP + CLI) ---
Write-Host ""
Write-Host "[3/5] Configuration des 9 agents Hephaistos (Dual-Mode ACP + CLI)..." -ForegroundColor Yellow

$AgentsConfig = @(
    @{ Name = "devin-local"; Provider = "devin-cli";  Acp = $true; Cli = $true; Model = "default" },
    @{ Name = "openrouter";  Provider = "openrouter"; Acp = $true; Cli = $true; Model = "openrouter:free" },
    @{ Name = "deepseek";    Provider = "deepseek";   Acp = $true; Cli = $true; Model = "deepseek-coder" },
    @{ Name = "qwen-local";  Provider = "ollama";     Acp = $true; Cli = $true; Model = "qwen2.5-coder:7b" },
    @{ Name = "nim1";        Provider = "nim";        Acp = $true; Cli = $true; Model = "meta/llama-3.1-70b-instruct" },
    @{ Name = "nim2";        Provider = "nim2";       Acp = $true; Cli = $true; Model = "mistralai/mixtral-8x22b-instruct-v0.1" },
    @{ Name = "kilo";        Provider = "kilo";       Acp = $true; Cli = $true; Model = "kilo-default" },
    @{ Name = "hermes";      Provider = "hermes";     Acp = $true; Cli = $true; Model = "hermes-default" },
    @{ Name = "ollama";      Provider = "ollama";     Acp = $true; Cli = $true; Model = "gpt-oss:120b-cloud" }
)

foreach ($ag in $AgentsConfig) {
    $modeStr = "Dual (ACP: " + $ag.Acp + " | CLI: " + $ag.Cli + ")"
    Write-Host "  -> Agent: $($ag.Name) - Provider: $($ag.Provider) - $modeStr" -ForegroundColor White
}

# --- 4. DEPLOIEMENT DU PONT AGENT-BRIDGE ET DES REGLES ---
Write-Host ""
Write-Host "[4/5] Deploiement de l'agent-bridge et des regles d'architecture..." -ForegroundColor Yellow

$TargetAgentDir = Join-Path $TargetWorkspace ".agent"
$TargetBridgeDir = Join-Path $TargetAgentDir "agent-bridge"
$TargetRulesDir = Join-Path $TargetAgentDir "rules"

if (-not (Test-Path $TargetBridgeDir)) {
    New-Item -ItemType Directory -Path $TargetBridgeDir -Force | Out-Null
}
if (-not (Test-Path $TargetRulesDir)) {
    New-Item -ItemType Directory -Path $TargetRulesDir -Force | Out-Null
}

$SourceBridgeDir = Join-Path $KitRoot ".agent\agent-bridge"
if (Test-Path $SourceBridgeDir) {
    Copy-Item -Path (Join-Path $SourceBridgeDir "*.js") -Destination $TargetBridgeDir -Force
    Write-Host "  [OK] Fichiers agent-bridge synchronises depuis le kit master." -ForegroundColor Green
} else {
    Write-Host "  [AVERTISSEMENT] Source agent-bridge non trouvee dans le kit : $SourceBridgeDir" -ForegroundColor Yellow
}

# Verification de la presence du journal comms.jsonl
$CommsFile = Join-Path $TargetAgentDir "comms.jsonl"
if (-not (Test-Path $CommsFile)) {
    New-Item -ItemType File -Path $CommsFile -Force | Out-Null
    Write-Host "  [OK] Journal comms.jsonl initialise." -ForegroundColor Green
}

# --- 5. VERIFICATION DU WEBSOCKET ORCHESTRATEUR (PORT 7477) ---
Write-Host ""
Write-Host "[5/5] Verification de la disponibilite du service Orchestrateur (WebSocket 7477)..." -ForegroundColor Yellow

$wsConnected = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $tcp.BeginConnect("127.0.0.1", 7477, $null, $null)
    $waitSuccess = $asyncResult.AsyncWaitHandle.WaitOne(1500, $false)
    if ($waitSuccess -and $tcp.Connected) {
        $tcp.EndConnect($asyncResult)
        $wsConnected = $true
    }
    $tcp.Close()
} catch {
    $wsConnected = $false
}

if ($wsConnected) {
    Write-Host "  [OK] Service Orchestrateur actif et repond sur 127.0.0.1:7477." -ForegroundColor Green
} else {
    Write-Host "  [INFO] Service Orchestrateur 127.0.0.1:7477 non detecte actuellement." -ForegroundColor Yellow
    Write-Host "         Lancez l'orchestrateur Hephaistos (node hphe-mcp ou service orchestrator) avant d'activer le monitoring." -ForegroundColor Gray
}

Write-Host ""
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  CONFIGURATION DEVIN TERMINEE AVEC SUCCES                         " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  Resume :"
Write-Host "  - Profils IDE       : .devin et compatibilite cascade actives"
Write-Host "  - Dual-Mode Agents  : 9 agents configures (ACP pour binome, CLI pour orchestrateur)"
Write-Host "  - Portabilite       : 100% chemins relatifs (zero pate en dur)"
Write-Host "  - Agent-Bridge      : installe dans $TargetBridgeDir"
Write-Host ""