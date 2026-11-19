# update-kit.ps1 — "mets a jour" / "git pull" sur hephaistos2-kit
# pull org -> sous-modules (checkout gitlinks) -> install VSIX existants (JAMAIS de build) -> purge watchdog -> push jcum
param(
  [string]$KitRoot = 'C:\data-sys\hephaistos2-kit',
  [string]$Branch = 'integration-n8n',
  [string]$ExtDir = "$HOME\.devin\extensions",
  [switch]$SkipPush
)
$ErrorActionPreference = 'Continue'
function Log($m){ Write-Output "==> $m" }
function RunGit($dir, [string[]]$a){ $o = & git -C $dir @a 2>&1 | Out-String; return $o.Trim() }

# 1. Pull superprojet (origin = projet-temporaire)
Log "pull origin $Branch"
$dirty = git -C $KitRoot status --porcelain --untracked-files=no
if ($dirty) { git -C $KitRoot stash push -m "pre-update" -u | Out-Null }
Log (RunGit $KitRoot @('pull','origin',$Branch))

# 2. Sous-modules : checkout du SHA enregistre (gitlink), en fetchant l'URL de .gitmodules
$gitmodules = Get-Content "$KitRoot\.gitmodules" -Raw
foreach ($m in [regex]::Matches($gitmodules,'path = (\S+)\s+url = (\S+)')) {
  $rel = $m.Groups[1].Value; $url = $m.Groups[2].Value; $path = Join-Path $KitRoot $rel
  if (-not (Test-Path "$path\.git")) { continue }
  $tree = RunGit $KitRoot @('ls-tree','HEAD','--',$rel)
  $sha = [regex]::Match($tree,'[0-9a-f]{40}').Value
  if (-not $sha) { Log "skip $rel (pas de gitlink)"; continue }
  Log "submodule $rel -> $($sha.Substring(0,7))"
  RunGit $path @('fetch',$url) | Out-Null
  RunGit $path @('checkout',$sha) | Select-Object -Last 1 | ForEach-Object { Log $_ }
}

# 3. Install extensions : VSIX le plus recent dans chaque dossier extensions/*, sinon copie du dossier dev
foreach ($ext in Get-ChildItem "$KitRoot\extensions" -Directory) {
  $pkgPath = Join-Path $ext.FullName 'package.json'
  if (-not (Test-Path $pkgPath)) { continue }
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $name = $pkg.name; $ver = $pkg.version; $pub = if ($pkg.publisher) { $pkg.publisher } else { 'hephaistos' }
  $dest = Join-Path $ExtDir "$pub.$name-$ver"
  $vsix = Get-ChildItem "$($ext.FullName)\$name-*.vsix" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($vsix -and ($vsix.Name -match [regex]::Escape($ver))) {
    Log "install $name $ver depuis $($vsix.Name)"
    $tmp = Join-Path $env:TEMP "vsix-$name-$ver"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $vsix.FullName -DestinationPath $tmp -Force
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item "$tmp\extension\*" $dest -Recurse -Force
  } else {
    Log "install $name $ver en dossier dev (pas de vsix)"
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item "$($ext.FullName)\*" $dest -Recurse -Force -Exclude .git,node_modules
  }
  # REGLE GRAVEE : VSIX/copie n'embarquent pas node_modules -> npm install --omit=dev obligatoire
  $deps = $pkg.PSObject.Properties['dependencies']
  if ($deps -and $deps.Value.PSObject.Properties.Count -gt 0) {
    Log "npm install --omit=dev dans $($pub).$name-$ver"
    Push-Location $dest
    try { & npm install --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Log "  npm: $_" } } finally { Pop-Location }
  }
  Get-ChildItem $ExtDir -Directory | Where-Object { $_.Name -like "$pub.$name-*" -and $_.Name -ne "$pub.$name-$ver" } | ForEach-Object {
    New-Item -ItemType Directory -Path "$ExtDir.bak" -Force | Out-Null
    try { Move-Item $_.FullName "$ExtDir.bak\" -Force -ErrorAction Stop; Log "archive $($_.Name)" } catch { Log "verrouille (ok): $($_.Name)" }
  }
}

# 4. Purge watchdog
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'watchdog\.ps1' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Log "watchdog tue PID $($_.ProcessId)"
}
foreach ($scope in 'User','Machine') {
  foreach ($v in 'HEPHAISTOS_WATCHDOG','ORCH_MODEL_PING_MS') {
    if ($null -ne [Environment]::GetEnvironmentVariable($v,$scope)) { [Environment]::SetEnvironmentVariable($v,$null,$scope); Log "env suppr $scope/$v" }
  }
}

# 5. Push perso : sous-modules puis superprojet vers jcum
if (-not $SkipPush) {
  foreach ($rel in (Get-ChildItem "$KitRoot\extensions" -Directory).FullName + "$KitRoot\hphe") {
    if (-not (Test-Path "$rel\.git")) { continue }
    $target = if ((git -C $rel remote) -contains 'jcum') { 'jcum' } else { 'origin' }
    $r = RunGit $rel @('push',$target,'HEAD:main')
    Log "push $(Split-Path $rel -Leaf) -> $target : $($r.Split("`n") | Select-Object -Last 1)"
  }
  $r = RunGit $KitRoot @('push','jcum',$Branch)
  Log "push kit : $($r.Split("`n") | Select-Object -Last 1)"
}
Log 'TERMINE - Developer: Reload Window dans Devin'
