#Requires -Version 5.1
<#
.SYNOPSIS
  Mirror VS Code Extension API (SDK) documentation into the Obsidian vault.
.DESCRIPTION
  Sources:
    - github.com/microsoft/vscode-docs  dossier api/ (sparse clone, .md seuls)
    - code.visualstudio.com/api/references/vscode-api.md (reference generee)
    - github.com/microsoft/vscode  src/vscode-dts/ (vscode.d.ts + vscode.proposed.*.d.ts)
    - code.visualstudio.com/llms.txt (index officiel conserve dans _meta)
  Destination : <VaultRoot>/Documentation/VS Code/
#>
param(
    [string]$VaultRoot = $(if ($env:OBSIDIAN_VAULT_PATH) { $env:OBSIDIAN_VAULT_PATH } else { throw 'OBSIDIAN_VAULT_PATH requis (ou -VaultRoot)' }),
    [string]$DestSubdir = 'Documentation/VS Code',
    [switch]$SkipIngest
)

$ErrorActionPreference = 'Stop'
$destRoot = Join-Path $VaultRoot $DestSubdir
$metaDir = Join-Path $destRoot '_meta'
$apiDest = Join-Path $destRoot 'api'
$typDest = Join-Path $destRoot 'typings'

New-Item -ItemType Directory -Force -Path $metaDir, $apiDest, (Join-Path $typDest 'proposed') | Out-Null

$manifest = @{
    synced_at = (Get-Date).ToUniversalTime().ToString('o')
    sources   = @{
        docs      = 'https://github.com/microsoft/vscode-docs (api/, main)'
        vscodeApi = 'https://code.visualstudio.com/api/references/vscode-api.md'
        typings   = 'https://github.com/microsoft/vscode (src/vscode-dts/, main)'
        index     = 'https://code.visualstudio.com/llms.txt'
    }
    counts    = @{}
    failed    = @()
}

# 1. Index officiel (provenance)
try {
    (Invoke-WebRequest -Uri 'https://code.visualstudio.com/llms.txt' -UseBasicParsing -TimeoutSec 60).Content |
        Set-Content (Join-Path $metaDir 'vscode-llms.txt') -Encoding utf8
} catch { $manifest.failed += "llms.txt: $($_.Exception.Message)" }

# 2. Sparse clone vscode-docs -> api/*.md
$tmp = Join-Path $env:TEMP ("vscode-docs-" + [guid]::NewGuid().ToString('N'))
try {
    git clone --depth 1 --filter=blob:none --sparse https://github.com/microsoft/vscode-docs.git $tmp | Out-Null
    Push-Location $tmp
    git sparse-checkout set api | Out-Null
    Pop-Location
    $mdFiles = Get-ChildItem -Path (Join-Path $tmp 'api') -Recurse -Filter '*.md'
    foreach ($f in $mdFiles) {
        $rel = $f.FullName.Substring((Join-Path $tmp 'api').Length).TrimStart('\', '/')
        $out = Join-Path $apiDest $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $out -Parent) | Out-Null
        Copy-Item $f.FullName $out -Force
    }
    $manifest.counts.api_md = $mdFiles.Count
} catch { $manifest.failed += "vscode-docs clone: $($_.Exception.Message)" }
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

# 3. Page generee vscode-api.md
try {
    Invoke-WebRequest -Uri 'https://code.visualstudio.com/api/references/vscode-api.md' -UseBasicParsing -TimeoutSec 120 |
        ForEach-Object { [IO.File]::WriteAllBytes((Join-Path $apiDest 'references/vscode-api.md'), $_.Content) }
    $manifest.counts.vscode_api_md = 1
} catch { $manifest.failed += "vscode-api.md: $($_.Exception.Message)" }

# 4. Typages vscode.d.ts + proposed
try {
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.d.ts' -UseBasicParsing -TimeoutSec 120 |
        ForEach-Object { [IO.File]::WriteAllBytes((Join-Path $typDest 'vscode.d.ts'), $_.Content) }
    $manifest.counts.typings_stable = 1
} catch { $manifest.failed += "vscode.d.ts: $($_.Exception.Message)" }

try {
    $listing = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/vscode/contents/src/vscode-dts?ref=main' -TimeoutSec 60
    $proposed = $listing | Where-Object { $_.name -like 'vscode.proposed.*.d.ts' }
    $ok = 0
    foreach ($p in $proposed) {
        try {
            Invoke-WebRequest -Uri $p.download_url -UseBasicParsing -TimeoutSec 60 |
                ForEach-Object { [IO.File]::WriteAllBytes((Join-Path $typDest "proposed/$($p.name)"), $_.Content) }
            $ok++
        } catch { $manifest.failed += "proposed/$($p.name): $($_.Exception.Message)" }
    }
    $manifest.counts.typings_proposed = $ok
} catch { $manifest.failed += "dts listing: $($_.Exception.Message)" }

$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $metaDir 'sync-manifest.json') -Encoding utf8
Write-Host "Synced -> $destRoot ; api_md=$($manifest.counts.api_md) proposed=$($manifest.counts.typings_proposed) failed=$($manifest.failed.Count)"

if (-not $SkipIngest) {
    $mcpCall = Join-Path $env:USERPROFILE '.config\devin\scripts\mcp-call.mjs'
    if (Test-Path $mcpCall) {
        Write-Host 'Indexing via Hephaistos content_ingest...'
        $rootJson = ($destRoot -replace '\\', '/')
        $args = "{`"root`":`"$rootJson`",`"project_tag`":`"vscode-ext-api`",`"force`":false}"
        & node $mcpCall Hephaistos-everything-search content_ingest $args
    } else {
        Write-Host '[WARN] mcp-call.mjs absent - relancer content_ingest manuellement' -ForegroundColor Yellow
    }
}
Write-Host 'Done.'
