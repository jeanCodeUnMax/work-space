<#
.SYNOPSIS
  Hephaistos2-Kit — installation runtime (indexation NTFS + MCP unifié Rust).

.DESCRIPTION
  Séparation stricte PROJET / INSTALL :
    - PROJET  : C:\Program Files\Projet-complet\hephaistos2-kit  (sources, .agent, git)
    - INSTALL : C:\Program Files\servers\hephaistos2-kit         (runtime : binaires + data)

  Étapes :
    1. Build Rust (cargo build --release) dans PROJET   [-SkipBuild]
    2. Déploiement binaires -> INSTALL\extension\server\ (hphe-mcp, hphe-rest, hphe-indexd)
    3. Données runtime -> INSTALL\data, migrated-vec, memory-database
    4. Config MCP Devin -> chemins INSTALL
    5. Auto-start REST + boucle d'ingestion (Startup folder)
    6. Tâche planifiée démon hphe-indexd                 [-Elevated]

.PARAMETER SkipBuild
  Ne rebuild pas les crates Rust — réutilise les binaires existants du projet.
.PARAMETER Elevated
  Requis pour (re)créer la tâche planifiée hphe-indexd en SYSTEM.
#>
param([switch]$SkipBuild, [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$PRJ  = 'C:\Program Files\Projet-complet\hephaistos2-kit'
$INS  = 'C:\Program Files\servers\hephaistos2-kit'
$SRV  = "$INS\extension\server"
$DATA = "$INS\data"

Write-Host "=== Hephaistos2-Kit install (PROJET -> INSTALL) ===" -ForegroundColor Cyan
Write-Host "  projet : $PRJ`n  install: $INS"

if (-not (Test-Path "$PRJ\hphe\Cargo.toml")) { throw "PROJET introuvable : $PRJ" }

# 1) Build dans le PROJET ----------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "[1/6] cargo build --release (dans projet) ..."
  Push-Location "$PRJ\hphe"; cargo build --release --workspace; Pop-Location
} else { Write-Host "[1/6] build sauté" }

# 2) Binaires -> INSTALL ------------------------------------------------------
Write-Host "[2/6] déploiement binaires -> $SRV"
New-Item -ItemType Directory -Force $SRV | Out-Null
foreach ($bin in 'hphe-mcp.exe','hphe-rest.exe','hphe-indexd.exe','hphe-content.exe') {
  $src = "$PRJ\hphe\target\release\$bin"
  if (Test-Path $src) { Copy-Item $src $SRV -Force; Write-Host "  + $bin" }
}
# miroir dans le projet (pour tests dev depuis la racine projet)
New-Item -ItemType Directory -Force "$PRJ\extension\server" | Out-Null
Copy-Item "$SRV\hphe-mcp.exe"   "$PRJ\extension\server\" -Force -ErrorAction SilentlyContinue
Copy-Item "$SRV\hphe-rest.exe"  "$PRJ\extension\server\" -Force -ErrorAction SilentlyContinue
Copy-Item "$SRV\hphe-indexd.exe" "$PRJ\extension\server\" -Force -ErrorAction SilentlyContinue

# wrappers .cmd dans INSTALL
@"
@echo off
rem Hephaistos REST gateway + boucle d'ingestion automatisee
set HPHE_CONTENT_DIR=$DATA\content-index
set HPHE_VEC_DIR=$INS\migrated-vec
set HPHE_ORCH_DB=$DATA\orchestrator.db
set HPHE_MEMORY_ROOT=F:\Sqlite-DB\agentmemory
set HPHE_INGEST_ROOTS=$PRJ
set HPHE_INGEST_INTERVAL_S=900
"$SRV\hphe-rest.exe" --addr 127.0.0.1:8792 >> "$DATA\hphe-rest.log" 2>&1
"@ | Set-Content "$SRV\hphe-rest.cmd" -Encoding ASCII

@"
@echo off
rem Ingestion incrementale automatisee
set HPHE_CONTENT_DIR=$DATA\content-index
set HPHE_VEC_DIR=$INS\migrated-vec
"$SRV\hphe-mcp.exe" --tool content_ingest --args "{\`"root\`":\`"$PRJ\`",\`"project_tag\`":\`"hephaistos2-kit\`"}"
"@ | Set-Content "$SRV\hphe-ingest.cmd" -Encoding ASCII
Write-Host "  + hphe-rest.cmd / hphe-ingest.cmd"

# 3) Données runtime -> INSTALL ------------------------------------------------
Write-Host "[3/6] données runtime"
New-Item -ItemType Directory -Force "$DATA\content-index" | Out-Null
if (-not (Test-Path "$DATA\orchestrator.db") -and (Test-Path 'C:\Program Files\servers\servers_backup\orchestrator-server\data\orchestrator.db')) {
  Copy-Item 'C:\Program Files\servers\servers_backup\orchestrator-server\data\orchestrator.db' "$DATA\"
}
if (-not (Test-Path "$INS\memory-database")) {
  cmd /c mklink /J "$INS\memory-database" "F:\Sqlite-DB\current_workspace" | Out-Null
}
if (-not (Test-Path "$INS\migrated-vec")) { New-Item -ItemType Directory -Force "$INS\migrated-vec" | Out-Null }
Write-Host "  + content-index, orchestrator.db, memory-database, migrated-vec"

# 4) Config MCP Devin -> INSTALL ------------------------------------------------
Write-Host "[4/6] mcp_config.json (Devin)"
$cfgPath = "$env:APPDATA\devin\mcp_config.json"
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $es = [pscustomobject]@{
    command = "$SRV/hphe-mcp.exe"
    args    = @()
    env     = [pscustomobject]@{
      HPHE_CONTENT_DIR = "$DATA/content-index"
      HPHE_VEC_DIR     = "$INS/migrated-vec"
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
  Write-Host "  + Hephaistos-everything-search -> $SRV\hphe-mcp.exe"
} else { Write-Warning "mcp_config.json introuvable : $cfgPath" }

# 5) Autostart REST -------------------------------------------------------------
Write-Host "[5/6] autostart hphe-rest (Startup)"
$startup = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\hphe-rest.cmd"
@"
@echo off
start "" /min "$SRV\hphe-rest.cmd"
"@ | Set-Content $startup -Encoding ASCII

# 6) Tâche planifiée démon --------------------------------------------------------
if ($Elevated) {
  Write-Host "[6/6] tâche hphe-indexd -> $SRV\hphe-indexd.exe"
  schtasks /create /tn hphe-indexd /sc ONSTART /ru SYSTEM /rl HIGHEST /tr "`"$SRV\hphe-indexd.exe`"" /f | Out-Null
  schtasks /run /tn hphe-indexd | Out-Null
} else {
  Write-Host "[6/6] tâche planifiée : relancer en admin avec -Elevated"
}

Write-Host "`n=== Terminé — redémarrer l'IDE ===" -ForegroundColor Green
