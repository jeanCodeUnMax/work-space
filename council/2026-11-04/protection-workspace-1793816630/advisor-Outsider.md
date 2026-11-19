# Advisor: Outsider

**Stance** : Un workspace doit être protégé par un système de contrôle d’accès, de sauvegarde incrémentale et de chiffrement de bout en bout, tout en conservant la flexibilité d’une tour de contrôle.

1. **Permissions granulaires** – Chaque agent reçoit un rôle spécifique (lecture, écriture, exécution) avec des scopes définis; les modifications sensibles nécessitent une double authentification.
2. **Snapshots versionnés** – Un moteur de snapshot (ex. Btrfs, ZFS) crée un point de restauration à chaque commit; les agents peuvent revenir à un état antérieur sans impacter d’autres agents.
3. **Chiffrement de données** – Les fichiers sensibles sont chiffrés au repos (AES‑256) et l’accès est géré par un gestionnaire de clés centralisé, empêchant toute écriture non autorisée.

**Assertion falsifiable** : Si un agent obtient un rôle d’écriture sans double authentification, il pourra écraser les fichiers critiques, prouvant que la protection est insuffisante.
