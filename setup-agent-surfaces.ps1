<#
.SYNOPSIS
    Configuration et injection des surfaces d'agents (Antigravity, Claude Code, Devin).
.DESCRIPTION
    Injecte les skills et directives universelles de gouvernance JIT dans les profils globaux :
    - Antigravity (~/.gemini/config/skills/skills-mux)
    - Claude Code (~/.claude/skills/skills-mux)
    - Devin (~/.devin/skills/skills-mux -> jonction vers .claude)
    - Synchronisation des règles de gouvernance JIT dans global_rules.md, CLAUDE.md et AGENTS.md
#>
param(
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceSkill = Join-Path $ScriptDir ".agent\skills\skills-mux\SKILL.md"

if (-not (Test-Path $SourceSkill)) {
    $Fallback = "C:\data-sys\claude-skills-mux\claude-skills-mux\.agents\skills\skills-mux\SKILL.md"
    if (Test-Path $Fallback) { $SourceSkill = $Fallback }
}

Write-Host "[SETUP-AGENT-SURFACES] Déploiement des surfaces agent & skills JIT..." -ForegroundColor Cyan

# 1. Antigravity (global)
$AgyDir = Join-Path $HOME ".gemini\config\skills\skills-mux"
if (-not (Test-Path $AgyDir)) { New-Item -ItemType Directory -Force -Path $AgyDir | Out-Null }
if (Test-Path $SourceSkill) {
    Copy-Item $SourceSkill (Join-Path $AgyDir "SKILL.md") -Force
    Write-Host "  -> Antigravity global : OK" -ForegroundColor Green
}

# 2. Claude Code (global)
$ClaudeDir = Join-Path $HOME ".claude\skills\skills-mux"
if (-not (Test-Path $ClaudeDir)) { New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null }
if (Test-Path $SourceSkill) {
    Copy-Item $SourceSkill (Join-Path $ClaudeDir "SKILL.md") -Force
    Write-Host "  -> Claude Code global : OK" -ForegroundColor Green
}

# 3. Devin (jonction Windows vers Claude Code)
$DevinDir = Join-Path $HOME ".devin\skills\skills-mux"
$DevinBase = Join-Path $HOME ".devin\skills"
if (-not (Test-Path $DevinBase)) { New-Item -ItemType Directory -Force -Path $DevinBase | Out-Null }
if (Test-Path $DevinDir) {
    Remove-Item -Recurse -Force $DevinDir
}
New-Item -ItemType Junction -Path $DevinDir -Target $ClaudeDir | Out-Null
Write-Host "  -> Devin jonction vers Claude Code : OK" -ForegroundColor Green

Write-Host "[SETUP-AGENT-SURFACES] Injection des surfaces terminée avec succès." -ForegroundColor Cyan
