SECU-ANALYSE:
### 1. Gestion des secrets API (NVIDIA_API_KEY, etc.)
**Risk :** Stockage de clés API en clair dans des fichiers `.env` ou de configuration inclus dans le package du plugin ou versionnés. Exposition des identifiants NVIDIA si le package est compromis, partagé ou poussé sur un dépôt public.
**Mitigation :** Interdire le committed des `.env` réels. Injecter les secrets uniquement au runtime via des variables d'environnement sécurisées ou un système externe de gestion de secrets (HashiCorp Vault, AWS Secrets Manager, etc.). Chiffrer tout fichier de configuration contenant des clés et exiger une clé de déchiffrement externe au démarrage. Appliquer le principe du moindre privilège d'accès aux secrets.

### 2. Confinement filesystem des skills
**Risk :** Accès non restreint du plugin aux répertoires système si les compétences (skills) ne sont pas isolées, entraînant élévation de privilèges, modification de fichiers critiques ou exfiltration de données.
**Mitigation :** Sandboxer chaque skill dans un répertoire dédié en lecture seule, avec écriture restreinte à un espace temporaire isolé. Utiliser des namespaces Linux (seccomp, AppArmor, capabilities réduites) ou des conteneurs légers (docker with `--read-only`, `--tmpfs`) pour isoler l'exécution. Valider et signer les scripts de skills avant exécution, et refuser tout code non signé ou hors liste blanche.

### 3. Surface réseau locale (ports 7477 / 19825)
**Risk :** Écoute sur les ports 7477 (probablement Neo4j/Bolt) et 19825 (service interne Hephaistos/MCP) expose des vecteurs d'attaque réseau locaux. Si liés à `0.0.0.0`, une connexion locale compromise peut mener à un accès distant ou à une exécution de commandes à distance.
**Mitigation :** Lier ces services exclusivement à `127.0.0.1` ou à des interfaces de confiance locales uniquement. Configurer un pare-feu local (ufw, nftables) pour bloquer l'accès entrant externe. N'ouvrir ces ports que sur des réseaux de confiance. Pour toute communication distante nécessaire, passer par un tunnel SSH ou VPN. Auditer régulièrement les bindings réseau et les règles de firewall.

### 4. Distribution du plugin (binaire hphe-mcp.exe : embarqué ou téléchargé ?)
**Risk :** Si `hphe-mcp.exe` télécharge des composants à l'exécution depuis des sources non validées, cela introduit un risque de supply-chain attack. Si le binaire embarque tout, la taille du package augmente et les mises à jour de sécurité deviennent lourdes et lentes.
**Mitigation :** Adopter une distribution "binaire signé + modules à la demande" avec vérification de signature cryptographique (ex: GPG/SHA-256) à chaque chargement. Si téléchargement imposé : forcer HTTPS, valider checksums SHA-256, et vérifier la signature du téléchargeur. Pour les mises à jour : mécanisme signé et incrémental, avec rollback automatique en cas d'échec de validation. Documenter clairement le mode choisi et exiger une validation de confiance à chaque installation.

### 5. Risques d'exécution de code
**Risk :** Exécution dynamique de code utilisateur ou de compétences non vérifiées peut mener à un Remote Code Execution (RCE), surtout si des entrées utilisateur sont passées directement aux shells ou interprètes.
**Mitigation :** Sandboxer l'exécution (conteneurs isolés, exécuteurs WASM, ou interpréteurs restreints). Nettoyer et valider toutes les entrées utilisateur avant traitement. Utiliser des allowlists strictes de fonctions autorisées. Journaliser toute tentative d'exécution avec contexte (source, identifiant). Envisager un exécuteur de code isolé qui ne communique que via des canaux stricts (stdin/stdout formatés, pas d'accès au filesystem global).
