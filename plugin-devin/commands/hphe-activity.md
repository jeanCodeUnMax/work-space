# hphe:activity Command

Affiche les N dernières entrées du journal partagé `.agent/comms.jsonl` (secrets masqués par défaut).

## Usage

```bash
node <plugin>/bin/hphe.js activity-feed [n]
```

Format : `HH:mm:ss src -> dst [kind] texte`. Utilisé pour superviser l'orchestrateur, les wakes et les statuts d'agents.
