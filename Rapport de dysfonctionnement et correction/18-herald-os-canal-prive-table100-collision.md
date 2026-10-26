# 18 — Herald OS : canal prive KO apres reboot (collision table 100 canal/split) + watchdog freebox en boucle SIGABRT

## Symptomes (rapportes)

- Pipeline de privatisation muet : fenetres privees du navigateur PC sans egress via le tunnel VPN.
- Agent Hermes dans la session TigerVNC sans reponse.
- Impression generale de laptop « gele ».

## Etat reel constate (SSH)

- Machine saine : SSH OK en 5 s, load 0.4, mem 1.9/3.9 G, uptime 1j11h. Pas de gel.
- Tunnel `deliriuum0` UP (`deliriuumctl status` → `ok:true, up:true`, 1 Go rx).
- `wayvnc` x2 actifs (127.0.0.1:5900 + Virtual-1:5902), niri + app Herald OS tournaient.
- `freebox-watchdog.service` : `WatchdogSec=900`, `TimeoutStopFailureMode=abort` → **SIGABRT python3.14+journalctl toutes les ~15 min** (coredumpctl : rafale reguliere 02:42→03:43). Le service restarte mais flap en permanence.
- Aucun process `vpnproxy` au repos : normal — l'egress passe par `sshd` quand le `ssh -D` du PC est connecte.

## Cause racine du canal prive

`cerber-canal-setup.sh` (mark **0x63**) et `cerber-vpn` `split_setup` (mark **0x44**) **partagent la table 100** :

- Au boot, canal tourne avant que `deliriuum0` existe → pas de default ecrite.
- Quand le tunnel monte, `cerber-vpn _watch` relance `split_setup` → `ip route replace default via 192.168.1.254 dev enp3s0 table 100`.
- Resultat : trafic marque 0x63 (vpnproxy) resout sa default sur l'interface physique → kill-switch `deliriuum_direct` le droppe → **fentre privee = zero connectivite**.

Verification du symptome avant fix : `ip route show table 100` → `default via 192.168.1.254 dev enp3s0` (au lieu de `dev deliriuum0`).

## Actions

1. `systemctl reboot` (demande utilisateur) — retour en ~85 s, `deliriuum-autoup` a rejoue, un seul `deliriuum0` (purge ExecStartPre efficace, cf. rapport 17).
2. Re-execution `sudo /var/usrlocal/bin/cerber-canal-setup.sh` tunnel deja up → table 100 : `default dev deliriuum0`.
3. Re-ouverture cote PC des tunnels morts au reboot :
   - `ssh -f -N -D 1080 vpnproxy@192.168.1.9` (canal SOCKS5)
   - `ssh -f -N -L 5900:127.0.0.1:5900 hermes@192.168.1.9` (forward VNC)

## Verification

- `curl --socks5-hostname 127.0.0.1:1080 ifconfig.me` → **93.95.226.72** (sortie Deliriuum ; WAN Freebox = 82.64.168.91). Canal prive restaure end-to-end.
- Services user tous `active running` (hermes-gateway, cash-bridge, ollama, n8n, watchdog, clipboard, idle).
- `herald-os --help` / `commands --json` repondent en ~1.3 s → shell/app reactif (agent Hermes VNC degelé par le reboot).

## Reste ouvert / fragilites

- **Bug latent** : `split_setup` peut re-ecraser la default de la table 100 a chaque flap du tunnel → canal prive KO a nouveau. Correctifs possibles : table dediee pour le split (ex. 101), ou `cerber-vpn _watch` appelle canal-setup apres split, ou tableaux separes par mark dans `ip rule`.
- **freebox-watchdog** flap toujours (WatchdogSec=900 non honore → SIGABRT ~toutes les 15 min) : investiguer le poll Freebox bloquant (probable timeout absent sur la requete `fbx`) ou baisser WatchdogSec / ajouter sd_notify.
- Les forwards PC (`-D 1080`, `-L 5900`) restent des process ad-hoc : morts a chaque reboot laptop. Un service Windows `ssh -D`/`-L` avec autoreconnect (ou la tache planifiee) fiabiliserait la chaine.
