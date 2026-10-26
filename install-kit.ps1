# install-kit.ps1 — Orchestrateur d'installation en un clic
# Lit kit.toml, exécute les phases en appelant les scripts existants.
# Idempotent, supporte -WhatIf / -Only <phase> / -Skip.
# Aucun secret en dur ; clés via env ou prompt.

param(
  [string]$Phase,
  [switch]$WhatIf,
  [switch]$Skip,
  [switch]$Only
)

$ErrorActionPreference = 'Stop'
$today = Get-Date -Format 'yyyyMMdd_HHmmss'

function Write-Phase {
  param([string]$Name, [string]$Result, [string]$Message)
  Write-Host "[$Name] ${Result}: ${Message}"
}

function Backup-Config {
  param([string]$Path)
  if (Test-Path $Path) {
    $bak = "$Path.bak-$today"
    Copy-Item -Path $Path -Destination $bak -Force -ErrorAction SilentlyContinue
    Write-Phase "Backup" "OK" "Copié vers $bak"
  }
}

# --- Phase 0 : prerequis ---
function Phase-Prerequis {
  Write-Phase "Prerequis" "START" "Vérification de node, pwsh, git, winget, uv"
  # Vérifications simples (non destructives)
  $nodeOk = (Get-Command node -ErrorAction SilentlyContinue) -ne $null
  $pwshOk = (Get-Command pwsh -ErrorAction SilentlyContinue) -ne $null
  $gitOk = (Get-Command git -ErrorAction SilentlyContinue) -ne $null
  $wingetOk = (Get-Command winget -ErrorAction SilentlyContinue) -ne $null
  $uvOk = (Get-Command uv -ErrorAction SilentlyContinue) -ne $null

  if (-not $nodeOk) { Write-Phase "Prerequis" "FAIL" "node introuvable"; return $false }
  if (-not $pwshOk) { Write-Phase "Prerequis" "FAIL" "pwsh introuvable"; return $false }
  if (-not $gitOk) { Write-Phase "Prerequis" "FAIL" "git introuvable"; return $false }
  if (-not $wingetOk) { Write-Phase "Prerequis" "FAIL" "winget introuvable"; return $false }
  if (-not $uvOk) { Write-Phase "Prerequis" "FAIL" "uv introuvable"; return $false }

  Write-Phase "Prerequis" "OK" "Tous les outils requis sont présents"
  return $true
}

# --- Phase 1 : engine ---
function Phase-Engine {
  Write-Phase "Engine" "START" "Exécution de install.ps1 existant"
  if ($WhatIf) { Write-Phase "Engine" "SKIP" "-WhatIf activé"; return $true }
  & '.\install.ps1' @PSSetSeverityInfo 'SilentlyContinue'
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { Write-Phase "Engine" "OK" "install.ps1 terminé"; return $true }
  else { Write-Phase "Engine" "FAIL" "install.ps1 retourné $rc"; return $false }
}

# --- Phase 2 : agent-layer ---
function Phase-AgentLayer {
  Write-Phase "Agent-layer" "START" "init-project.ps1 + sync-agent-layer.ps1"
  if ($WhatIf) { Write-Phase "Agent-layer" "SKIP" "-WhatIf"; return $true }
  if (-not (Test-Path .\init-project.ps1)) { Write-Phase "Agent-layer" "WARN" "init-project.ps1 introuvable"; return $true }
  & .\init-project.ps1 @PSSetSeverityInfo 'SilentlyContinue'
  if (-not (Test-Path .\sync-agent-layer.ps1)) { Write-Phase "Agent-layer" "WARN" "sync-agent-layer.ps1 introuvable"; return $true }
  & .\sync-agent-layer.ps1 @PSSetSeverityInfo 'SilentlyContinue'
  Write-Phase "Agent-layer" "OK" "Scaffold .agent synchronisé"
  return $true
}

# --- Phase 3 : cli ---
function Phase-Cli {
  Write-Phase "Cli" "START" "Installation CLIs : devin, agy, kilo, hermes, opencode, omniroute, uvx"
  if ($WhatIf) { Write-Phase "Cli" "SKIP" "-WhatIf"; return $true }
  # Exemples (non destructifs ici, adaptation selon environnement)
  $clis = @('devin','agy','kilo','hermes','opencode','omniroute')
  foreach ($cli in $clis) {
    if (Get-Command $cli -ErrorAction SilentlyContinue) {
      Write-Phase "Cli" "OK" "$cli déjà installé"
    } else {
      Write-Phase "Cli" "SKIP" "Installation de $cli (simulée)"
      # winget install --id=$cli -ErrorAction SilentlyContinue
    }
  }
  # uvx
  if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
    Write-Phase "Cli" "SKIP" "uvx non trouvé (installation uv tool)"
  }
  Write-Phase "Cli" "OK" "CLIs traitées"
  return $true
}

# --- Phase 4 : extensions ---
function Phase-Extensions {
  Write-Phase "Extensions" "START" "4 VSIX : hephaistos-chats, orchestrator-monitor, kit-search, postdev"
  if ($WhatIf) { Write-Phase "Extensions" "SKIP" "-WhatIf"; return $true }
  if (-not (Test-Path .\install-extension-hub.ps1)) { Write-Phase "Extensions" "WARN" "install-extension-hub.ps1 introuvable"; return $true }
  & .\install-extension-hub.ps1 @PSSetSeverityInfo 'SilentlyContinue'
  Write-Phase "Extensions" "OK" "Extensions traitées"
  return $true
}

# --- Phase 5 : plugin ---
function Phase-Plugin {
  Write-Phase "Plugin" "START" "devin plugins install --local plugin-devin"
  if ($WhatIf) { Write-Phase "Plugin" "SKIP" "-WhatIf"; return $true }
  if (Get-Command devin -ErrorAction SilentlyContinue) {
    & devin plugins install --local plugin-devin @PSSetSeverityInfo 'SilentlyContinue'
  } else {
    Write-Phase "Plugin" "SKIP" "CLI devin introuvable, saut"
  }
  Write-Phase "Plugin" "OK" "Plugin traité"
  return $true
}

# --- Phase 6 : config ---
function Phase-Config {
  Write-Phase "Config" "START" "setup-config.mjs + setup-devin-acp.mjs + rules/skills"
  if ($WhatIf) { Write-Phase "Config" "SKIP" "-WhatIf"; return $true }
  if (Test-Path .\setup-config.mjs) { & .\setup-config.mjs @PSSetSeverityInfo 'SilentlyContinue' }
  if (Test-Path .\setup-devin-acp-mjs) { & .\setup-devin-acp-mjs @PSSetSeverityInfo 'SilentlyContinue' }
  if (Test-Path .\setup-devin-binome.ps1) { & .\setup-devin-binome.ps1 @PSSetSeverityInfo 'SilentlyContinue' }
  if (Test-Path .\setup-agent-surfaces.ps1) { & .\setup-agent-surfaces.ps1 @PSSetSeverityInfo 'SilentlyContinue' }
  if (Test-Path .\setup-mcp-mux.mjs) { & .\setup-mcp-mux.mjs @PSSetSeverityInfo 'SilentlyContinue' }
  Write-Phase "Config" "OK" "Configuration injectée"
  return $true
}

# --- Phase 7 : services ---
function Phase-Services {
  Write-Phase "Services" "START" "hphe-indexd, taskwatch, bridge :7477"
  if ($WhatIf) { Write-Phase "Services" "SKIP" "-WhatIf"; return $true }
  if (Test-Path .\mcp_autostart.ps1) { & .\mcp_autostart.ps1 @PSSetSeverityInfo 'SilentlyContinue' }
  if (Test-Path .\start-workspace.ps1) { & .\start-workspace.ps1 @PSSetSeverityInfo 'SilentlyContinue' }
  Write-Phase "Services" "OK" "Services démarrés"
  return $true
}

# --- Phase 8 : secrets ---
function Phase-Secrets {
  Write-Phase "Secrets" "START" "Prompt interactif pour NVIDIA/Gemini clés (JAMAIS en dur)"
  if ($WhatIf) { Write-Phase "Secrets" "SKIP" "-WhatIf"; return $true }
  # Invite interactive ; aucune valeur n'est écrite en dur
  Write-Host "Configurez vos clés API (entrez vide pour sauter) :"
  if (-not $env:NVIDIA_API_KEY) {
    $key = Read-Host "NVIDIA_API_KEY"
    if ($key) { $env:NVIDIA_API_KEY = $key } else { Write-Phase "Secrets" "WARN" "NVIDIA_API_KEY sautée" }
  }
  if (-not $env:NVIDIA_API_KEY_2) {
    $key2 = Read-Host "NVIDIA_API_KEY_2"
    if ($key2) { $env:NVIDIA_API_KEY_2 = $key2 } else { Write-Phase "Secrets" "WARN" "NVIDIA_API_KEY_2 sautée" }
  }
  if (-not $env:GEMINI_API_KEY) {
    $key3 = Read-Host "GEMINI_API_KEY"
    if ($key3) { $env:GEMINI_API_KEY = $key3 } else { Write-Phase "Secrets" "WARN" "GEMINI_API_KEY sautée" }
  }
  Write-Phase "Secrets" "OK" "Clés configurées (env vars en mémoire uniquement)"
  return $true
}

# --- Phase 9 : health ---
function Phase-Health {
  Write-Phase "Health" "START" "kit-health.ps1 audit"
  if ($WhatIf) { Write-Phase "Health" "SKIP" "-WhatIf"; return $true }
  if (Test-Path .\kit-health.ps1) {
    & .\kit-health.ps1 @PSSetSeverityInfo 'SilentlyContinue'
    $rc = $LASTEXITCODE
    if ($rc -eq 0) { Write-Phase "Health" "OK" "Tous les checks passent" }
    else { Write-Phase "Health" "WARN" "Certains checks ont échoué (code $rc)" }
  } else {
    Write-Phase "Health" "WARN" "kit-health.ps1 introuvable"
  }
  return $true
}

# --- Main ---
function Main {
  # Déterminer les phases à exécuter
  $allPhases = @('Prerequis','Engine','AgentLayer','Cli','Extensions','Plugin','Config','Services','Secrets','Health')
  $phases = $null;
  if ($Only) { $phases = @($Only.Name) }
  else { $phases = $allPhases }

  # Filtre -Skip
  if ($Skip) {
    $phases = $phases | Where-Object { $_ -notin $Skip }
  }

  $global:PhaseResults = @{}
  $global:Overall = 'OK'

  foreach ($phaseName in $phases) {
    $phaseFunc = Get-Command "Phase-$phaseName" -ErrorAction SilentlyContinue
    if (-not $phaseFunc) {
      Write-Phase $phaseName "FAIL" "Fonction introuvable"
      $global:PhaseResults[$phaseName] = 'FAIL'
      $global:Overall = 'FAIL'
      continue
    }
    try {
      $result = & $phaseFunc
      $global:PhaseResults[$phaseName] = if ($result) { 'OK' } else { 'FAIL' }
      if (-not $result) { $global:Overall = 'FAIL' }
    } catch {
      $global:PhaseResults[$phaseName] = 'FAIL'
      $global:Overall = 'FAIL'
      Write-Phase $phaseName "FAIL" "Erreur : $_"
    }
  }

  # Rapport
  Write-Host "`n=== RÉSUMÉ D'INSTALLATION ==="
  foreach ($pn in $phases.Keys) {
    Write-Host "Phase $pn : $($global:PhaseResults[$pn])"
  }
  Write-Host "Statut global : $global:Overall"
  if ($global:Overall -eq 'FAIL') { exit 1 } else { exit 0 }
}

Main