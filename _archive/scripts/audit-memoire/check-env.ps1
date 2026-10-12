foreach ($s in 'User','Machine') {
  foreach ($v in 'AGENT_DB_ROOT','AGENTMEMORY_DATA_ROOT','AGENTMEMORY_STORAGE_PATH','MEMORY_DB_PATH','ZVEC_DATA_DIR','MEMORY_FILE_PATH') {
    $val = [Environment]::GetEnvironmentVariable($v, $s)
    if ($val) { Write-Output "$s  $v = $val" }
  }
}
