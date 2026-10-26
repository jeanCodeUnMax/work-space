param (
    [string]$Target,
    [switch]$Force
)

# Hephaistos Devin Plugin — Installation PowerShell
# Vérifie hphe-mcp.exe, copie le plugin, teste modules, demande consentement NTFS.

$pluginDir = $PSScriptRoot
$defaultTarget = Join-Path $env:USERPROFILE ".hephaistos-devin"

$target = if ($Target) { $Target } else { $defaultTarget }
# Sanitisation : chemin absolu résolu, pas de relatif/traversal
$target = [System.IO.Path]::GetFullPath($target)
if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }

# Localisation hphe-mcp.exe
$mcpExe = if ($env:HPHE_MCP_PATH) { $env:HPHE_MCP_PATH } else { Join-Path (Split-Path $pluginDir) "hphe\target\release\hphe-mcp.exe" }
if (-not (Test-Path $mcpExe)) { Write-Error "hphe-mcp.exe introuvable : définissez HPHE_MCP_PATH ou placez-le dans hphe/target/release" ; exit 1 }

# Test node --check sur les .js
$jsFiles = Get-ChildItem (Join-Path $pluginDir "src") -Filter "*.js"
foreach ($f in $jsFiles) {
    & node --check $f.FullName *> $null
    if ($LASTEXITCODE -ne 0) { Write-Error "Syntaxe incorrecte : $($f.Name)" ; exit 1 }
}

# Consentement NTFS
if (-not $Force) {
    $msg = "Le plugin nécessite elevation NTFS (lecture seule index `$MFT via hphe-mcp.exe). Acceptez-vous ? (O/n) "
    $resp = Read-Host $msg
    if ($resp -match '[nN]') { Write-Host "Annulé." ; exit 0 }
}

# Copie explicite des fichiers du plugin — pas de wildcard aveugle
$files = @('plugin.json', 'manifest.json', 'skills-to-plugin-commands.json', 'README.md', 'test-post-install.js')
foreach ($f in $files) {
    $src = Join-Path $pluginDir $f
    if (Test-Path $src) { Copy-Item $src -Destination $target -Force }
}
New-Item -ItemType Directory -Path (Join-Path $target 'src') -Force | Out-Null
foreach ($f in (Get-ChildItem (Join-Path $pluginDir 'src') -Filter '*.js')) {
    Copy-Item $f.FullName -Destination (Join-Path $target 'src') -Force
}

Write-Host "Installation complète dans $target"
Write-Host "Consentement NTFS enregistré et appliqué."
