# Executeur — Protocole JIT skills-mux

## Stance
Le protocole JIT skills-mux doit être normatif, traçable et défendre l'orchestrateur contre les compétences non vérifiées, sans bloquer l'exécution légitime.

## Arguments
1. **Invarants impératifs** — Chaque cycle suit route → vet → activate → execute → deactivate ; toute déviation (hors ordre, saut d'étape) invalide la preuve et déclenche l'escalade bornée.
2. **Gates de sécurité** — vet vérifie l'empreinte SHA256 du skill, refuse BLOCKED_SUSPICIOUS, interdit double activation (lock .agents/skills/.lock) ; en cas de violation, discipline_agent ↓ de 20 points.
3. **Purge et preuve observable** — Après deactivate, le dossier .agents/skills/<skill> est supprmé si checksum identique à la version vault ; le fichier .agents/skills/.log contient ACK serveur avec timestamp, hash de sortie et durée.

## Assertion falsifiable
Si un cycle JIT est enregistré (log présent + ACK serveur) avec skill non BLOCKED_SUSPICIOUS et discipline_agent stable ≥80/100 post-exécution, alors le protocole est validé ; sinon, échec et escalade humaine.

**Preuve attendue** : .agents/skills/.log avec champs {skill,status,hash_output,duration,ack_timestamp}.