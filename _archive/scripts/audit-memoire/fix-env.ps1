# Repointe les variables User obsoletes vers les chemins canoniques
# Avant : ZVEC_DATA_DIR / MEMORY_FILE_PATH -> F:\Promgramation-teste\agentMemory\.windsurf\...\memory-database (restes de dev)
$before = @{}
foreach ($v in 'ZVEC_DATA_DIR','MEMORY_FILE_PATH') { $before[$v] = [Environment]::GetEnvironmentVariable($v,'User') }

[Environment]::SetEnvironmentVariable('ZVEC_DATA_DIR', 'F:\Sqlite-DB\current_workspace\vector\zvec-data', 'User')
[Environment]::SetEnvironmentVariable('MEMORY_FILE_PATH', 'F:\Sqlite-DB\current_workspace\graph\memory_mcp.db', 'User')

foreach ($v in 'ZVEC_DATA_DIR','MEMORY_FILE_PATH') {
  Write-Output "$v :"
  Write-Output "  avant : $($before[$v])"
  Write-Output "  apres : $([Environment]::GetEnvironmentVariable($v,'User'))"
}
