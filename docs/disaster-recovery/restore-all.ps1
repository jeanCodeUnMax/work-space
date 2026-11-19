<#
.SYNOPSIS
    Script de restauration 1-Clic apres reinstalation complete de Windows.
    Restaure les configurations profil, les scripts Startup, les taches planifiees,
    et reconnecte l'infrastructure Hephaistos2-Kit sans perte d'efficacite ni de performance.
#>

$BundleDir = $PSScriptRoot
if (!(Test-Path (Join-Path $BundleDir "bundle"))) {
    $BundleDir = Join-Path $PSScriptRoot "bundle"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   HEPHAISTOS2-KIT // RESTAURATION TOTALE DISASTER RECOVERY " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verification de l'utilisateur et des chemins
if ($env:USERNAME -ne "webma") {
    Write-Host "[WARN] Votre nom d'utilisateur est '$env:USERNAME' au lieu de 'webma'." -ForegroundColor Yellow
    Write-Host "       Certains chemins absolus vers C:\Users\webma\... necessiteront une jonction de dossier :" -ForegroundColor Yellow
    Write-Host "       cmd /c mklink /J C:\Users\webma C:\Users\$env:USERNAME" -ForegroundColor Yellow
}

# 2. Restauration des configurations utilisateur
Write-Host "`n[1/5] Restauration des configurations profils..." -ForegroundColor Cyan
$cfgSrc = Join-Path $BundleDir "user-configs"

# .config/mcp-mux
$muxDst = "$env:USERPROFILE\.config\mcp-mux"
New-Item -ItemType Directory -Path $muxDst -Force | Out-Null
Copy-Item (Join-Path $cfgSrc ".config\mcp-mux\*") -Destination $muxDst -Recurse -Force
Write-Host "  -> mcp-mux.json restaure dans ~/.config/mcp-mux/" -ForegroundColor Green

# .hephaistos/scripts & server-manager
$hpheDst = "$env:USERPROFILE\.hephaistos\scripts"
New-Item -ItemType Directory -Path $hpheDst -Force | Out-Null
Copy-Item (Join-Path $cfgSrc ".hephaistos\scripts\*") -Destination $hpheDst -Recurse -Force
Write-Host "  -> Scripts watchdog et run-hidden restaures dans ~/.hephaistos/scripts/" -ForegroundColor Green

$smDst = "$env:USERPROFILE\.hephaistos\servers\mcp-mux\src"
if (Test-Path $smDst) {
    Copy-Item (Join-Path $cfgSrc ".hephaistos\server-manager\server-manager.mjs") -Destination $smDst -Force
    Write-Host "  -> server-manager.mjs patche restaure (support initTimeoutMs)" -ForegroundColor Green
}

# .claude & .devin
$clDst = "$env:USERPROFILE\.claude"
New-Item -ItemType Directory -Path $clDst -Force | Out-Null
Copy-Item (Join-Path $cfgSrc ".claude\CLAUDE.md") -Destination $clDst -Force
Write-Host "  -> CLAUDE.md restaure dans ~/.claude/" -ForegroundColor Green

$dvDst = "$env:USERPROFILE\.devin"
New-Item -ItemType Directory -Path $dvDst -Force | Out-Null
Copy-Item (Join-Path $cfgSrc ".devin\AGENTS.md") -Destination $dvDst -Force
Write-Host "  -> AGENTS.md restaure dans ~/.devin/" -ForegroundColor Green

# 3. Restauration des lanceurs Startup
Write-Host "`n[2/5] Restauration des lanceurs de demarrage (Startup)..." -ForegroundColor Cyan
$startupDst = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
Copy-Item (Join-Path $BundleDir "startup\*") -Destination $startupDst -Force
Write-Host "  -> Scripts .vbs et raccourcis restaures dans le dossier Startup Windows" -ForegroundColor Green

# 4. Restauration des fichiers de commande Program Files
Write-Host "`n[3/5] Restauration des commandes serveur Program Files..." -ForegroundColor Cyan
$pfDst = "C:\Program Files\servers\hephaistos2-kit\extension\server"
if (Test-Path $pfDst) {
    Copy-Item (Join-Path $BundleDir "program-files-server\*") -Destination $pfDst -Force
    Write-Host "  -> hphe-rest.cmd, hphe-rest-ingest.cmd et .mcp-access restaures" -ForegroundColor Green
} else {
    Write-Host "  [NOTE] Installez d'abord le package Hephaistos via install.ps1, puis relancez cette etape." -ForegroundColor Yellow
}

# 5. Re-enregistrement des Tâches Planifiées Windows
Write-Host "`n[4/5] Re-enregistrement des taches planifiees..." -ForegroundColor Cyan
$xmlDir = Join-Path $BundleDir "tasks-xml"
Get-ChildItem -Path $xmlDir -Filter "*.xml" | ForEach-Object {
    $taskName = $_.BaseName
    Write-Host "  -> Enregistrement de la tache : $taskName..." -NoNewline
    schtasks /create /tn $taskName /xml $_.FullName /f > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host " [OK]" -ForegroundColor Green
    } else {
        Write-Host " [ECHEC - Droits Admin requis]" -ForegroundColor Red
    }
}

# 6. Lancement de la verification de sante
Write-Host "`n[5/5] Declenchement du Watchdog Hephaistos..." -ForegroundColor Cyan
if (Test-Path "$env:USERPROFILE\.hephaistos\scripts\hphe-watchdog.ps1") {
    powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.hephaistos\scripts\hphe-watchdog.ps1"
}

Write-Host "`n>>> RESTAURATION COMPLETE TERMINEE AVEC SUCCES <<<" -ForegroundColor Green
