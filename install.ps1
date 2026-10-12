<#
.SYNOPSIS
  Hephaistos2-Kit — installation complète (indexation NTFS + MCP unifié Rust).

.DESCRIPTION
  Installe la structure en une passe :
    1. Build Rust (cargo build --release)          [-SkipBuild pour sauter]
    2. Déploiement binaires -> extension/server/   (hphe-mcp, hphe-rest, hphe-indexd)
    3. Données                                   (orchestrator.db, migrated-vec, content-index)
    4. Config MCP Devin                          (Hephaistos-everything-search)
    5. Auto-start REST + boucle d'ingestion      (Startup folder)
    6. Tâche planifiée démon                     [-Elevated pour schtasks SYSTEM]

.PARAMETER SkipBuild
  Ne rebuild pas les crates Rust — réutilise les binaires existants.
.PARAMETER Elevated
  Requis pour (re)créer la tâche planifiée hphe-indexd en SYSTEM.
#>
param([switch]$SkipBuild, [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$KIT = 'C:\Program Files\servers\hephaistos2-kit'
$SRV = "$KIT\extension\server"
$DATA = "$KIT\data"

Write-Host "=== Hephaistos2-Kit install ===" -ForegroundColor Cyan

# 1) Build ---------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "[1/6] cargo build --release ..."
  Push-Location "$KIT\hphe"; cargo build --release --workspace; Pop-Location
} else { Write-Host "[1/6] build sauté" }

# 2) Binaires -------------------------------------------------------------
Write-Host "[2/6] déploiement binaires"
New-Item -ItemType Directory -Force $SRV | Out-Null
foreach ($bin in 'hphe-mcp.exe','hphe-rest.exe','hphe-indexd.exe','hphe-content.exe') {
  $src = "$KIT\hphe\target\release\$bin"
  if (Test-Path $src) { Copy-Item $src $SRV -Force; Write-Host "  + $bin" }
}

# 3) Données ---------------------------------------------------------------
Write-Host "[3/6] données"
New-Item -ItemType Directory -Force "$DATA\content-index" | Out-Null
if (-not (Test-Path "$DATA\orchestrator.db") -and (Test-Path "$KIT\servers_backup\orchestrator-server\data\orchestrator.db")) {
  Copy-Item "$KIT\servers_backup\orchestrator-server\data\orchestrator.db" "$DATA\" 
}
if (-not (Test-Path "$DATA\orchestrator.db") -and (Test-Path 'C:\Program Files\servers\servers_backup\orchestrator-server\data\orchestrator.db')) {
  Copy-Item 'C:\Program Files\servers\servers_backup\orchestrator-server\data\orchestrator.db' "$DATA\"
}
if (-not (Test-Path "$KIT\memory-database")) {
  cmd /c mklink /J "$KIT\memory-database" "F:\Sqlite-DB\current_workspace" | Out-Null
}
Write-Host "  + content-index, orchestrator.db, memory-database OK"

# 4) Config MCP Devin -------------------------------------------------------
Write-Host "[4/6] mcp_config.json (Devin)"
$cfgPath = "$env:APPDATA\devin\mcp_config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$es = [pscustomobject]@{
  command = "$SRV/hphe-mcp.exe"
  args    = @()
  env     = [pscustomobject]@{
    HPHE_CONTENT_DIR = "$DATA/content-index"
    HPHE_VEC_DIR     = "$KIT/migrated-vec"
    HPHE_ORCH_DB     = "$DATA/orchestrator.db"
    HPHE_MEMORY_ROOT = 'F:/Sqlite-DB/agentmemory'
    HPHE_PIPE        = '\.\pipe\hphe-index'
  }
}
$cfg.mcpServers | Add-Member -NotePropertyName 'Hephaistos-everything-search' -NotePropertyValue $es -Force
if ($cfg.mcpServers.PSObject.Properties['everything-search']) {
  $cfg.mcpServers.PSObject.Properties.Remove('everything-search')
}
$cfg | ConvertTo-Json -Depth 20 | Set-Content $cfgPath -Encoding UTF8
Write-Host "  + Hephaistos-everything-search enregistré"

# 5) Autostart REST ----------------------------------------------------------
Write-Host "[5/6] autostart hphe-rest (Startup)"
$startup = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\hphe-rest.cmd"
@"
@echo off
start "" /min "$SRV\hphe-rest.cmd"
"@ | Set-Content $startup -Encoding ASCII

# 6) Tâche planifiée démon ----------------------------------------------------
if ($Elevated) {
  Write-Host "[6/6] tâche hphe-indexd -> $SRV\hphe-indexd.exe"
  schtasks /create /tn hphe-indexd /sc ONSTART /ru SYSTEM /rl HIGHEST /tr "`"$SRV\hphe-indexd.exe`"" /f | Out-Null
  schtasks /run /tn hphe-indexd | Out-Null
} else {
  Write-Host "[6/6] tâche planifiée : relancer en admin avec -Elevated (ou garder la jonction everything-mcp)"
}

Write-Host "`n=== Terminé — redémarrer l'IDE ===" -ForegroundColor Green
