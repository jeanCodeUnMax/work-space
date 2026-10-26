# hphe:skill Command

Exécute une skill normalisée Hephaistos via le plugin.

## Usage

```bash
node <plugin>/bin/hphe.js skill <nom> '<jsonArgs>'
```

Skills disponibles : `jointes`, `binome`, `flux`, `bleubite-dispatch` (voir skills-to-plugin-commands.json pour les schémas d'entrée/sortie). La commande route vers `execute_skill_<nom>`.
