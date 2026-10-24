# Freebox via CLI — `cli-anything-freebox`

CLI agent-native pour piloter la Freebox via l'API **Freebox OS v15**.
Vérifié en direct le 2026-10-23 : box `fbxgw-r2/mini`, firmware `4.13.1`, lien FTTH `up`.

## Où vit quoi

| Élément | Emplacement |
|---|---|
| Exécutable | `F:\Promgramation-teste\CLI-Anything\.venv\Scripts\cli-anything-freebox.exe` |
| Source harness | `F:\Promgramation-teste\CLI-Anything\freebox\agent-harness\` (`setup.py`, `cli_anything/`) |
| Skill | `F:\Promgramation-teste\CLI-Anything\.devin\skills\cli-anything-freebox\` |
| Credentials | `~/.config/herald-os/freebox.json` (url, app_id, app_token, session_token — ne jamais committer) |
| MCP | harness `freebox` du serveur `cli-anything` (`harness_run`) |

## Établir la connexion (première fois / après reset)

```bash
# 1. Demande d'autorisation — la box affiche une demande sur son écran
cli-anything-freebox auth

# 2. Valider PHYSIQUEMENT sur la façade de la Freebox (flèche droite ->)
#    puis suivre l'état de la demande :
cli-anything-freebox track <id>

# 3. Ouvrir la session une fois l'autorisation accordée
cli-anything-freebox login
```

- Cible par défaut : `http://mafreebox.freebox.fr` (surcharge : `--url` ou `FREEBOX_HOST`)
- La session est persistée dans `freebox.json` et **renouvelée automatiquement** — `login` n'est à refaire que si le token est révoqué ou la box réinitialisée
- Fichier alternatif : `--config PATH`
- Fermer proprement : `cli-anything-freebox logout`

## Commandes de contrôle

```bash
cli-anything-freebox status                  # modèle, firmware, WAN, débit
cli-anything-freebox conn                    # état complet de la connexion
cli-anything-freebox hosts [--reachable|--down]   # hôtes du LAN (nom, MAC, IP)
cli-anything-freebox rename <hôte> <nom>     # renommer un hôte
cli-anything-freebox wifi                    # config Wi-Fi, APs, stations
cli-anything-freebox audit                   # audit sécurité (ipv6 fw, remote, guest, UPnP…)
cli-anything-freebox incoming                # ports exposés par la box

cli-anything-freebox redir list                              # redirections de port
cli-anything-freebox redir add <wan> <ip_lan> <port> [--proto tcp|udp]
cli-anything-freebox redir del <id>

cli-anything-freebox filters                 # filtres MAC Wi-Fi
cli-anything-freebox block <mac>             # blacklist Wi-Fi
cli-anything-freebox unblock <mac>

cli-anything-freebox set <pingwan|ipv6fw|guest|remote|adblock|wol> <on|off>
cli-anything-freebox watch once|start|stop|status|log   # watchdog (Linux/systemd)
```

## Usage agent / scripting

- **`--json`** sur toute commande → sortie machine ; erreurs `{"error","code"}` + exit non-nul
- Sans argument → **REPL stateful** (session API gardée chaude entre commandes)
- Via MCP : `cli-anything → harness_run("freebox", ["status"], json_output=true)`

## Pièges

- `auth` exige une **validation physique** sur la façade — impossible à distance
- Le `session_token` dans `freebox.json` est un secret : jamais dans git, logs ou captures
- `watch` ne fonctionne que sur Linux/systemd (prévu pour le laptop Herald OS)
