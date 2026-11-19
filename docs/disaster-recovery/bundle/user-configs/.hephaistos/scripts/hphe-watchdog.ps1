# hphe-watchdog.ps1 — Surveillance et reparation auto du backend Hephaistos.
# Lance par la tache planifiee "hphe-watchdog" (utilisateur, toutes les 2 min).
# Verifie : hphe-indexd (tache SYSTEM) + REST :8792 + ws-hub :7477
#           + mux MCP :5682 + shim /ask :7478 + OmniRoute :20128 + n8n :5678
#           + n8n-ai-gateway :11435 (OpenAI-compatible agy/devin/ollama)
#           + Strata :8080 (LLM local Qwen3.8 125B, 2 GPU — garde au chaud)
#           (le bridge opencli :5694 a ete retire : la connexion registre
#            mcp-mux-local expose deja tous les tools du mux a l'assistant).
# Repare ce qui est tombe, journalise tout dans %USERPROFILE%\.hephaistos\logs\watchdog.log.
# Logs par service relance : mux5682.log, omniroute.log, n8n.log (meme dossier),
# ws-bridge-http.log (.agent\logs\ du workspace hephaistos2-kit).

$LogDir  = "$env:USERPROFILE\.hephaistos\logs"
$LogFile = Join-Path $LogDir "watchdog.log"
$RestCmd = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\hphe-rest.vbs"
$BridgeJs = "C:\Users\webma\.devin\extensions\hephaistos.orchestrator-monitor-0.0.59\ws-bridge\bridge.js"
$BridgeDir = Split-Path $BridgeJs -Parent
$Workspace = 'C:\data-sys\CLI-Anything'
$AbiFlag  = Join-Path $LogDir "watchdog-abi-repaired.flag"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Output $line
}

function Test-Tcp([int]$Port) {
    try {
        $t = New-Object System.Net.Sockets.TcpClient
        $t.Connect('127.0.0.1', $Port); $t.Close(); return $true
    } catch { return $false }
}

function Test-RestHealth {
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8792/health' -TimeoutSec 20
        return $h
    } catch { return $null }
}

# ---------- 1. hphe-indexd (tache planifiee SYSTEM) ----------
$task = Get-ScheduledTask -TaskName 'hphe-indexd' -ErrorAction SilentlyContinue
if (-not $task) {
    Log "ALERTE tache hphe-indexd ABSENTE — reinstall requise (install.ps1)"
} elseif ($task.State -ne 'Running') {
    schtasks -Run -TN 'hphe-indexd' | Out-Null
    Log "ACTION hphe-indexd relance (etat etait $($task.State))"
} else {
    Log "OK hphe-indexd Running"
}

# ---------- 2. Gateway REST :8792 ----------
$health = Test-RestHealth
if (-not $health) {
    $restProc = Get-Process hphe-rest -ErrorAction SilentlyContinue
    if (-not $restProc) {
        Start-Process wscript.exe -ArgumentList '//nologo', "`"$RestCmd`"" -WindowStyle Hidden
        Log "ACTION hphe-rest.vbs relance (sans fenetre)"
        Start-Sleep -Seconds 5
        $health = Test-RestHealth
    }
    if (-not $health) { Log "ALERTE REST :8792 toujours DOWN apres relance" }
}
if ($health) {
    if ($health.pipe_connected -eq $true) {
        Log "OK REST healthy, pipe_connected=true (ingest_busy=$($health.ingest_busy))"
    } else {
        Log "ALERTE REST up mais pipe_connected=false — hphe-indexd probablement zombi; redemarrage tache"
        schtasks -End -TN 'hphe-indexd' | Out-Null; Start-Sleep -Seconds 2
        schtasks -Run -TN 'hphe-indexd' | Out-Null
        Log "ACTION hphe-indexd restart pour pipe mort"
    }
}

# ---------- 3. WS Bridge :7477 (orchestrator-monitor / binome) ----------
if (Test-Tcp 7477) {
    Log "OK bridge :7477 UP"
} else {
    Log "bridge :7477 DOWN — tentative de relance"
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = 'node'
    $si.Arguments = "`"$BridgeJs`""
    $si.WorkingDirectory = $BridgeDir
    $si.EnvironmentVariables['HEPHAISTOS_WORKSPACE'] = $Workspace
    $si.UseShellExecute = $false
    $si.CreateNoWindow = $true
    $si.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($si)
    Start-Sleep -Seconds 3
    if (Test-Tcp 7477) {
        Log "ACTION bridge relance OK (pid $($p.Id))"
    } else {
        $err = $p.StandardError.ReadToEnd()
        if ($err -match 'NODE_MODULE_VERSION' -and -not (Test-Path $AbiFlag)) {
            Log "bridge crash ABI better-sqlite3 -> reparation prebuild-install"
            $bs3 = Join-Path $BridgeDir 'node_modules\better-sqlite3'
            $pbi = Join-Path $BridgeDir 'node_modules\prebuild-install\bin.js'
            $nodeV = (& node --version) -replace 'v',''
            Push-Location $bs3
            try { & node $pbi --runtime=node --target=$nodeV 2>&1 | Out-Null } finally { Pop-Location }
            New-Item -ItemType File -Path $AbiFlag -Force | Out-Null
            # retry une fois apres reparation
            $p2 = [System.Diagnostics.Process]::Start($si)
            Start-Sleep -Seconds 3
            if (Test-Tcp 7477) { Log "ACTION bridge relance apres reparation ABI (pid $($p2.Id))" }
            else { Log "ALERTE bridge toujours DOWN apres reparation ABI" }
        } else {
            $errShort = ($err -split [char]10 | Select-Object -First 3) -join ' | '
            Log "ALERTE bridge ne demarre pas : $errShort"
        }
    }
}

# ---------- 4. MCP MUX HTTP bridge :5682 (pipeline n8n -> sondes) ----------
# Le bridge respawne son shim interne tout seul, mais rien ne supervise le
# bridge lui-meme : s'il meurt, :5682 reste en ECONNREFUSED.
$MuxJs  = 'C:\data-sys\n8n\.agent\scripts\mcp-mux-http-bridge.mjs'
$MuxDir = 'C:\data-sys\n8n'
if (Test-Tcp 5682) {
    Log "OK mux :5682 UP"
} else {
    Log "mux :5682 DOWN - tentative de relance"
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $MuxDir `
        -ArgumentList '/c', "node `"$MuxJs`" >> `"$LogDir\mux5682.log`" 2>&1"
    Start-Sleep -Seconds 8
    if (Test-Tcp 5682) { Log "ACTION mux :5682 relance OK" }
    else { Log "ALERTE mux :5682 toujours DOWN apres relance" }
}

# ---------- 5. Shim HTTP ws-bridge :7478 (route /ask -> cartes SWAT) ----------
$ShimJs  = 'C:\data-sys\hephaistos2-kit\.agent\scripts\ws-bridge-http.mjs'
$ShimDir = 'C:\data-sys\hephaistos2-kit'
if (Test-Tcp 7478) {
    Log "OK shim :7478 UP"
} else {
    Log "shim :7478 DOWN - tentative de relance"
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $ShimDir `
        -ArgumentList '/c', "set HEPHAISTOS_WORKSPACE=C:/data-sys/hephaistos2-kit&& node `"$ShimJs`" >> `"$ShimDir\.agent\logs\ws-bridge-http.log`" 2>&1"
    Start-Sleep -Seconds 5
    if (Test-Tcp 7478) { Log "ACTION shim :7478 relance OK" }
    else { Log "ALERTE shim :7478 toujours DOWN apres relance" }
}

# ---------- 6. OmniRoute :20128 (gateway LLM des Bleubites omniroute) ----------
if (Test-Tcp 20128) {
    Log "OK OmniRoute :20128 UP"
} else {
    Log "OmniRoute :20128 DOWN - tentative de relance (dev server, boot ~25s)"
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory 'C:\data-sys\OmniRoute' `
        -ArgumentList '/c', "node --max-old-space-size=8192 scripts\dev\run-next.mjs dev >> `"$LogDir\omniroute.log`" 2>&1"
    Start-Sleep -Seconds 30
    if (Test-Tcp 20128) { Log "ACTION OmniRoute :20128 relance OK" }
    else { Log "ALERTE OmniRoute :20128 toujours DOWN apres relance" }
}

# ---------- 7. n8n :5678 (workflow engine du SWAT) ----------
$n8nOk = $false
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 10 | Out-Null
    $n8nOk = $true
} catch { $n8nOk = $false }
if ($n8nOk) {
    Log "OK n8n :5678 healthy"
} else {
    Log "n8n :5678 DOWN - tentative de relance"
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory 'C:\data-sys\n8n' `
        -ArgumentList '/c', "node packages\cli\bin\n8n start >> `"$LogDir\n8n.log`" 2>&1"
    Start-Sleep -Seconds 30
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 10 | Out-Null
        Log "ACTION n8n :5678 relance OK"
    } catch { Log "ALERTE n8n :5678 toujours DOWN apres relance" }
}

# ---------- 8. n8n-ai-gateway :11435 (passerelle OpenAI agy/devin/ollama pour AI Agent n8n) ----------
$GwJs  = 'C:\data-sys\hephaistos2-kit\.agent\scripts\n8n-ai-gateway.mjs'
$GwDir = 'C:\data-sys\n8n'
$gwOk = $false
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:11435/v1/models' -TimeoutSec 8 | Out-Null
    $gwOk = $true
} catch { $gwOk = $false }
if ($gwOk) {
    Log "OK n8n-ai-gateway :11435 UP"
} else {
    Log "n8n-ai-gateway :11435 DOWN - tentative de relance"
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $GwDir `
        -ArgumentList '/c', "node `"$GwJs`" >> `"$LogDir\n8n-ai-gateway.log`" 2>&1"
    Start-Sleep -Seconds 5
    try {
        Invoke-RestMethod -Uri 'http://127.0.0.1:11435/v1/models' -TimeoutSec 8 | Out-Null
        Log "ACTION n8n-ai-gateway :11435 relance OK"
    } catch { Log "ALERTE n8n-ai-gateway :11435 toujours DOWN apres relance" }
}

# ---------- 9. Strata :8080 (LLM local 125B — relance si engine mort) ----------
# Garde : si strata.exe tourne mais :8080 pas encore UP = chargement 67GB
# en cours (~3 min) -> on ne relance PAS (evite les doubles engines).
$StrataPy  = 'C:\data-sys\ia-lacal-multi-gpu\strata\.venv\Scripts\python.exe'
$StrataDir = 'C:\data-sys\ia-lacal-multi-gpu\strata'
$strataOk = $false
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/models' -TimeoutSec 8 | Out-Null
    $strataOk = $true
} catch { $strataOk = $false }
if ($strataOk) {
    Log "OK Strata :8080 UP"
    # Vision : le fichier prime — si OFF, toute strata-vision vivante est tuee
    $visFileChk = 'C:\data-sys\n8n\.agent\config\vision.state'
    if ((Test-Path $visFileChk) -and (Get-Content $visFileChk -Raw).Trim() -eq 'off') {
        if (Get-Process strata-vision -ErrorAction SilentlyContinue) {
            Get-Process strata-vision -ErrorAction SilentlyContinue | Stop-Process -Force
            Log "ACTION strata-vision tuee (vision.state=off)"
        }
    }
} elseif (Get-CimInstance Win32_Process -Filter "Name='strata.exe'" -ErrorAction SilentlyContinue) {
    Log "OK Strata :8080 chargement en cours (engine vivant)"
} else {
    # Vision pilote par l'etat du tray (C:\data-sys\n8n\.agent\config\vision.state : on|off)
    $visState = 'on'
    $visFile = 'C:\data-sys\n8n\.agent\config\vision.state'
    if (Test-Path $visFile) { $visState = (Get-Content $visFile -Raw).Trim() }
    $visArg = if ($visState -eq 'off') { 'off' } else { 'cpu' }
    Log "Strata :8080 DOWN - relance demandee (vision=$visArg, load ~3min)"
    Start-Process -FilePath $StrataPy -WindowStyle Hidden -WorkingDirectory $StrataDir `
        -ArgumentList 'strata.py','launch','--family','qwen','--model','q2_0','--gpu','1,0','--context','64k','--vision',$visArg,'--drafting','mtp','--tune','skip','--access','local','--port','8080','--set','resident_budget_gib=4','--set','expert_cache=6000','--yes','--no-tui'
}

# ---------- 10. mcp-mux-local : statut 'active' ----------
# Le refresh officiel du registre (boot + toutes les 8h) marque 'deprecated'
# tout serveur absent du catalogue -> la connexion assistant disparait.
# On re-force status='active' a chaque passage du watchdog.
$SqliteDb = "$env:USERPROFILE\.n8n\database.sqlite"
try {
    $muxStatus = & sqlite3 "$SqliteDb" "SELECT status FROM mcp_registry_server WHERE slug='mcp-mux-local';" 2>$null
    if ($muxStatus -eq 'active') {
        Log "OK mcp-mux-local status active"
    } elseif ($muxStatus) {
        & sqlite3 "$SqliteDb" "UPDATE mcp_registry_server SET status='active' WHERE slug='mcp-mux-local';" | Out-Null
        Log "ACTION mcp-mux-local status re-force a active (etait: $muxStatus)"
    } else {
        Log "ALERTE mcp-mux-local absent du registre - relancer .agent/scripts/mcp-mux-register.mjs"
    }
} catch { Log "ALERTE check mcp-mux-local impossible: $_" }

# ---------- 9ter. llama-server :11436 (petit cerveau webman — Spark-4B Q4) ----------
$LlamaDir = 'C:\data-sys\n8n\.agent\llama'
$LlamaExe = "$LlamaDir\llama-server.exe"
$LlamaGguf = "$LlamaDir\spark4b-q4km.gguf"
$llamaOk = $false
try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:11436/health' -UseBasicParsing -TimeoutSec 6 | Out-Null
    $llamaOk = $true
} catch { $llamaOk = $false }
if ($llamaOk) {
    Log "OK llama-server :11436 UP"
} elseif (Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue) {
    Log "OK llama-server :11436 demarrage en cours (processus vivant)"
} elseif (Test-Path $LlamaGguf) {
    Log "llama-server :11436 DOWN - relance (Spark-4B Q4_K_M, ngl 99)"
    Start-Process -FilePath $LlamaExe -WindowStyle Hidden -WorkingDirectory $LlamaDir `
        -ArgumentList '-m',"`"$LlamaGguf`"",'--port','11436','-ngl','99','-c','8192','-t','6','--host','127.0.0.1','--reasoning','off'
} else {
    Log "ALERTE llama-server :11436 DOWN et gguf absent ($LlamaGguf)"
}

# ---------- 9quater. llama-server brut :11437 (heretique, mode a nu) ----------
$LlamaBrutGguf = "$LlamaDir\spark4b-heretic-q4km.gguf"
$brutOk = $false
try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:11437/health' -UseBasicParsing -TimeoutSec 6 | Out-Null
    $brutOk = $true
} catch { $brutOk = $false }
if ($brutOk) {
    Log "OK llama-server brut :11437 UP"
} elseif (Test-Path $LlamaBrutGguf) {
    Log "llama-server brut :11437 DOWN - relance (heretic Q4_K_M)"
    Start-Process -FilePath $LlamaExe -WindowStyle Hidden -WorkingDirectory $LlamaDir `
        -ArgumentList '-m',"`"$LlamaBrutGguf`"",'--port','11437','-ngl','99','-c','8192','-t','6','--host','127.0.0.1','--reasoning','off'
} else {
    Log "ALERTE llama-server brut :11437 DOWN et gguf absent"
}

# ---------- 9bis. (retire) MCP opencli bridge :5694 ----------
# Remplace par la connexion registre mcp-mux-local (tables n8n) qui expose
# l'ensemble du mux :5682 a l'assistant. Le script
# .agent/scripts/n8n-mcp-opencli-bridge.mjs est conserve comme gabarit si un
# bridge filtre redevient utile.

# ---------- 10. webman tray (icone de conscience dans la barre des taches) ----------
$TrayPs1 = 'C:\data-sys\n8n\.agent\scripts\hphe-cognition-tray.ps1'
$trayAlive = [bool](Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'cognition-tray' })
if ($trayAlive) {
    Log "OK webman-tray vivant"
} else {
    Log "webman-tray absent - relance"
    Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-File',"`"$TrayPs1`"" -WindowStyle Hidden
    Log "ACTION webman-tray relance"
}
