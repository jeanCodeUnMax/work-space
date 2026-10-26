# hphe:search Command

Recherche un fichier sur le disque via l'index NTFS Hephaistos (hphe-mcp).

## Usage

```bash
node <plugin>/bin/hphe.js mcp everything_search '{"query":"<terme>","max_results":20}'
```

<plugin> = chemin du plugin hephaistos-devin (racine du dossier contenant bin/).

Retourne les résultats JSON (path, name, size, mtime). Réservé lecture — aucun droit d'écriture requis.
