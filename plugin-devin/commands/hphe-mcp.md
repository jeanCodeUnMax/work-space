# hphe:mcp Command

Appelle un outil hphe-mcp.exe arbitraire via le proxy JSON-RPC (stdio, processus unique réutilisé).

## Usage

```bash
node <plugin>/bin/hphe.js mcp <outil> '<jsonArgs>'
```

66 outils exposés (voir manifest.json). Les 12 outils en écriture exigent `__confirmed:true` après consentement utilisateur. Liste complète : `node <plugin>/bin/hphe.js commands`.
