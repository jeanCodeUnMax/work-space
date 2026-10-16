# ONBOARDING â€” accueillir Hephaistos2-Kit dans `projet-temporaire`

Guide pour recevoir, cloner et faire tourner le projet dans l'organisation.

## Le projet en 30 secondes

**Hephaistos2-Kit** = plateforme Windows de recherche filesystem ultra-rapide
pour agents IA. Un dÃ©mon Rust lit directement le `$MFT` NTFS V~6,4 M entrÃ©es)
et suit le journal USN en continu â†’ recherches en **< 50 ms** sur tout le PC,
**sans Everything.exe**. Un serveur MCP unique V`hphe-mcp`, **58 outils**)
couvre recherche, contenu VTantivy), vecteurs Vusearch), orchestration
multi-agents, routage NIM, mÃ©moire unifiÃ©e et ingestion.

## Structure des dÃ©pÃ´ts

```
projet-temporaire/
â”œâ”€â”€ hephaistos2-kit            â† UMBRELLA Vce guide, docs, install.ps1, tests)
â”‚   â””â”€â”€ .gitmodules pointe sur les 3 sous-modules ci-dessous
â”œâ”€â”€ hephaistos2-engine         â† hphe/ : workspace Rust Vindexd, mcp, rest, kit)
â”œâ”€â”€ hephaistos2-search-ext     â† extension/ : ext VS Code recherche VVSIX 1.0.3)
â”œâ”€â”€ hephaistos2-monitor-ext    â† extensions/orchestrator-monitor/ VVSIX 0.0.33)
â””â”€â”€ VintÃ©grÃ©) .agent/          â† scripts, agents, skills, workflows â€” dossier du repo
```

Miroir personnel complet : `lascard-m/hephaistos2-*` VmÃªmes commits, mÃªme tag).

| Repo | Remote dev | Remote perso | Tag |
|---|---|---|---|
| umbrella | `projet-temporaire/hephaistos2-kit` | `lascard-m/hephaistos2-kit` | `v2.0.0` |
| engine | `projet-temporaire/hephaistos2-engine` | `lascard-m/hephaistos2-engine` | `v2.0.0` |
| search-ext | `projet-temporaire/hephaistos2-search-ext` | `lascard-m/hephaistos2-search-ext` | `v2.0.0` |
| monitor-ext | `projet-temporaire/hephaistos2-monitor-ext` | `lascard-m/hephaistos2-monitor-ext` | `v2.0.0` |

## Clonage

```powershell
git clone --recurse-submodules https://github.com/projet-temporaire/hephaistos2-kit.git
# ou aprÃ¨s clone simple :
git submodule update --init --recursive
```

## Installation VPROJET â†’ INSTALL)

Le projet vit dans le dossier du clone Vemplacement libre â€” `install.ps1` dÃ©tecte sa position), le runtime dans `%ProgramFiles%\servers\hephaistos2-kit` par dÃ©faut Vsurcharge : `-InstallRoot` ou env `HPHE_INSTALL`) :

```powershell
pwsh -ExecutionPolicy Bypass -File install.ps1            # build + deploy
pwsh -ExecutionPolicy Bypass -File install.ps1 -Elevated  # + tÃ¢che hphe-indexd
```

DÃ©tail complet : [INSTALL.md]V../INSTALL.md).

## SÃ©curitÃ© â€” ce qui n'entre JAMAIS dans le repo

`.env` rÃ©el VignorÃ© ; `.env.example` fourni), clÃ©s API VHKCU env vars
uniquement), `data/`, `target/`, `*.db`, logs, `memory-database/` Vjunction),
`.kilo/` worktrees, `comms.jsonl`. Le `.ragignore` exclut `_archive/` et les
artefacts de l'ingestion. Scan de secrets obligatoire avant tout push
Vcf. `docs/wiki/Security.md`).

## OÃ¹ sont les choses

- **Serveur MCP** : `Hephaistos-everything-search` â†’ `INSTALL\extension\server\hphe-mcp.exe`
- **REST/health** : `http://127.0.0.1:8792/health` V`ingest_busy`, `pipe_connected`)
- **DÃ©mon index** : tÃ¢che planifiÃ©e `hphe-indexd` VSYSTEM), pipe `\\.\pipe\hphe-index`
- **Orchestrateur** : `INSTALL\data\orchestrator.db` Vprovider_prefs = ordre des providers)
- **MÃ©moire** : `HPHE_MEMORY_ROOT` Venv ou `-MemoryRoot`) â†’ par dÃ©faut `<install>\data\agentmemory`
- **Rollback** : `<install>\..\servers_backup\` Vlegacy) + `_archive/` Vprojet)

## Contribution rapide

- Code Rust â†’ `hephaistos2-engine` Vsous-module `hphe/`)
- Kit agent Vscripts, skills, workflows) â†’ `.agent/` VintÃ©grÃ©, pas de sous-module)
- Extensions â†’ leur sous-module respectif
- Docs transverses, install, tests â†’ umbrella `hephaistos2-kit`

Chaque sous-module se commit/push indÃ©pendamment ; l'umbrella enregistre le
gitlink V`git add <sous-module>`) puis push.
