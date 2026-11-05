# kaggle-ctl — controle total des kernels Kaggle
# Usage: .\kaggle-ctl.ps1 <cmd> [args]
#   status <slug>                  statut d'un kernel
#   list                           tous les kernels du compte
#   push <dir>                     pousse un dossier kernel (kernel-metadata.json + code_file)
#   logs <slug> [outdir]           telecharge /kaggle/working (inclut _bootlog.txt)
#   tail-log <slug>                affiche _bootlog.txt si present dans l'output
#   stop <slug>                    ouvre la page kernel -> Stop manuel (pas d'API) 
#   save-dataset <slug>            ouvre la page du run -> bouton "Save as Dataset"
#   watch <slug>                   boucle statut jusqu'a COMPLETE/ERROR
#   fetch-status                   statut des 4 fetch kernels
#   datasets                       liste datasets du compte
param([Parameter(Position=0)][string]$Cmd,[Parameter(Position=1)][string]$A,[Parameter(Position=2)][string]$B)
function Slug($s){ if($s -notmatch '/'){ "lascardm/$s" } else { $s } }
switch($Cmd){
 'status'   { kaggle kernels status (Slug $A) }
 'list'     { kaggle kernels list --mine }
 'push'     { kaggle kernels push -p $A }
 'datasets' { kaggle datasets list -m }
 'logs'     { $d = if($B){$B}else{".\kaggle-out-$A"}; New-Item -ItemType Directory -Force -Path $d | Out-Null; kaggle kernels output (Slug $A) -p $d; Write-Output "output -> $d" }
 'tail-log' { $d = ".\kaggle-out-$A"; if(-not (Test-Path "$d\_bootlog.txt")){ kaggle kernels output (Slug $A) -p $d | Out-Null }; if(Test-Path "$d\_bootlog.txt"){ Get-Content "$d\_bootlog.txt" } else { Write-Output "pas de _bootlog.txt (kernel encore au boot ou mort avant ETAPE2)" } }
 'stop'     { $u="https://www.kaggle.com/code/$(Slug $A)/edit"; Write-Output "Pas d'API stop -> ouvre $u et clique Stop (ou demande a Devin : pilotage navigateur invisible-playwright)"; Start-Process $u }
 'save-dataset' { $u="https://www.kaggle.com/code/$(Slug $A)"; Write-Output "Ouvre la page du run -> bouton 'Save as Dataset' sur la sortie"; Start-Process $u }
 'watch'    { while($true){ $s=(kaggle kernels status (Slug $A) 2>&1); Write-Output "$(Get-Date -Format HH:mm:ss) $s"; if($s -match 'COMPLETE|ERROR|CANCEL'){break}; Start-Sleep 60 } }
 'fetch-status' { foreach($f in 'fetch-ltx','fetch-flux','fetch-wan','fetch-hunyuan'){ kaggle kernels status "lascardm/$f" } }
 default { Write-Output "cmds: status|list|push|logs|tail-log|stop|save-dataset|watch|fetch-status|datasets" }
}

# --- extension daemon (opencli :19825) ---
$DAEMON='http://127.0.0.1:19825'
function DaemonPost([string]$path,[hashtable]$body=$null){
  $h=@{'X-OpenCLI'='1'}
  if($body){ Invoke-RestMethod -Method Post -Uri "$DAEMON$path" -Headers $h -ContentType 'application/json' -Body ($body|ConvertTo-Json -Depth 8) }
  else { Invoke-RestMethod -Method Get -Uri "$DAEMON$path" -Headers $h }
}
function DCmd([string]$action,[hashtable]$params=@{},[int]$timeout=60){
  DaemonPost '/command' @{ id=[guid]::NewGuid().ToString(); action=$action; params=$params; timeout=$timeout; contextId='xpcnh35r' }
}
switch($Cmd){
 'daemon-status' { DaemonPost '/status' | ConvertTo-Json -Depth 6 }
 'nav'      { DCmd 'navigate' @{ url=$A } | ConvertTo-Json -Depth 6 }
 'snap'     { DCmd 'snapshot' @{} | ConvertTo-Json -Depth 6 }
 'click'    { DCmd 'click' @{ selector=$A } | ConvertTo-Json -Depth 6 }
 'type'     { DCmd 'type' @{ selector=$A; text=$B } | ConvertTo-Json -Depth 6 }
 'eval'     { DCmd 'evaluate' @{ expression=$A } | ConvertTo-Json -Depth 6 }
 'cmd'      { DCmd $A ($B | ConvertFrom-Json -AsHashtable) | ConvertTo-Json -Depth 6 }
 'kaggle-open' { (DCmd 'navigate' @{ url="https://www.kaggle.com/code/lascardm/$A" }) | ConvertTo-Json -Depth 6 }
}
