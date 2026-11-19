<#
.SYNOPSIS
    Exporte et sauvegarde l'integralite des reglages d'infrastructure hors-repo Hephaistos2-Kit
    dans une archive autonome de restauration (Zero-Tolerance / Bare-Metal Restore).
#>

$BackupDir = "C:\data-sys\hephaistos2-kit\docs\disaster-recovery\bundle"
if (!(Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

Write-Host "=== 1. Sauvegarde des Tâches Planifiées Hephaistos ===" -ForegroundColor Cyan
$tasks = @('hphe-indexd', 'hphe-watchdog', 'hphe-taskwatch', 'n8n', 'n8n-auth-proxy', 'CerbereShield')
$taskXmlDir = Join-Path $BackupDir "tasks-xml"
New-Item -ItemType Directory -Path $taskXmlDir -Force | Out-Null
foreach ($t in $tasks) {
    try {
        $xml = Export-Clixml (Get-ScheduledTask -TaskName $t -ErrorAction Stop) -Path (Join-Path $taskXmlDir "$t.clixml")
        schtasks /query /tn $t /xml > (Join-Path $taskXmlDir "$t.xml") 2>$null
        Write-Host "  [OK] Tache exportee : $t" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Tache absente ou non exportable : $t" -ForegroundColor Yellow
    }
}

Write-Host "`n=== 2. Sauvegarde des Scripts Startup ===" -ForegroundColor Cyan
$startupSrc = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupDst = Join-Path $BackupDir "startup"
New-Item -ItemType Directory -Path $startupDst -Force | Out-Null
Get-ChildItem -Path $startupSrc -File | ForEach-Object {
    Copy-Item $_.FullName -Destination $startupDst -Force
    Write-Host "  [OK] Fichier Startup copie : $($_.Name)" -ForegroundColor Green
}

Write-Host "`n=== 3. Sauvegarde des Fichiers de Configuration Profil (.config, .hephaistos, .claude, .devin) ===" -ForegroundColor Cyan
$configDst = Join-Path $BackupDir "user-configs"
New-Item -ItemType Directory -Path $configDst -Force | Out-Null

# mcp-mux.json
if (Test-Path "$env:USERPROFILE\.config\mcp-mux\mcp-mux.json") {
    $muxDst = Join-Path $configDst ".config\mcp-mux"
    New-Item -ItemType Directory -Path $muxDst -Force | Out-Null
    Copy-Item "$env:USERPROFILE\.config\mcp-mux\mcp-mux.json" -Destination $muxDst -Force
    Write-Host "  [OK] mcp-mux.json sauvegarde" -ForegroundColor Green
}

# .hephaistos scripts
if (Test-Path "$env:USERPROFILE\.hephaistos\scripts") {
    $hpheDst = Join-Path $configDst ".hephaistos\scripts"
    New-Item -ItemType Directory -Path $hpheDst -Force | Out-Null
    Copy-Item "$env:USERPROFILE\.hephaistos\scripts\*" -Destination $hpheDst -Recurse -Force
    Write-Host "  [OK] .hephaistos/scripts sauvegardes" -ForegroundColor Green
}

# server-manager.mjs patche
if (Test-Path "$env:USERPROFILE\.hephaistos\servers\mcp-mux\src\server-manager.mjs") {
    $smDst = Join-Path $configDst ".hephaistos\server-manager"
    New-Item -ItemType Directory -Path $smDst -Force | Out-Null
    Copy-Item "$env:USERPROFILE\.hephaistos\servers\mcp-mux\src\server-manager.mjs" -Destination $smDst -Force
    Write-Host "  [OK] server-manager.mjs (patch timeout) sauvegarde" -ForegroundColor Green
}

# CLAUDE.md & AGENTS.md racine
if (Test-Path "$env:USERPROFILE\.claude\CLAUDE.md") {
    $clDst = Join-Path $configDst ".claude"
    New-Item -ItemType Directory -Path $clDst -Force | Out-Null
    Copy-Item "$env:USERPROFILE\.claude\CLAUDE.md" -Destination $clDst -Force
    Write-Host "  [OK] ~/.claude/CLAUDE.md sauvegarde" -ForegroundColor Green
}
if (Test-Path "$env:USERPROFILE\.devin\AGENTS.md") {
    $dvDst = Join-Path $configDst ".devin"
    New-Item -ItemType Directory -Path $dvDst -Force | Out-Null
    Copy-Item "$env:USERPROFILE\.devin\AGENTS.md" -Destination $dvDst -Force
    Write-Host "  [OK] ~/.devin/AGENTS.md sauvegarde" -ForegroundColor Green
}

Write-Host "`n=== 4. Sauvegarde des Commandes Program Files Servers ===" -ForegroundColor Cyan
$pfSrc = "C:\Program Files\servers\hephaistos2-kit\extension\server"
$pfDst = Join-Path $BackupDir "program-files-server"
New-Item -ItemType Directory -Path $pfDst -Force | Out-Null
@('hphe-rest.cmd', 'hphe-rest-ingest.cmd', '.mcp-access') | ForEach-Object {
    $p = Join-Path $pfSrc $_
    if (Test-Path $p) {
        Copy-Item $p -Destination $pfDst -Force
        Write-Host "  [OK] Fichier serveur copie : $_" -ForegroundColor Green
    }
}

Write-Host "`n>>> BACKUP DISASTER RECOVERY TERMINE AVEC SUCCES DANS : $BackupDir <<<" -ForegroundColor Green
