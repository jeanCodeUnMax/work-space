# Hephaistos Devin Plugin

## Installation

1. Exécute `.\install.ps1` (PowerShell) en tant qu'utilisateur standard.
2. Le script vérifie l'accessibilité de `hphe-mcp.exe` (variable `HPHE_MCP_PATH` ou fallback `hphe/target/release`).
3. Il copie le plugin dans le dossier cible (`%USERPROFILE%\.hephaistos-devin` par défaut).
4. Test `node --check` sur tous les `.js` du dossier `src`.
5. Demande le consentement élévation NTFS (lecture seule index $MFT).
6. Le plugin est prêt à l'emploi.

## Utilisation

- Commandes `execute_skill_*` dispatchent vers les skills Hephaistos.
- `activity_feed` affiche le journal partagé `.agent/comms.jsonl`.
- Les commandes `mcp_<outil>` proxyent vers `hphe-mcp.exe` via JSON-RPC stdio.

## Packaging / Installation complète

Voir `install.ps1` pour les détails de déploiement, vérification des dépendances et consentement NTFS. Le manifeste `manifest.json` declare 65 outils MCP, les compétences et les commandes d'activité.

## Permissions

- `ntfsElevation` requis uniquement pour la lecture de l'index NTFS `$MFT` via le MCP ; aucun écriture directe n'est effectuée.
- `consentRequired` est `true` lors de l'installation.

---

*Generated 2026-10-25*