#!/usr/bin/env bash
# Configure remotes: origin -> art-qalam-fr, temporaire -> projet-temporaire
# Old origin (ArchNext/upstream authors) is renamed to "upstream" when different.
set -u

norm() { echo "${1%.git}"; }

setup_repo() {
  local dir="$1" aq_name="$2" tp_name="$3"
  local aq="https://github.com/art-qalam-fr/${aq_name}.git"
  local tp="https://github.com/projet-temporaire/${tp_name}.git"
  local target
  target=$(norm "$aq")

  if [ ! -d "$dir/.git" ]; then echo "SKIP $dir (no .git)"; return; fi

  local cur
  cur=$(git -C "$dir" remote get-url origin 2>/dev/null || true)

  if [ -z "$cur" ]; then
    local existing
    existing=$(git -C "$dir" remote -v | awk -v t="$target" '{u=$2; sub(/\.git$/,"",u); if(u==t){print $1; exit}}')
    if [ -n "$existing" ]; then
      git -C "$dir" remote rename "$existing" origin
    else
      git -C "$dir" remote add origin "$aq"
    fi
  elif [ "$(norm "$cur")" != "$target" ]; then
    if git -C "$dir" remote get-url upstream >/dev/null 2>&1; then
      echo "WARN $dir: upstream exists, overwriting origin $cur"
      git -C "$dir" remote set-url origin "$aq"
    else
      git -C "$dir" remote rename origin upstream
      local existing
      existing=$(git -C "$dir" remote -v | awk -v t="$target" '{u=$2; sub(/\.git$/,"",u); if(u==t){print $1; exit}}')
      if [ -n "$existing" ]; then
        git -C "$dir" remote rename "$existing" origin
      else
        git -C "$dir" remote add origin "$aq"
      fi
    fi
  fi

  if git -C "$dir" remote get-url temporaire >/dev/null 2>&1; then
    git -C "$dir" remote set-url temporaire "$tp"
  else
    git -C "$dir" remote add temporaire "$tp"
  fi
  echo "OK   $dir"
}

while IFS='|' read -r dir aq tp; do
  [ -z "$dir" ] && continue
  setup_repo "$dir" "$aq" "$tp"
done <<'EOF'
C:/Program Files/servers/filesystem|filesystem|filesystem
C:/Program Files/servers/google-drive|google-drive-mcp|google-drive-mcp
C:/Program Files/servers/kaggle-mcp|kaggle-mcp|kaggle-mcp
C:/Program Files/servers/mcp-quick-sqlite3|mcp-quick-sqlite3|mcp-quick-sqlite3
C:/Users/Administrator/AppData/Local/hermes/mcp-servers/model-discovery|model-discovery-mcp|model-discovery-mcp
C:/Program Files/servers/orchestrator-server|orchestrator-server|orchestrator-server
C:/Program Files/servers/zvec-mcp-server|Zvec|zvec
C:/Program Files/servers/qdrant-mcp-server|qdrant-mcp-server|qdrant-mcp-server
C:/Program Files/servers/mcp-mux|mcp-mux|mcp-mux
C:/Program Files/servers/puppeteer-repo|puppeteer|puppeteer
F:/Promgramation-teste/agentMemory|agentMemory|agentmemory
F:/Promgramation-teste/nim-router-mcp|nim-router-mcp|nim-router-mcp
F:/Promgramation-teste/opencli-cookies|opencli-cookies|opencli-cookies
F:/Promgramation-teste/beacon-mcp|beacon-mcp|beacon-mcp
F:/Promgramation-teste/Hephaistos-Kit|Hephaistos-Kit|Hephaistos-Kit
EOF
