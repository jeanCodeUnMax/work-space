[CmdletBinding()]
param(
  [string]$WorkspaceRoot,
  [ValidateRange(5, 3600)]
  [int]$IntervalSeconds = 60,
  [ValidateRange(1, 1440)]
  [int]$StaleTaskMinutes = 30,
  [ValidateRange(1, 1440)]
  [int]$CriticalTaskMinutes = 90,
  [string]$AgyCascadeId = '7f0aa3fb-9e17-4a4f-8c4f-b6ce12157dd3',
  [string]$AgyModel = 'MODEL_PLACEHOLDER_M418',
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $WorkspaceRoot) {
  $WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
}
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

$script:AgentDir = Join-Path $WorkspaceRoot '.agent'
$script:LogPath = Join-Path $script:AgentDir 'logs\reactive-orchestrator-watchdog.jsonl'
$script:StatePath = Join-Path $PSScriptRoot 'watch-state.json'
$script:CommsPath = Join-Path $script:AgentDir 'comms.jsonl'
$script:McpCall = Join-Path $WorkspaceRoot '.agent\devin\scripts\mcp-call.mjs'
$script:BridgeHelper = Join-Path $WorkspaceRoot '.agent\agent-bridge\devin-hub.js'
$script:AgyHelper = Join-Path $WorkspaceRoot '.agent\agent-bridge\agy-hub.js'
$script:DbPath = if ($env:ORCHESTRATOR_DB) {
  $env:ORCHESTRATOR_DB
} elseif ($env:HPHE_ORCH_DB) {
  $env:HPHE_ORCH_DB
} else {
  Join-Path $env:ProgramFiles 'servers\hephaistos2-kit\data\orchestrator.db'
}
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:State = @{
  alerts = @{}
  commsOffset = [long]0
  cpuHighSince = $null
  lastAgyWakeAt = $null
  lastAcpProbeAt = $null
  taskFirstSeen = @{}
  taskStatuses = @{}
  wokenTasks = @{}
}
$script:ActiveAlertKeys = @{}
$script:PendingWakeNotes = [System.Collections.Generic.List[string]]::new()
$stateLoaded = $false

if (Test-Path -LiteralPath $script:StatePath) {
  try {
    $loaded = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json -AsHashtable
    foreach ($key in @('alerts', 'taskFirstSeen', 'taskStatuses', 'wokenTasks')) {
      if (-not $loaded.Contains($key) -or $loaded[$key] -isnot [System.Collections.IDictionary]) { $loaded[$key] = @{} }
    }
    foreach ($key in @('commsOffset', 'cpuHighSince', 'lastAgyWakeAt', 'lastAcpProbeAt')) {
      if (-not $loaded.Contains($key)) { $loaded[$key] = $null }
    }
    if ($loaded.commsOffset -isnot [long] -and $loaded.commsOffset -isnot [int]) {
      $loaded.commsOffset = [long]0
    }
    $script:State = $loaded
    $stateLoaded = $true
  } catch {
    Write-Warning 'Watchdog state is unreadable; starting with a clean in-memory state.'
  }
}
if (-not $stateLoaded -and (Test-Path -LiteralPath $script:CommsPath)) {
  $script:State.commsOffset = (Get-Item -LiteralPath $script:CommsPath).Length
}

function Write-Log {
  param(
    [Parameter(Mandatory)][string]$Level,
    [Parameter(Mandatory)][string]$Event,
    [hashtable]$Details = @{}
  )
  $record = [ordered]@{
    ts = [DateTime]::UtcNow.ToString('o')
    level = $Level
    event = $Event
    details = $Details
  }
  $line = $record | ConvertTo-Json -Compress -Depth 8
  [System.IO.File]::AppendAllText($script:LogPath, $line + "`n", $script:Utf8NoBom)
  Write-Output $line
}

function Get-Field {
  param($Object, [Parameter(Mandatory)][string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function ConvertTo-UtcDateTime {
  param($Value, [DateTime]$Fallback)
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  $parsed = [DateTimeOffset]::MinValue
  $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal
  if ([DateTimeOffset]::TryParse(
      [string]$Value,
      [System.Globalization.CultureInfo]::InvariantCulture,
      $styles,
      [ref]$parsed
    )) {
    return $parsed.UtcDateTime
  }
  return $Fallback
}

function Save-State {
  $temporaryPath = "$script:StatePath.tmp"
  $json = $script:State | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($temporaryPath, $json, $script:Utf8NoBom)
  Move-Item -LiteralPath $temporaryPath -Destination $script:StatePath -Force
}

function Write-CommsEvent {
  param([Parameter(Mandatory)][string]$Code, [string]$TaskId = '')
  $text = if ($TaskId) { "[WATCHDOG] code=$Code taskId=$TaskId" } else { "[WATCHDOG] code=$Code" }
  $entry = [ordered]@{
    ts = [DateTime]::UtcNow.ToString('o')
    src = 'watchdog'
    dst = 'dashboard'
    kind = 'event'
    text = $text
  }
  if ($TaskId) { $entry.taskId = $TaskId }
  $line = ($entry | ConvertTo-Json -Compress -Depth 4) + "`n"
  [System.IO.File]::AppendAllText($script:CommsPath, $line, $script:Utf8NoBom)
}

function Queue-AgyWakeNote {
  param([Parameter(Mandatory)][string]$Note)
  if (-not $script:PendingWakeNotes.Contains($Note)) {
    $script:PendingWakeNotes.Add($Note)
  }
}

function Set-Alert {
  param(
    [Parameter(Mandatory)][string]$Key,
    [Parameter(Mandatory)][string]$Code,
    [string]$TaskId = ''
  )
  $script:ActiveAlertKeys[$Key] = $true
  if (-not $script:State.alerts.ContainsKey($Key)) {
    $script:State.alerts[$Key] = [DateTime]::UtcNow.ToString('o')
    $details = @{ code = $Code }
    if ($TaskId) { $details.taskId = $TaskId }
    Write-Log -Level 'warning' -Event 'alert' -Details $details
    try { Write-CommsEvent -Code $Code -TaskId $TaskId } catch {
      Write-Log -Level 'error' -Event 'comms_write_failed' -Details @{}
    }
    if ($Code -notmatch '^wakeup_wake-noroute$') {
      $alertLabel = if ($TaskId) { "ALERT:$Code(#$TaskId)" } else { "ALERT:$Code" }
      Queue-AgyWakeNote -Note $alertLabel
    }
  }
}

function Invoke-NodeText {
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [string[]]$NodeArgs = @()
  )
  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "Node helper not found: $ScriptPath"
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $output = & $node $ScriptPath @NodeArgs 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Node helper failed with exit code $LASTEXITCODE" }
  return ($output -join "`n")
}

function Invoke-McpJson {
  param(
    [Parameter(Mandatory)][string]$Tool,
    [string]$ArgsJson = '{}'
  )
  $oldTimeout = $env:MCP_CALL_TIMEOUT_MS
  $env:MCP_CALL_TIMEOUT_MS = '20000'
  try {
    $raw = Invoke-NodeText -ScriptPath $script:McpCall -NodeArgs @(
      'Hephaistos-everything-search', $Tool, $ArgsJson
    )
    return $raw | ConvertFrom-Json -AsHashtable
  } finally {
    $env:MCP_CALL_TIMEOUT_MS = $oldTimeout
  }
}

function Read-CommsDelta {
  if (-not (Test-Path -LiteralPath $script:CommsPath)) { return }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $script:CommsPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    $offset = [long]$script:State.commsOffset
    if ($offset -gt $stream.Length) { $offset = 0 }
    if ($stream.Length -le $offset) { return }
    $stream.Position = $offset
    $buffer = [byte[]]::new([int]($stream.Length - $offset))
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    $lastNewline = $text.LastIndexOf("`n")
    if ($lastNewline -lt 0) { return }
    $completeText = $text.Substring(0, $lastNewline)
    $script:State.commsOffset = $offset + [System.Text.Encoding]::UTF8.GetByteCount(
      $text.Substring(0, $lastNewline + 1)
    )
  } finally {
    if ($stream) { $stream.Dispose() }
  }

  foreach ($line in $completeText -split "`n") {
    if (-not $line.Trim()) { continue }
    try { $message = $line | ConvertFrom-Json -AsHashtable } catch { continue }
    $kind = [string](Get-Field $message 'kind')
    if (-not $kind.StartsWith('wake', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $details = @{
      kind = $kind
      src = [string](Get-Field $message 'src')
      dst = [string](Get-Field $message 'dst')
    }
    $messageTaskId = Get-Field $message 'taskId'
    if ($null -ne $messageTaskId) { $details.taskId = [string]$messageTaskId }
    Write-Log -Level 'info' -Event 'wakeup' -Details $details
    $msgText = [string](Get-Field $message 'text')
    if ($msgText -match '\[WAKE\]\s+t.che\s+#(\d+)\s+.+\s+(completed|failed|cancelled)') {
      $tid = $Matches[1]
      $tstatus = $Matches[2]
      $wakeKey = "${tid}:${tstatus}"
      if (-not $script:State.wokenTasks.ContainsKey($wakeKey)) {
        $script:State.wokenTasks[$wakeKey] = [DateTime]::UtcNow.ToString('o')
        if ($msgText -match '\(non rout.\)' -and $msgText -notmatch 'agycascade:') {
          Queue-AgyWakeNote -Note "TASK #$tid -> $tstatus"
        }
      }
    }
    if ($kind -match '(?i)failed|noroute|unknown|disabled|unsupported') {
      $taskId = if ($null -ne $messageTaskId) { [string]$messageTaskId } else { '' }
      Set-Alert -Key "wakeup:${kind}:$taskId" -Code "wakeup_$kind" -TaskId $taskId
    }
  }
}

function Get-Dependencies {
  param($Task)
  $dependencies = Get-Field $Task 'dependencies'
  if (-not $dependencies) { return @() }
  try {
    $value = ([string]$dependencies) | ConvertFrom-Json
    return @($value | ForEach-Object { [string]$_ })
  } catch {
    return @('__invalid_dependencies__')
  }
}

function Test-DependenciesComplete {
  param($Task, [hashtable]$TasksById)
  foreach ($dependencyId in (Get-Dependencies -Task $Task)) {
    if (-not $TasksById.ContainsKey($dependencyId)) { return $false }
    if ([string]$TasksById[$dependencyId].status -ne 'completed') { return $false }
  }
  return $true
}

function Invoke-Snapshot {
  $script:ActiveAlertKeys = @{}
  $script:PendingWakeNotes.Clear()
  $now = [DateTime]::UtcNow
  Read-CommsDelta

  $tasks = @()
  $agents = @()
  $mcpOk = $false
  try {
    $tasks = @(Invoke-McpJson -Tool 'list_tasks' -ArgsJson '{}')
    $agents = @(Invoke-McpJson -Tool 'list_agents' -ArgsJson '{}')
    $mcpOk = $true
  } catch {
    Set-Alert -Key 'mcp:unavailable' -Code 'orchestrator_mcp_unavailable'
  }

  $isInitialStatusSeed = ($script:State.taskStatuses.Count -eq 0)
  $tasksById = @{}
  foreach ($task in $tasks) {
    $taskId = Get-Field $task 'id'
    if ($null -ne $taskId) {
      $idStr = [string]$taskId
      $tasksById[$idStr] = $task
      $curStatus = [string](Get-Field $task 'status')
      $prevStatus = if ($script:State.taskStatuses.ContainsKey($idStr)) { [string]$script:State.taskStatuses[$idStr] } else { $null }
      $script:State.taskStatuses[$idStr] = $curStatus
      if (-not $isInitialStatusSeed -and $prevStatus -ne $curStatus -and $curStatus -in @('completed', 'failed', 'cancelled')) {
        $wakeKey = "${idStr}:${curStatus}"
        if (-not $script:State.wokenTasks.ContainsKey($wakeKey)) {
          $script:State.wokenTasks[$wakeKey] = $now.ToString('o')
          $tTitle = [string](Get-Field $task 'title')
          Queue-AgyWakeNote -Note "TASK #$idStr -> $curStatus ($tTitle)"
        }
      }
    }
  }
  $inProgress = @($tasks | Where-Object { $_.status -eq 'in_progress' })
  $pending = @($tasks | Where-Object { $_.status -eq 'pending' })
  $failed = @($tasks | Where-Object { $_.status -eq 'failed' })

  if ($mcpOk) {
    $liveTaskIds = @{}
    foreach ($task in $inProgress) {
      $id = [string](Get-Field $task 'id')
      $liveTaskIds[$id] = $true
      if (-not $script:State.taskFirstSeen.ContainsKey($id)) {
        $script:State.taskFirstSeen[$id] = $now.ToString('o')
      }

      if (-not (Test-DependenciesComplete -Task $task -TasksById $tasksById)) {
        Set-Alert -Key "task:deps:$id" -Code 'task_dependencies_unresolved' -TaskId $id
      }

      $firstSeen = ConvertTo-UtcDateTime -Value $script:State.taskFirstSeen[$id] -Fallback $now
      $ageMinutes = ($now - $firstSeen).TotalMinutes
      if ($ageMinutes -ge $StaleTaskMinutes) {
        Set-Alert -Key "task:stale:$id" -Code 'task_in_progress_stale' -TaskId $id
      }
      if ($ageMinutes -ge $CriticalTaskMinutes) {
        Set-Alert -Key "task:critical:$id" -Code 'task_in_progress_critical' -TaskId $id
      }

      $assignedId = [string](Get-Field $task 'assigned_to')
      if ($assignedId -and -not ($agents | Where-Object { [string]$_.id -eq $assignedId -and [int]$_.active -eq 1 })) {
        Set-Alert -Key "task:inactive-agent:$id" -Code 'task_assigned_agent_inactive' -TaskId $id
      }
    }

    foreach ($taskId in @($script:State.taskFirstSeen.Keys)) {
      if (-not $liveTaskIds.ContainsKey($taskId)) { $script:State.taskFirstSeen.Remove($taskId) }
    }

    foreach ($task in $pending) {
      if (-not (Get-Field $task 'assigned_to') -or -not (Test-DependenciesComplete -Task $task -TasksById $tasksById)) { continue }
      $createdAt = ConvertTo-UtcDateTime -Value (Get-Field $task 'created_at') -Fallback ([DateTime]::MinValue)
      if ($createdAt -ne [DateTime]::MinValue -and
          ($now - $createdAt).TotalMinutes -ge $StaleTaskMinutes) {
        $pendingTaskId = [string](Get-Field $task 'id')
        Set-Alert -Key "task:pending:$pendingTaskId" -Code 'task_pending_stale' -TaskId $pendingTaskId
      }
    }

    $artifactOwners = @{}
    foreach ($task in $inProgress) {
      $artifact = ([string](Get-Field $task 'expected_artifact')).Trim()
      if (-not $artifact) { continue }
      $key = $artifact.ToLowerInvariant()
      if (-not $artifactOwners.ContainsKey($key)) { $artifactOwners[$key] = @() }
      $artifactOwners[$key] += [string]$task.id
    }
    foreach ($owners in $artifactOwners.Values) {
      if ($owners.Count -gt 1) {
        Set-Alert -Key "task:artifact-collision:$($owners -join ',')" -Code 'task_expected_artifact_collision'
      }
    }
  }

  $cpu = $null
  try {
    $cpuRow = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    if ($cpuRow) { $cpu = [int]$cpuRow.PercentProcessorTime }
  } catch { }

  $processes = @()
  try { $processes = @(Get-CimInstance Win32_Process) } catch { }
  $workerProcesses = @($processes | Where-Object {
    $_.Name -match '^(agy|cargo|devin|hermes|kilo|ollama|opencode|rustc|vibe)(\.exe)?$' -or
    ($_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match 'nim-worker\.mjs')
  })
  if ($null -ne $cpu -and $cpu -ge 90 -and $workerProcesses.Count -eq 0) {
    if (-not $script:State.cpuHighSince) { $script:State.cpuHighSince = $now.ToString('o') }
    $cpuStart = ConvertTo-UtcDateTime -Value $script:State.cpuHighSince -Fallback $now
    if (($now - $cpuStart).TotalMinutes -ge 5) {
      Set-Alert -Key 'cpu:high-without-worker' -Code 'cpu_high_without_worker'
    }
  } else {
    $script:State.cpuHighSince = $null
  }

  $dbPulsePath = @("$script:DbPath-wal", $script:DbPath) |
    Where-Object { Test-Path -LiteralPath $_ } |
    Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending |
    Select-Object -First 1
  $dbAgeMinutes = $null
  if ($dbPulsePath) {
    $dbAgeMinutes = ($now - (Get-Item -LiteralPath $dbPulsePath).LastWriteTimeUtc).TotalMinutes
    if ($inProgress.Count -gt 0 -and $dbAgeMinutes -ge 30) {
      Set-Alert -Key 'db:stale' -Code 'orchestrator_db_pulse_stale'
    }
  } elseif ($inProgress.Count -gt 0) {
    Set-Alert -Key 'db:missing' -Code 'orchestrator_db_missing'
  }

  $health = 'unknown'
  try {
    $healthRaw = Invoke-NodeText -ScriptPath $script:McpCall -NodeArgs @(
      'Hephaistos-everything-search', 'hphe_health', '{}'
    )
    $healthResult = $healthRaw | ConvertFrom-Json -AsHashtable
    if ($healthResult.status -eq 'healthy' -and $healthResult.pipe_connected) { $health = 'healthy' }
    else { $health = 'unhealthy' }
  } catch { $health = 'unreachable' }
  if ($health -in @('unhealthy', 'unreachable')) {
    Set-Alert -Key 'health:hphe' -Code 'hphe_health_failed'
  }

  $bridge = 'unreachable'
  try {
    $bridgeResult = Invoke-NodeText -ScriptPath $script:BridgeHelper -NodeArgs @('status') |
      ConvertFrom-Json -AsHashtable
    if ($bridgeResult.status -eq 'connected') { $bridge = 'connected' }
  } catch { }
  if ($bridge -ne 'connected') { Set-Alert -Key 'bridge:down' -Code 'websocket_bridge_unreachable' }

  $agyHub = 'unreachable'
  $agyConversationCount = 0
  try {
    $agyRows = @(Invoke-NodeText -ScriptPath $script:AgyHelper -NodeArgs @('list') |
      ConvertFrom-Json -AsHashtable)
      $agyConversationCount = @($agyRows).Count
    $agyHub = 'connected'
  } catch { }
  if ($agyHub -ne 'connected') { Set-Alert -Key 'hub:agy' -Code 'antigravity_hub_unreachable' }

  $acpSummary = $null
  $lastAcpProbe = ConvertTo-UtcDateTime -Value $script:State.lastAcpProbeAt -Fallback ([DateTime]::MinValue)
  if (($now - $lastAcpProbe).TotalMinutes -ge 5) {
    try {
      $acpRows = @(Invoke-NodeText -ScriptPath $script:BridgeHelper -NodeArgs @('acp-list') |
        ConvertFrom-Json -AsHashtable)
      $acpSummary = @{}
      foreach ($row in $acpRows) {
        $provider = [string](Get-Field $row 'providerId')
        if (-not $acpSummary.ContainsKey($provider)) {
          $acpSummary[$provider] = @{ listed = 0; focused = 0 }
        }
        $acpSummary[$provider].listed++
        if ((Get-Field $row 'focused') -eq $true) { $acpSummary[$provider].focused++ }
      }
      $script:State.lastAcpProbeAt = $now.ToString('o')
    } catch {
      Set-Alert -Key 'hub:acp-list' -Code 'acp_session_inventory_unavailable'
    }
  }

  $summary = @{
    inProgress = $inProgress.Count
    pending = $pending.Count
    failed = $failed.Count
    recentFailedIds = @($failed | Select-Object -First 10 | ForEach-Object { [string]$_.id })
    cpuPercent = $cpu
    workerCount = $workerProcesses.Count
    dbPulseAgeMinutes = if ($null -ne $dbAgeMinutes) { [Math]::Round($dbAgeMinutes, 1) } else { $null }
    hpheHealth = $health
    bridge = $bridge
    agyHub = $agyHub
    agyConversationCount = $agyConversationCount
  }
  if ($null -ne $acpSummary) { $summary.acpProviders = $acpSummary }
  Write-Log -Level 'info' -Event 'snapshot' -Details $summary

  if ($script:PendingWakeNotes.Count -gt 0 -and $agyHub -eq 'connected' -and $AgyCascadeId) {
    $wakeText = "[WATCHDOG -> TANGO] " + ($script:PendingWakeNotes -join ' | ') + " (inProgress=$($inProgress.Count), pending=$($pending.Count))"
    try {
      Invoke-NodeText -ScriptPath $script:AgyHelper -NodeArgs @(
        'send', $AgyCascadeId, '--model', $AgyModel, $wakeText
      ) | Out-Null
      $script:State.lastAgyWakeAt = $now.ToString('o')
      Write-Log -Level 'info' -Event 'agy_wake_sent' -Details @{ cascadeId = $AgyCascadeId; notes = @($script:PendingWakeNotes) }
    } catch {
      Write-Log -Level 'error' -Event 'agy_wake_failed' -Details @{ cascadeId = $AgyCascadeId }
    }
  }

  foreach ($key in @($script:State.alerts.Keys)) {
    if (-not $script:ActiveAlertKeys.ContainsKey($key)) { $script:State.alerts.Remove($key) }
  }
  Save-State
}

if ($Once) {
  Invoke-Snapshot
  exit 0
}

$timer = [System.Timers.Timer]::new($IntervalSeconds * 1000)
$timer.AutoReset = $true
$commsWatcher = $null
$eventSources = @()
try {
  Register-ObjectEvent -InputObject $timer -EventName Elapsed -SourceIdentifier 'ReactiveWatchdog.Timer' | Out-Null
  $eventSources += 'ReactiveWatchdog.Timer'
  $timer.Start()

  if (Test-Path -LiteralPath $script:AgentDir) {
    $commsWatcher = [System.IO.FileSystemWatcher]::new($script:AgentDir, 'comms.jsonl')
    $commsWatcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::Size
    Register-ObjectEvent -InputObject $commsWatcher -EventName Changed -SourceIdentifier 'ReactiveWatchdog.CommsChanged' | Out-Null
    Register-ObjectEvent -InputObject $commsWatcher -EventName Created -SourceIdentifier 'ReactiveWatchdog.CommsCreated' | Out-Null
    $eventSources += 'ReactiveWatchdog.CommsChanged', 'ReactiveWatchdog.CommsCreated'
    $commsWatcher.EnableRaisingEvents = $true
  }

  Write-Log -Level 'info' -Event 'watch_started' -Details @{
    workspace = $WorkspaceRoot
    intervalSeconds = $IntervalSeconds
    database = $script:DbPath
  }
  Invoke-Snapshot
  while ($true) {
    $event = Wait-Event -Timeout ($IntervalSeconds + 5)
    if ($event) { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
    foreach ($queuedEvent in @(Get-Event -ErrorAction SilentlyContinue)) {
      if ($eventSources -contains $queuedEvent.SourceIdentifier) {
        Remove-Event -EventIdentifier $queuedEvent.EventIdentifier -ErrorAction SilentlyContinue
      }
    }
    try { Invoke-Snapshot } catch {
      Write-Log -Level 'error' -Event 'snapshot_failed' -Details @{}
    }
  }
} finally {
  $timer.Stop()
  foreach ($source in $eventSources) {
    Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
  }
  if ($commsWatcher) {
    $commsWatcher.EnableRaisingEvents = $false
    $commsWatcher.Dispose()
  }
  $timer.Dispose()
}
