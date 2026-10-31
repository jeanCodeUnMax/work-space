<#
.SYNOPSIS
  Hephaistos2-Kit — installation runtime (indexation NTFS + MCP unifié Rust).

.DESCRIPTION
  Séparation stricte PROJET / INSTALL :
    - PROJET  : dossier contenant ce script (auto-détecté, ou -ProjectRoot)
    - INSTALL : %ProgramFiles%\servers\hephaistos2-kit par défaut
                (ou -InstallRoot, ou env HPHE_INSTALL)

  Aucun chemin n'est obligatoire : tout se déduit du script ou se surcharge
  par paramètre / variable d'environnement. Si une install précédente existe,
  ses chemins mémoire/ingestion sont réutilisés (rien n'est cassé).

  Étapes :
    0. Sous-modules git + npm install .agent/agent-bridge   [-SkipDeps]
    1. Build Rust (cargo build --release) dans PROJET        [-SkipBuild]
    2. Déploiement binaires -> INSTALL\extension\server\ (hphe-mcp, hphe-rest, hphe-indexd)
    3. Données runtime -> INSTALL\data, migrated-vec, memory-database
    4. Config MCP Devin -> chemins INSTALL
    5. Auto-start REST + boucle d'ingestion (Startup folder)
    6. Tâche planifiée démon hphe-indexd                      [-Elevated]

.PARAMETER ProjectRoot
  Racine du dépôt. Défaut : le dossier du script (portable, aucun chemin codé).

.PARAMETER InstallRoot
  Dossier runtime (binaires + data). Défaut : env HPHE_INSTALL, sinon
  %ProgramFiles%\servers\hephaistos2-kit.

.PARAMETER MemoryRoot
  Racine des bases mémoire (agentmemory). Défaut : env HPHE_MEMORY_ROOT,
  sinon la valeur d'une install existante, sinon <InstallRoot>\data\agentmemory.

.PARAMETER IngestScan
  Racines scannées par la boucle d'ingestion. Défaut : env HPHE_INGEST_SCAN,
  sinon la valeur d'une install existante, sinon le projet.

.PARAMETER EverythingRoots
  Racines autorisées du profil MCP (séparées par ;). Défaut : env
  EVERYTHING_MCP_ROOTS, sinon install existante, sinon projet + install + bureau.

.PARAMETER CheckOnly
  Mode sec : résout les chemins, vérifie sous-modules/dépendances/binaires,
  n'écrit rien. Idéal pour valider une machine avant l'installation réelle.

.PARAMETER SkipDeps
  Saute l'étape 0 (git submodule update --init --recursive + npm install).

.PARAMETER SkipBuild
  Ne rebuild pas les crates Rust — réutilise les binaires existants du projet.

.PARAMETER Elevated
  Requis pour (re)créer la tâche planifiée hphe-indexd en SYSTEM.

.PARAMETER SkipVerify
  Saute les vérifications d'intégration finales.
#>
param(
    [string]$ProjectRoot = $PSScriptRoot,
    [string]$InstallRoot = $(if ($env:HPHE_INSTALL) { $env:HPHE_INSTALL } else { '' }),
    [string]$MemoryRoot = '',
    [string]$IngestScan = '',
    [string]$EverythingRoots = '',
    [switch]$CheckOnly,
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [switch]$Elevated,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$PRJ  = (Resolve-Path $ProjectRoot).Path
if (-not $InstallRoot) {
  if ($env:HPHE_INSTALL) { $InstallRoot = $env:HPHE_INSTALL }
  else {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $InstallRoot = if ($isAdmin) { Join-Path $env:ProgramFiles 'servers\hephaistos2-kit' } else { Join-Path $env:LOCALAPPDATA 'hephaistos2-kit' }
  }
}
$INS  = $InstallRoot
$SRV  = "$INS\extension\server"
$DATA = "$INS\data"

Write-Host "=== Hephaistos2-Kit install (PROJET -> INSTALL) ===" -ForegroundColor Cyan
Write-Host "  projet : $PRJ`n  install: $INS"

if (-not (Test-Path $PRJ)) { throw "PROJET introuvable : $PRJ (lancer depuis la racine du depot ou passer -ProjectRoot)" }

# --- Mode sec : rapport sans rien écrire -------------------------------------
if ($CheckOnly) {
  Write-Host "[check] sous-modules git :"
  if (Test-Path "$PRJ\.gitmodules") {
    Push-Location $PRJ
    git submodule status 2>&1 | ForEach-Object { Write-Host "  $_" }
    Pop-Location
    $empty = git -C $PRJ submodule status 2>$null | Where-Object { $_ -match '^[-+]' }
    if ($empty) { Write-Warning "sous-modules non initialisés/divergents — git submodule update --init --recursive" }
  } else { Write-Host "  (pas de .gitmodules)" }
  Write-Host ("[check] hphe workspace : " + ($(if (Test-Path "$PRJ\hphe\Cargo.toml") { 'OK' } else { 'MANQUANT' })))
  Write-Host ("[check] agent-bridge ws : " + ($(if (Test-Path "$PRJ\.agent\agent-bridge\node_modules\ws") { 'OK' } else { 'absent — npm install requis' })))
  Write-Host ("[check] binaires release : " + (('hphe-mcp.exe','hphe-rest.exe','hphe-indexd.exe','hphe-content.exe' | ForEach-Object { if (Test-Path "$PRJ\hphe\target\release\$_") { $_ } }) -join ', '))
  Write-Host "[check] INSTALL cible : $INS (existant: $(Test-Path $INS))"
  Write-Host "[check] mcp_config : $env:APPDATA\devin\mcp_config.json (existant: $(Test-Path "$env:APPDATA\devin\mcp_config.json"))"
  $acpScript = "$PRJ\.agent\setup\setup-devin-acp.mjs"
  if (Test-Path $acpScript) {
    Write-Host "[check] agents ACP Devin (devin.acp.* dans settings.json) :"
    & node $acpScript --verify
  } else { Write-Warning "setup-devin-acp.mjs introuvable : $acpScript" }
  Write-Host "[check] rien d'écrit — relancer sans -CheckOnly pour installer"
  exit 0
}

# 0) Dépendances du dépôt : sous-modules + npm --------------------------------
# IMPORTANT : tourne AVANT la validation hphe/ — sur un clone frais les
# sous-modules (hphe, extension, orchestrator-monitor) sont vides.
if (-not $SkipDeps) {
  Write-Host "[0/6] sous-modules git + dependances npm"
  if (Test-Path "$PRJ\.gitmodules") {
    Push-Location $PRJ
    git submodule update --init --recursive 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Write-Warning "git submodule update a echoue (code $LASTEXITCODE) - verifier 'git submodule status'" }
    Pop-Location
  }
  $bridgePkg = "$PRJ\.agent\agent-bridge\package.json"
  if ((Test-Path $bridgePkg) -and -not (Test-Path "$PRJ\.agent\agent-bridge\node_modules\ws")) {
    Push-Location "$PRJ\.agent\agent-bridge"
    npm install --omit=dev 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Write-Warning "npm install agent-bridge a echoue - le canal binome (ws) sera indisponible" }
    Pop-Location
  } else { Write-Host "  + agent-bridge dependances deja presentes" }
} else { Write-Host "[0/6] dependances sautees" }

# Validation post-init : le workspace Rust doit être présent (sous-module hphe)
if (-not (Test-Path "$PRJ\hphe\Cargo.toml")) {
  throw "workspace Rust hphe/ introuvable : sous-module non initialisé. Corriger avec : git submodule update --init --recursive"
}

# Réutilise les chemins d'une install existante (aucun template cassé) ---------
$prevCmd = "$SRV\hphe-rest.cmd"
$prev = @{}
if (Test-Path $prevCmd) {
  foreach ($line in (Get-Content $prevCmd -ErrorAction SilentlyContinue)) {
    if ($line -match '^set\s+([A-Z_]+)=(.+)$') { $prev[$Matches[1]] = $Matches[2].Trim() }
  }
}
if (-not $MemoryRoot)      { $MemoryRoot      = if ($env:HPHE_MEMORY_ROOT)      { $env:HPHE_MEMORY_ROOT }      elseif ($prev['HPHE_MEMORY_ROOT'])      { $prev['HPHE_MEMORY_ROOT'] }      else { "$DATA\agentmemory" } }
if (-not $IngestScan)      { $IngestScan      = if ($env:HPHE_INGEST_SCAN)      { $env:HPHE_INGEST_SCAN }      elseif ($prev['HPHE_INGEST_SCAN'])      { $prev['HPHE_INGEST_SCAN'] }      else { $PRJ } }
if (-not $EverythingRoots) { $EverythingRoots = if ($env:EVERYTHING_MCP_ROOTS)  { $env:EVERYTHING_MCP_ROOTS }  elseif ($prev['EVERYTHING_MCP_ROOTS'])  { $prev['EVERYTHING_MCP_ROOTS'] }  else { (@($PRJ, $INS, $MemoryRoot, [Environment]::GetFolderPath('Desktop')) | Where-Object { $_ -and (Test-Path $_) }) -join ';' } }

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
foreach ($bin in 'hphe-mcp.exe','hphe-rest.exe','hphe-indexd.exe','hphe-content.exe') {
  Copy-Item "$SRV\$bin" "$PRJ\extension\server\" -Force -ErrorAction SilentlyContinue
}

# wrappers .cmd dans INSTALL
@"
@echo off
rem Hephaistos REST gateway + boucle d'ingestion automatisee
rem Securise (revue) : profil d'acces [rest] borne + roots + auth token
rem (HPHE_REST_TOKEN env ou $DATA\hphe-rest.token genere au boot).
set HPHE_CONTENT_DIR=$DATA\content-index
set HPHE_VEC_DIR=$INS\migrated-vec
set HPHE_ORCH_DB=$DATA\orchestrator.db
set HPHE_MEMORY_ROOT=$MemoryRoot
set HPHE_INGEST_ROOTS=$PRJ
set HPHE_INGEST_SCAN=$IngestScan
set HPHE_INGEST_INTERVAL_S=900
set EVERYTHING_MCP_ACCESS_FILE=%~dp0.mcp-access
set EVERYTHING_MCP_ROOTS=$EverythingRoots
:loop
"$SRV\hphe-rest.exe" --addr 127.0.0.1:8792 --profile rest >> "$DATA\hphe-rest.log" 2>&1
echo %DATE% %TIME% hphe-rest termine - relance dans 10s >> "$DATA\hphe-rest.log"
timeout /t 10 /nobreak >nul
goto loop
"@ | Set-Content "$SRV\hphe-rest.cmd" -Encoding ASCII

# politique d'accès à côté du .cmd (le wrapper la pointe via EVERYTHING_MCP_ACCESS_FILE)
# Le fichier du repo est un template à tokens <...> ; on le rend ici avec les
# chemins résolus. Une politique déjà déployée n'est JAMAIS écrasée.
$accTmpl = "$PRJ\extension\server\.mcp-access"
$accOut  = "$SRV\.mcp-access"
if ((Test-Path $accTmpl) -and -not (Test-Path $accOut)) {
  $acc = Get-Content $accTmpl -Raw
  $acc = $acc.Replace('<INGEST_SCAN_ROOT>', ($IngestScan -replace '\\','/')).
              Replace('<PROJECT_ROOT>', ($PRJ -replace '\\','/')).
              Replace('<INSTALL_ROOT>', ($INS -replace '\\','/')).
              Replace('<MEMORY_ROOT>', ($MemoryRoot -replace '\\','/')).
              Replace('<USER_PROFILE>', ($env:USERPROFILE -replace '\\','/'))
  Set-Content $accOut -Value $acc -Encoding ASCII
  Write-Host "  + .mcp-access rendu -> $accOut"
} elseif (Test-Path $accOut) { Write-Host "  + .mcp-access existant conservé" }

@"
@echo off
rem Ingestion incrementale automatisee
set HPHE_CONTENT_DIR=$DATA\content-index
set HPHE_VEC_DIR=$INS\migrated-vec
"$SRV\hphe-mcp.exe" --tool content_ingest --args "{\`"root\`":\`"$PRJ\`",\`"project_tag\`":\`"$(Split-Path -Leaf $PRJ)\`"}"
"@ | Set-Content "$SRV\hphe-ingest.cmd" -Encoding ASCII
Write-Host "  + hphe-rest.cmd / hphe-ingest.cmd"

# 3) Données runtime -> INSTALL ------------------------------------------------
Write-Host "[3/6] données runtime"
New-Item -ItemType Directory -Force "$DATA\content-index" | Out-Null
$orchBackup = Join-Path (Split-Path $INS -Parent) 'servers_backup\orchestrator-server\data\orchestrator.db'
if (-not (Test-Path "$DATA\orchestrator.db") -and (Test-Path $orchBackup)) {
  Copy-Item $orchBackup "$DATA\"
}
if (-not (Test-Path "$INS\memory-database")) {
  # Jonction vers une base mémoire externe seulement si la cible existe ;
  # sinon dossier réel local — jamais de lien mort silencieux.
  $memDbTarget = if ($env:HPHE_MEMORY_DB) { $env:HPHE_MEMORY_DB } elseif ($MemoryRoot -and (Test-Path $MemoryRoot) -and $MemoryRoot -notlike "$INS*") { $MemoryRoot } else { '' }
  if ($memDbTarget) {
    cmd /c mklink /J "$INS\memory-database" "$memDbTarget" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$INS\memory-database")) {
      Write-Warning "jonction memory-database -> $memDbTarget a echoue ; dossier local cree a la place"
      New-Item -ItemType Directory -Force "$INS\memory-database" | Out-Null
    }
  } else {
    New-Item -ItemType Directory -Force "$INS\memory-database" | Out-Null
  }
}
if (-not (Test-Path "$INS\migrated-vec")) { New-Item -ItemType Directory -Force "$INS\migrated-vec" | Out-Null }
Write-Host "  + content-index, orchestrator.db, memory-database, migrated-vec"

# Seed orchestrateur : roster agents (nim1/nim2 workers directs, kilo/hermes
# renforts, agy/devin) + provider_prefs (chaîne par défaut). Idempotent :
# n'insère que les agents absents, ne seede provider_prefs que si vide.
$seed = "$PRJ\.agent\scripts\seed-orchestrator.mjs"
if (Test-Path $seed) {
  node $seed --db "$DATA\orchestrator.db" | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "  + orchestrator.db seedé (agents + provider_prefs)" }
  else { Write-Warning "seed-orchestrator a échoué (code $LASTEXITCODE) — roster à créer manuellement" }
} else { Write-Warning "seed-orchestrator.mjs introuvable : $seed" }

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
      HPHE_MEMORY_ROOT = ($MemoryRoot -replace '\\','/')
      HPHE_PIPE        = '\.\pipe\hphe-index'
    }
  }
  if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  $cfg.mcpServers | Add-Member -NotePropertyName 'Hephaistos-everything-search' -NotePropertyValue $es -Force
  if ($cfg.mcpServers.PSObject.Properties['everything-search']) {
    $cfg.mcpServers.PSObject.Properties.Remove('everything-search')
  }
  # sqlite-node : garantir les alias multi-bases (KG memory/graph + cache + orchestrator).
  # Sans ce bloc, les alias tombent en fallback silencieux sur ORCHESTRATOR_DB (régression 2026-10-22).
  $dbRoot = if ($env:AGENT_DB_ROOT) { $env:AGENT_DB_ROOT } else { 'F:/Sqlite-DB' }
  $sn = [pscustomobject]@{
    command = 'node'
    args    = @('C:/PROGRA~1/servers/MCP-QU~1/dist/sqlite-node-launch.mjs')
    env     = [pscustomobject]@{
      AGENT_DB_ROOT   = $dbRoot
      CACHE_DB        = "$dbRoot/current_workspace/cache/runtime-cache.db"
      CACHE_TABLE     = 'cache_table'
      DEFAULT_DB_PATH = "$dbRoot/current_workspace/agentmemory/graph/memory_mcp.db"
      DISABLE_DEBUG   = 'true'
      GRAPH_DB        = "$dbRoot/current_workspace/agentmemory/graph/graph-memory.db"
      LOG_LEVEL       = 'error'
      MEMORY_DB       = "$dbRoot/current_workspace/agentmemory/graph/memory_mcp.db"
      ORCHESTRATOR_DB = "$DATA/orchestrator.db"
      TTL_HOURS       = '1'
    }
  }
  $cfg.mcpServers | Add-Member -NotePropertyName 'sqlite-node' -NotePropertyValue $sn -Force
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

# 6c) taskwatch — veille de la file orchestrateur (comble le trou create_task
#     qui ne notifie personne). Poll list_tasks toutes les 5 min, notifie sur le
#     bus comms.jsonl + inject ACP pour devin. -----------------------------------
Write-Host "[6c] taskwatch -> $SRV\taskwatch.mjs"
Copy-Item "$PRJ\tools\taskwatch.mjs" "$SRV\taskwatch.mjs" -Force
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'C:\nvm4w\nodejs\node.exe' }
# CRLF obligatoire pour cmd.exe ; le repertoire $DATA est cree plus haut dans l'install
# HPHE_WORKSPACE : workspace surveillé (par défaut la racine du projet,
# surchargeable via HPHE_WATCH_WORKSPACE) — jamais de chemin en dur dans taskwatch.mjs.
$watchWs = $(if ($env:HPHE_WATCH_WORKSPACE) { $env:HPHE_WATCH_WORKSPACE } else { $PRJ })
@('@echo off','rem taskwatch - poll orchestrateur pending toutes les 5 min (tache hphe-taskwatch)',"set `"HPHE_WORKSPACE=$watchWs`"","`"$nodeExe`" `"$SRV\taskwatch.mjs`" >> `"$DATA\taskwatch.log`" 2>&1") |
  Set-Content "$SRV\taskwatch-run.cmd" -Encoding ASCII
if ($Elevated) {
  # SYSTEM + HIGHEST : tourne session fermée ou verrouillée ; batterie désactivée.
  # New-ScheduledTaskAction évite le bug de quoting schtasks sur les chemins avec espaces.
  $act = New-ScheduledTaskAction -Execute "$SRV\taskwatch-run.cmd"
  $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName 'hphe-taskwatch' -Action $act -Trigger $trg -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName 'hphe-taskwatch'
  Write-Host "  + hphe-taskwatch (SYSTEM, 5 min) enregistree"
  [Environment]::SetEnvironmentVariable('HEPHAISTOS_WATCHDOG','1','User')
  $env:HEPHAISTOS_WATCHDOG='1'
  Write-Host "  + HEPHAISTOS_WATCHDOG=1 (env User) - watchdog unifie actif"
} else {
  Write-Host "  taskwatch : relancer en admin avec -Elevated pour enregistrer hphe-taskwatch"
}

# 6a) MCP muxé : les configs clientes (Devin, AGY) passent par le broker partagé --
$muxScript = "$PRJ\.agent\setup\setup-mcp-mux.mjs"
if (Test-Path $muxScript) {
  Write-Host "[MUX] configs MCP -> broker mcp-mux partagé"
  & node $muxScript
  if ($LASTEXITCODE -ne 0) { Write-Warning "mux MCP en échec — voir ci-dessus" }
} else { Write-Warning "setup-mcp-mux.mjs introuvable : $muxScript" }

# 6b) Agents ACP dans Devin (enabledAgents / agentEnv / agentPreferences) ----------
$acpScript = "$PRJ\.agent\setup\setup-devin-acp.mjs"
if (Test-Path $acpScript) {
  Write-Host "[ACP] provision devin.acp.* dans %APPDATA%\devin\User\settings.json"
  & node $acpScript
  if ($LASTEXITCODE -ne 0) { Write-Warning "provisioning ACP en échec — voir ci-dessus" }
} else { Write-Warning "setup-devin-acp.mjs introuvable : $acpScript" }

# 7) Vérifications post-installation (extension, bridge, surfaces, binôme) --------
if (-not $SkipVerify) {
  Write-Host "`n=== [Vérifications d'intégration] ===" -ForegroundColor Cyan

  # a) Extension orchestrator-monitor (>= 0.0.58, injection ACP stdio)
  $expectedExtVer = '0.0.58'
  $extDirs = @()
  $extDirs += Get-ChildItem "$env:USERPROFILE\.devin\extensions\hephaistos.orchestrator-monitor-*" -ErrorAction SilentlyContinue
  $extDirs += Get-ChildItem "$env:USERPROFILE\.vscode\extensions\hephaistos.orchestrator-monitor-*" -ErrorAction SilentlyContinue
  $foundExt = $null
  foreach ($d in $extDirs) {
    $pkg = Join-Path $d.FullName 'package.json'
    if (Test-Path $pkg) {
      try {
        $v = (Get-Content $pkg -Raw | ConvertFrom-Json).version
        if (-not $foundExt -or [version]$v -gt [version]$foundExt) { $foundExt = $v }
      } catch {}
    }
  }
  if ($foundExt -and [version]$foundExt -ge [version]$expectedExtVer) {
    Write-Host "  [OK]   orchestrator-monitor v$foundExt installée (attendue >= $expectedExtVer)" -ForegroundColor Green
  } else {
    Write-Warning "orchestrator-monitor >= $expectedExtVer non détectée dans les extensions IDE (exécuter .agent\setup\install-extension-hub.ps1)"
  }

  # a1) MCP muxé
  $muxScript = "$PRJ\.agent\setup\setup-mcp-mux.mjs"
  if (Test-Path $muxScript) {
    & node $muxScript --verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  [OK]   configs MCP muxées (broker partagé)" -ForegroundColor Green
    } else {
      Write-Warning "configs MCP non muxées - exécuter: node .agent\setup\setup-mcp-mux.mjs"
    }
  }

  # a2) Agents ACP Devin
  $acpScript = "$PRJ\.agent\setup\setup-devin-acp.mjs"
  if (Test-Path $acpScript) {
    & node $acpScript --verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  [OK]   agents ACP Devin conformes (enabledAgents/env/prefs)" -ForegroundColor Green
    } else {
      Write-Warning "agents ACP Devin non conformes - exécuter: node .agent\setup\setup-devin-acp.mjs"
    }
  }

  # b) WS Bridge 7477
  $tcp7477 = $false
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect('127.0.0.1', 7477)
    $tcp.Close()
    $tcp7477 = $true
  } catch {}
  if ($tcp7477) {
    Write-Host "  [OK]   WS Bridge actif sur 127.0.0.1:7477" -ForegroundColor Green
  } else {
    Write-Warning "WS Bridge 7477 inactif (démarre avec l'extension monitor dans Devin ou via .agent\bootstrap.ps1)"
  }

  # c) Surfaces de règles (devin, claude, windsurf, gemini)
  $surfScript = "$PRJ\.agent\setup\setup-agent-surfaces.ps1"
  if (Test-Path $surfScript) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $surfScript -Verify 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  [OK]   surfaces de règles conformes (devin, claude, windsurf, gemini)" -ForegroundColor Green
    } else {
      Write-Warning "surfaces de règles non conformes - exécuter: pwsh -File .agent\setup\setup-agent-surfaces.ps1"
    }
  }

  # d) Canal binôme / IDs publiés
  $commsPath = "$PRJ\.agent\comms.jsonl"
  if (Test-Path $commsPath) {
    $cLines = Get-Content $commsPath -Tail 80 -ErrorAction SilentlyContinue
    $hasDevin = $cLines | Where-Object { $_ -match '"src":"devin"' -and $_ -match '"convId":' }
    $hasAgy   = $cLines | Where-Object { $_ -match '"src":"agy"' -and $_ -match '"convId":' }
    if ($hasDevin -and $hasAgy) {
      Write-Host "  [OK]   canal binôme configuré (IDs devin et agy publiés dans comms.jsonl)" -ForegroundColor Green
    } else {
      Write-Host "  [INFO] canal binôme : exécuter 'node .agent/agent-bridge/binome.js join' pour apparier" -ForegroundColor DarkGray
    }
  }
}

Write-Host "`n=== Terminé — redémarrer l'IDE ===" -ForegroundColor Green
