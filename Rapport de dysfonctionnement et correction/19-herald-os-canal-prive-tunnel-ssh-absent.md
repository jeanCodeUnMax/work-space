# 19 — Herald OS : canal prive KO (tunnel SSH -D 1080 absent cote PC)

## Symptome

- Pages de navigation privee du PC sans egress : l'extension CerberCanal pointe
  `socks5://127.0.0.1:1080`, mais rien n'ecoutait sur ce port.

## Etat constate

### Cote PC (192.168.1.2)

- `netstat :1080` → aucun listener ; seuls ssh.exe actifs = forward VNC
  `-L 5900` (hermes@) et le bridge ACP `hermes acp`.
- Le `ssh -N -D 127.0.0.1:1080 vpnproxy@192.168.1.9` (CerberCanal-Tunnel.cmd)
  n'etait pas lance — process ad-hoc, mort au reboot/fermeture.

### Cote laptop herald-slave (192.168.1.9) — sain

- `deliriuumctl status` → `up:true`, rx ~1 Go ; interface `deliriuum0` unique.
- Table `inet cerber_canal` : `skuid vpnproxy reject icmpv6` + `skuid vpnproxy
  mark 0x63` — regle reject restreinte a l'IPv6 en pratique (verdict icmpv6
  inapplicable en v4 → continue vers le mark).
- `ip rule` : `fwmark 0x63 lookup 100` (prio 100) + `prohibit` (prio 101),
  idem en v6.
- Table 100 : `default dev deliriuum0` + `local 127.0.0.0/8` + LAN
  `192.168.1.0/24` — version canal, pas de collision split ce jour.
- Test egress : `sudo -u vpnproxy curl -4 ifconfig.me` → `93.95.226.72`
  (IP Deliriuum) — la partie laptop de la chaine fonctionnait deja.

## Action

- Relance `CerberCanal-Tunnel.cmd` (start /min, reconnexion auto integree)
  → `127.0.0.1:1080` LISTENING (pid 23628).

## Verification end-to-end

- `curl --socks5-hostname 127.0.0.1:1080 ifconfig.me` → **93.95.226.72**
  (sortie VPN Deliriuum).
- `curl ifconfig.me` direct → IPv6 Freebox — trafic normal inchange.
- `who` laptop → session `vpnproxy` etablie depuis 192.168.1.2.

## Cause racine

Fragilite connue (rapport 18, « Reste ouvert ») : les forwards PC (`-D 1080`,
`-L 5900`) sont des process ad-hoc non supervises — le canal meurt a chaque
reboot sans relance automatique. Le laptop, lui, etait operationnel.

## Persistance mise en place (2026-10-27, v2 — integree au tray)

Premiere version (tache planifiee + VBS + helpers) **supprimee** a la demande
de l'utilisateur : la gestion des tunnels est centralisee dans le menu tray.

Integration dans `F:\Promgramation-teste\Herald-OS\Herald-Tray.ps1` (lance au
logon via `Herald-Slave-Remote.lnk` du dossier Startup) :

- `Start-Canal` / `Stop-Canal` / `Test-Canal` : `ssh -N -D 127.0.0.1:1080
  vpnproxy@192.168.1.9` hidden, ExitOnForwardFailure + keepalive 30 s.
- Item de menu **« Canal prive VPN (SOCKS5 :1080) »** : toggle ouvrir/fermer,
  coche quand actif (`$menu.Add_Opening`).
- Auto-start au lancement du tray + watchdog `Timer` 45 s qui re-ouvre le canal
  tant que `$script:CanalWanted` (desactive par le menu ou 'Fermer les tunnels').
- `Close-Tunnels` etendu au canal — et corrige : il utilise desormais
  `Get-CimInstance Win32_Process` (sur PowerShell 5.1, `Get-Process` n'expose
  pas `CommandLine` : l'ancien filtre ne tuait rien).
- `Get-Status` ('Tester les connexions') affiche l'etat du canal.

Supprimes : tache `CerberCanal-Tunnel`, `CerberCanal-Tunnel-Hidden.vbs`,
`restart-canal-task.ps1`, `check-canal-procs.ps1`. Conserve :
`CerberCanal-Tunnel.cmd` (fallback manuel documente dans cerber-canal/README).

Verifie : tray relance → ssh -D enfant du process tray → 127.0.0.1:1080
LISTENING → `curl --socks5-hostname ... ifconfig.me` → 93.95.226.72.
Parse AST : 0 erreur.

## Reste ouvert
- Bug latent inchange : `cerber-vpn split_setup` re-ecrit la default de la
  table 100 (`via 192.168.1.254 dev enp3s0`) a chaque flap tunnel → canal 0x63
  droppe par le kill-switch. Correctif possible : table dediee (ex. 101) pour
  le split 0x44, ou canal-setup rappele par `_watch`.
- Extension navigateur : verifier que « Autoriser en navigation privee » reste
  actif (sans ca l'extension ne voit pas les fenetres privees).
