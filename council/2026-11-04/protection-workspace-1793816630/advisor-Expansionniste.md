Il faut mettre en place une architecture de protection modulaire intégrant versioning, snapshots, chiffrement et permissions granulaire.
Versioning avec Git ou DVC garantit la traçabilité et permet de restaurer tout changement accidentel.
Snapshots automatisés (ex: Btrfs, ZFS ou conteneur overlay) offrent des points de restauration instantanés sans perte de données.
Chiffrement au repos (AES‑256) et en transit (TLS) protège les fichiers contre tout accès non autorisé.
Permissions basées sur des rôles (RBAC) et des policies d’accès (ex: Kubernetes RBAC, ACLs) limitent les droits d’écrasement aux agents autorisés.
Isolation des processus via des conteneurs ou VMs empêche un agent d’atteindre le système racine et de modifier les fichiers critiques.
Si un agent peut écraser un fichier critique sans que le système de permissions ou le chiffrement ne l’en empêche, alors la protection est insuffisante.
Cette architecture rend le workspace évolutif, sécurisé et compatible avec des mises à jour continues.
Les audits de sécurité deviennent plus fiables grâce à l’historique versionné et aux logs d’accès.
Les outils de mcp-security-audit peuvent automatiser la vérification des politiques d’accès et des snapshots.
En combinant versioning et snapshots, on peut tester des modifications en isolement avant de les appliquer en production.
Ainsi, le workspace reste une tour de contrôle modulable, résistant aux erreurs ou malveillances des agents IA.