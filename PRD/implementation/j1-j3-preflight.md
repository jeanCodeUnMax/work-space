# PREFLIGHT GIT — J1-J3 PLUGIN DEVIN

## A committer
- `plugin-devin/` — squelette plugin (plugin.json, manifeste NTFS, skills-to-plugin-commands.json, src/{index,mcp-proxy,skills}.js, README)
- `PRD/implementation/j1-j3-{codeur,review,audit,sentinelle,preflight}.md` — artefacts pipeline
- `extensions/hephaistos-chats/` — openAcpSession (double-clic agent Devin → onglet cascade) + version 0.3.10
- `.agent/workspace-roster.json` — tâches mission J1-J3
- `.agent/skills/reactive-orchestrator/watchdog.ps1` — auto-heal hphe-indexd
- `.agent/flux/.gitignore` — exclusion prompts de mission

## Exclusions
- `.agent/flux/mission-*.txt`, `audit-input.txt`, `ping-*.txt` — transitoires
- VSIX (non trackées par convention)

## Secrets
- Scan rapide: aucun token/credential dans les fichiers stagés (plugin.json ne contient que des permissions).
