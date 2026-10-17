# Setup-Collab — Kit de Portabilité et Configuration Collaborateur

Ce répertoire regroupe les scripts et documents permettant de répliquer de manière autonome et sécurisée la configuration complète des agents Devin, de l'orchestrateur Hephaistos et du pont agent-bridge sur n'importe quel poste collaborateur Windows.

---

## Contenu du Répertoire

- `configurer-devin-agents.ps1` : Script PowerShell autonome configurant les 9 agents (Dual-Mode ACP + CLI), déployant l'agent-bridge et vérifiant les connexions.
- `configurer-devin-agents.cmd` : Lanceur Windows en un clic (`powershell.exe -ExecutionPolicy Bypass`).
- `GUIDE-AGENT-COLLABORATEUR.md` : Guide opérationnel complet destiné à l'agent IA distant pour l'assistance à la configuration.
- `REPLICATION_GUIDE.md` : Guide de réplication système approfondi (MCP, skills `/boost` et `/obsidian`, variables).
- `mcp_config.example.json` : Modèle de configuration MCP pour `%APPDATA%\devin\mcp_config.json`.
- `skills/` : Skills de réplication prêtes à l'emploi.

---

## Utilisation

```cmd
setup-collab\configurer-devin-agents.cmd
```
Ou en PowerShell :
```powershell
pwsh -ExecutionPolicy Bypass -File .\setup-collab\configurer-devin-agents.ps1
```
