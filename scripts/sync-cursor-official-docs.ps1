#Requires -Version 5.1
<#
.SYNOPSIS
  Mirror Cursor official documentation (docs + help) into the Obsidian vault.
.DESCRIPTION
  Uses https://cursor.com/docs/llms.txt as the canonical index. Deduplicates URLs,
  strips fragment-only API anchors, and preserves path layout under Documentation/Cursor/.
#>
param(
    [string]$VaultRoot = $(if ($env:OBSIDIAN_VAULT_PATH) { $env:OBSIDIAN_VAULT_PATH } else { throw 'OBSIDIAN_VAULT_PATH requis (ou -VaultRoot)' }),
    [string]$DestSubdir = 'Documentation/Cursor',
    [int]$MaxParallel = 8,
    [switch]$SkipIngest
)

$ErrorActionPreference = 'Stop'
$destRoot = Join-Path $VaultRoot $DestSubdir
$metaDir = Join-Path $destRoot '_meta'
$llmsUrl = 'https://cursor.com/docs/llms.txt'

function Get-UniqueDocUrls {
    param([string]$LlmsText)
    $raw = [regex]::Matches($LlmsText, 'https://cursor\.com[^\s\)`]+') | ForEach-Object { $_.Value }
    $fixed = foreach ($u in $raw) {
        if ($u -match '^https://cursor\.comhttps://') {
            'https://cursor.com/changelog.md'
            continue
        }
        $base = ($u -split '#', 2)[0]
        if ($base -match '\.(md|txt|yaml)$') { $base }
    }
    $fixed | Sort-Object -Unique
}

function Get-RelativePathFromUrl {
    param([string]$Url)
    $uri = [Uri]$Url
    $path = $uri.AbsolutePath.TrimStart('/')
    if ($path -eq 'changelog.md') { return 'changelog.md' }
    return $path -replace '/', [IO.Path]::DirectorySeparatorChar
}

New-Item -ItemType Directory -Force -Path $metaDir | Out-Null
Write-Host "Fetching index: $llmsUrl"
$llms = (Invoke-WebRequest -Uri $llmsUrl -UseBasicParsing).Content
$llms | Set-Content -Path (Join-Path $metaDir 'llms.txt') -Encoding utf8

$urls = Get-UniqueDocUrls -LlmsText $llms
Write-Host "Unique asset URLs: $($urls.Count)"

$extra = @(
    'https://cursor.com/docs/api/origin/llms-full.txt',
    'https://cursor.com/docs/api/origin/openapi.yaml',
    'https://cursor.com/docs/reference/keyboard-shortcuts.md'
)
$urls = ($urls + $extra) | Sort-Object -Unique

$manifest = @{
    synced_at = (Get-Date).ToUniversalTime().ToString('o')
    source_index = $llmsUrl
    total = $urls.Count
    ok = 0
    failed = @()
}

$n = 0
foreach ($url in $urls) {
    $n++
    $rel = Get-RelativePathFromUrl -Url $url
    $outFile = Join-Path $destRoot $rel
    $outDir = Split-Path $outFile -Parent
    try {
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 120
        $bytes = if ($r.RawContentStream) {
            $ms = New-Object IO.MemoryStream
            $r.RawContentStream.CopyTo($ms)
            $ms.ToArray()
        } else {
            [Text.Encoding]::UTF8.GetBytes($r.Content)
        }
        [IO.File]::WriteAllBytes($outFile, $bytes)
        $manifest.ok++
        if ($n % 25 -eq 0) { Write-Host "  $n / $($urls.Count)" }
    } catch {
        $msg = $_.Exception.Message
        if ($msg.Length -gt 500) { $msg = $msg.Substring(0, 500) + '...' }
        $manifest.failed += @{ url = $url; err = $msg }
    }
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $metaDir 'sync-manifest.json') -Encoding utf8
Write-Host "Downloaded: $($manifest.ok) / $($manifest.total); failed: $($manifest.failed.Count)"
if ($manifest.failed.Count -gt 0) {
    $manifest.failed | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $metaDir 'sync-failures.json') -Encoding utf8
}

if (-not $SkipIngest) {
    $mcpCall = Join-Path $env:USERPROFILE '.config\devin\scripts\mcp-call.mjs'
    if (Test-Path $mcpCall) {
        Write-Host 'Indexing via Hephaistos content_ingest...'
        $rootJson = ($destRoot -replace '\\', '/')
        $args = "{`"root`":`"$rootJson`",`"project_tag`":`"cursor-ide-docs`",`"force`":false}"
        & node $mcpCall Hephaistos-everything-search content_ingest $args
    } else {
        Write-Host '[WARN] mcp-call.mjs absent — relancer content_ingest manuellement' -ForegroundColor Yellow
    }
}

$memDb = Join-Path $destRoot 'memory-database'
if (Test-Path $memDb) {
    Remove-Item -LiteralPath $memDb -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Removed ephemeral memory-database/ from vault mirror.'
}

Write-Host "Done -> $destRoot"
