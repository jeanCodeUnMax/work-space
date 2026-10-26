# Plugin Devin Hephaistos2-kit: Sécurité & Permissions – PRD

## 1. Décisions de conception
- **MCP service permanent** : Service MCP en exécution continue, gérant le cycle de vie des skills et la synchronisation d'état.
- **Skills normalisées** : Toutes les skills suivent un schéma commun, versionné et signable, avec métadonnées d'autorisation explicites.
- **Synchronisation d'état** : État partagé via store interne, avec consensus atomique et propagation immédiate aux instances actives.
- **Élévation NTFS OBLIGATOIRE dans manifeste** : Tout skill demandant une écriture sur le système de fichiers doit déclarer une élévation NTFS explicite dans son manifeste, refusée par défaut si non justifiée ou mal ciblée.

## 2. Analyse de sécurité (synthèse des risques atténués)

### 1. Gestion des secrets API
- **Risk** : Stockage de clés API en clair dans des fichiers `.env` ou de configuration versionnés expose les identifiants NVIDIA en cas de compromission, partage ou publication publique.
- **Mitigation** : Interdiction stricte de commiter des `.env` réels. Injection des secrets uniquement au runtime via variables d'environnement sécurisées ou système externe de gestion de secrets (HashiCorp Vault, AWS Secrets Manager, etc.). Tout fichier de configuration contenant des clés doit être chiffré et nécessiter une clé de déchiffrement externe au démarrage. Principe du moindre privilège d'accès aux secrets appliqué.

### 2. Confinement filesystem des skills
- **Risk** : Accès non restreint du plugin aux répertoires système si les skills ne sont pas isolées, entraînant élévation de privilèges, modification de fichiers critiques ou exfiltration de données.
- **Mitigation** : Sandboxing de chaque skill dans un répertoire dédié en lecture seule, avec écriture restreinte à un espace temporaire isolé. Utilisation de namespaces Linux (seccomp, AppArmor, capabilities réduites) ou conteneurs légers (Docker avec `--read-only`, `--tmpfs`) pour isoler l'exécution. Validation et signature des scripts de skills avant exécution ; refus de tout code non signé ou hors liste blanche. Les 58 outils du plugin s'exécutent dans des bac à sable isolés ne pouvant pas accéder au filesystem global sans déclaration NTFS manifeste.

### 3. Surface réseau locale (ports 7477 / 19825)
- **Risk** : Écoute sur les ports 7477 (probablement Neo4j/Bolt) et 19825 (service interne Hephaistos/MCP) expose des vecteurs d'attaque réseau locaux. Si liés à `0.0.0.0`, une connexion locale compromise peut mener à un accès distant ou à une exécution de commandes à distance.
- **Mitigation** : Ces services lient exclusivement à `127.0.0.1` ou à des interfaces de confiance locales uniquement. Configuration d'un pare-feu local (ufw, nftables) pour bloquer l'accès entrant externe. Les ports ne s'ouvrent que sur des réseaux de confiance. Toute communication distante nécessaire passe par un tunnel SSH ou VPN. Auditing régulier des bindings réseau et règles de firewall.

### 4. Distribution du plugin (binaire hphe-mcp.exe)
- **Risk** : Téléchargement de composants à l'exécution depuis des sources non validées introduit un risque supply-chain attack. Embarquement complet alourdit le package et retarde les mises à jour de sécurité.
- **Mitigation** : Distribution "binaire signé + modules à la demande" avec vérification de signature cryptographique (GPG/SHA-256) à chaque chargement. Si téléchargement imposé : forçage HTTPS, validation checksums SHA-256, vérification de la signature du téléchargeur. Mécanisme de mise à jour signé et incrémental avec rollback automatique en cas d'échec de validation. Mode choisi documenté clairement avec exigence de validation de confiance à chaque installation.

### 5. Risques d'exécution de code
- **Risk** : Exécution dynamique de code utilisateur ou de skills non vérifiées peut mener à un Remote Code Execution (RCE), surtout si des entrées utilisateur sont passées directement aux shells ou interprètes.
- **Mitigation** : Sandboxing de l'exécution (conteneurs isolés, exécuteurs WASM, ou interpréteurs restreints). Nettoyage et validation de toutes les entrées utilisateur avant traitement. Utilisation d'allowlists strictes de fonctions autorisées. Journalisation de toute tentative d'exécution avec contexte (source, identifiant). Utilisation d'un exécuteur de code isolé ne communiquant que via des canaux stricts (stdin/stdout formatés, pas d'accès au filesystem global). Les 58 outils font l'objet d'un contrôle d'entrée validé avant exécution.

## 3. Manifeste de permissions (extraits requis)

| Domaine | Politique | Détail |
|---------|-----------|--------|
| **Système de fichiers NTFS** | Élévation obligatoire | Tout skill demandant écriture doit déclarer `ntfs_elevation: true` avec chemin ciblé et justification. Refus par défaut. Accès en lecture seule par défaut. |
| **Réseau local** | Ports 7477 / 19825 | Binding `127.0.0.1` uniquement. Pare-feu local bloquant l'entrée externe. Tunneling SSH/VPN pour accès distant. |
| **Exécution** | Conteneur isolé | Chaque skill s'exécute dans un bac à sable avec filesystem en lecture seule, tmpfs isolé, et capabilities minimales. Pas d'accès réseau sortant non déclaré. |

## 4. Sandboxing des 58 outils
- Chaque outil est mappé à un profil de sandbox dédié généré automatiquement depuis le manifeste.
- Profil type : `--read-only --tmpfs /tmp --cap-drop ALL --seccomp profile.json`.
- Outils nécessitant une élévation NTFS déclarée dans le manifeste ne peuvent s'exécuter qu'après validation de la politique d'élévation par le noyau hôte.
- Journaux d'accès filesystem et réseau traçables par outil, stockés dans un journal interne immuable.

## 5. Gestion des secrets (NVIDIA_API_KEY etc. jamais distribuées)
- Aucune clé API n'est incluse dans le binaire ni dans les fichiers de configuration versionnés.
- Au démarrage, le plugin lit `NVIDIA_API_KEY` et autres secrets dans l'environnement d'exécution externe (Kubernetes secret, Vault agent, env file non versionné).
- Si absent, le plugin démarre en mode dégradé avec avertissement explicite, jamais de valeur par défaut codée en dur.
- Rotation de clé gérée par l'infrastructure externe ; le plugin ne conserve jamais les clés en mémoire plus longtemps que le temps d'exécution en cours.

## 6. Modèle d'attaque (threat model résumé)
- **Attaque supply-chain** : Atténuée par signature cryptographique à chaque chargement, mise à jour signée et incrémentale, rollback automatique.
- **RCE via skill** : Atténuée par sandboxing conteneurisé, allowlists d'exécution, validation d'entrée, exécution sans accès filesystem global.
- **Exfiltration via réseau** : Atténuée par binding localhost-only, firewall local, pas d'ouverture de ports sur interfaces externes.
- **Élévation de privilèges NTFS** : Atténuée par déclaration manifeste obligatoire, refus par défaut, audit de chaque élévation.
- **Fuite de secrets** : Atténuée par injection runtime uniquement, pas de stockage en clair, pas de committed `.env`.

## 7. Jalons sécurité
| Jalon | Description | Cible |
|-------|-------------|-------|
| **M1** | Publication du manifeste permissions avec exigences NTFS et bindings réseau | Dès démarrage projet |
| **M2** | Intégration sandboxing des 58 outils avec profils de confinement | Sprint 2 |
| **M3** | Remplacement stockage secrets par injection runtime + vérification absence `.env` committed | Sprint 3 |
| **M4** | Déploiement réseau avec binding `127.0.0.1` + règles firewall par défaut | Sprint 4 |
| **M5** | Audit complet threat model + validation signature binaire + modules à la demande | Release candidate |
| **M6** | Version 1.0 avec l'ensemble des contrôles actifs et documentation utilisateur | Production |

---
*Ce PRD est généré à partir des décisions d'architecture et de l'analyse de sécurité fournie. Aucune donnée de fichier n'a été lue ou écrite par le worker texte ; le contenu est produit conformément aux règles de l'orchestrateur Hephaistos.*
