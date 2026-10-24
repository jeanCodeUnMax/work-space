# 17 — Herald OS : chaine VPN Delirium non persistante au reboot + perte LAN lors du `up`

## Symptomes

- Fenetres privees du PC qui « moulinent » : trafic `vpnproxy` sans route (tunnel absent).
- Bureau Herald OS affiche son fond d'ecran — interprete comme une veille ou un crash ; en realite la session niri/hermes tournait normalement (swayidle anti-veille deja cable, sleep/suspend/hibernate deja `masked`).
- Reboots nocturnes inopines effacant l'etat operationnel.

## Causes racines

1. **`bootc-fetch-apply-updates.timer`** actif : appliquait les mises a jour bootc et rebootait la machine la nuit.
2. **`deliriuum-direct.service` et `deliriuum-lanfix.service` en `disabled`** : le daemon VPN et le watchdog LAN ne remontaient jamais apres reboot ; `cerber-canal` demarrait mais sans interface `deliriuum0` a router.
3. **Groupe `deliriuum` absent** : `chgrp` du socket daemon en echec, socket `root:root`, client `vpnproxy` incapable de dialoguer avec le daemon.
4. **Pas d'unite auto-`up`** : `deliriuumctl up` etait une operation manuelle ; aucun mecanisme ne montait le tunnel au boot.
5. **Ordre de mise en route casse** : un `deliriuumctl up` lance avant `deliriuum-lanfix` avalait la route LAN (full-capture) et coupait SSH/ping — perte d'acces distant jusqu'au reboot.

## Corrections appliquees

| Action | Resultat |
|---|---|
| `groupadd -r deliriuum` + `usermod -aG deliriuum vpnproxy` | Socket `root:deliriuum`, `chgrp` OK |
| `systemctl enable deliriuum-direct deliriuum-lanfix` | Persistance au reboot (symlinks `/etc`, preserves par bootc/ostree) |
| `systemctl disable --now bootc-fetch-apply-updates.timer` | Plus de reboot nocturne non maitrise ; MAJ manuelle via `bootc upgrade` |
| Nouvelle unite `deliriuum-autoup.service` (oneshot, `After=direct+lanfix`, `Before=cerber-canal`, retry 5x5s) | `deliriuumctl up` automatique a chaque boot |
| `restart deliriuum-direct` → `start lanfix` → `deliriuumctl up` → `restart cerber-canal` | Chaine montee dans l'ordre, SSH preserve |

## Verification

- `deliriuumctl status` → `"up":true`, compteurs rx/tx croissants sous charge `vpnproxy`.
- `deliriuum0` cree (`10.0.21.x/32`), table 100 = `default dev deliriuum0` **+ `192.168.1.0/24 dev enp3s0`** (exemption LAN).
- `ip rule` : `fwmark 0x63 lookup 100` + `prohibit` (kill-switch : si le tun tombe, trafic vpnproxy bloque, pas fuite).
- `ip route get 1.1.1.1 mark 0x63` → `dev deliriuum0` — chemin marque verifie.
- Egress `vpnproxy` + `root` : meme IP publique Delirium (la Freebox route deja par le canal).
- SSH reste vivant pendant et apres `up` — `lanfix` a rempli son role.
- `greetd` autologin `hermes` → niri + `wayvnc` (localhost:5900, tunnel SSH by design) — session graphique operationnelle.

## Regle tiree

**Ordre obligatoire** au boot et a la main : `deliriuum-direct` → `deliriuum-lanfix` → `deliriuum-autoup` (`deliriuumctl up`) → `cerber-canal`. Ne jamais lancer `deliriuumctl up` sans `deliriuum-lanfix` actif, sous peine de perdre l'acces distant.

## Reste ouvert

- Reboot-test reel non encore effectue : verifier au prochain boot que `deliriuum-autoup` monte le tunnel sans intervention et que les fenetres privees repondent end-to-end.
- Les sleep targets restent masked (etat conserve) ; si une MAJ bootc reinstalle les presets, verifier `systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target` = `masked`.

## Suite — 2026-10-24 soir : empilement d'interfaces + architecture reelle du canal prive

### Ce qui s'est passe

- Apres un nouveau reboot, tous les services ont remonte correctement (`autoup` a marche) MAIS **6+ interfaces `deliriuum0..N` se sont empilees** avec la meme IP : `deliriuumctl up` n'est pas idempotent et chaque appel cree un tun supplementaire ; `down` ne les supprime pas. Le routage marque est mort → canal prive KO malgre `up:true`.
- Erreur commise cote PC : demarrage manuel de `WireGuardTunnel$Deliriuum` (config `AllowedIPs 0.0.0.0/0` = full capture) → coupure internet du PC. Inverse : le VPN canal est **laptop-side** ; le PC n'a pas a monter de tunnel.

### Architecture reelle du canal prive (confirmee par l'utilisateur)

```
Navigateur PC + extension "Cerber Canal" (fenetre privee)
    -> SOCKS5 127.0.0.1:1080 sur le PC  (ssh -N -D 1080 vpnproxy@192.168.1.9)
    -> sshd herald -> sortie sous uid 1001 (vpnproxy)
    -> nft mark 0x63 -> table 100 -> deliriuum0 -> VPN Delirium
```

- Le forward SSH `-D` est le canal ; l'extension ne fait que pointer dessus.
- Aucun proxy ne tourne sur le LAN du laptop — tout passe par sshd.

### Corrections supplementaires

- Purge manuelle des interfaces orphelines (`ip link del deliriuumN`) + un seul `up` -> egress vpnproxy `93.95.226.72` verifie.
- `deliriuum-autoup` durci : `ExecStartPre` supprime tout `deliriuum[0-9]+` residuel avant `up`, `ExecStartPost` verifie `deliriuum0`.
- Test end-to-end PC : `curl --socks5-hostname 127.0.0.1:1080 ifconfig.me` -> IP VPN. Canal prive restaure.
- `deliriuum-direct-app.exe` (PC) arrete : hors perimetre, le canal est cote laptop.

### Fragilite restante

- Le `ssh -D` cote PC n'est pas un service : si le process meurt, relancer `ssh -N -D 1080 ... vpnproxy@192.168.1.9`.
- Si `deliriuumctl` recree des interfaces multiples un jour, la purge `ExecStartPre` d'autoup couvre le boot mais pas les `up` manuels ulterieurs.
