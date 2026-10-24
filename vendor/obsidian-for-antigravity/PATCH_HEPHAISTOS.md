# PATCH Hephaistos 2-kit — obsidian-for-antigravity

## Origine

- **Extension upstream** : `davissss2.obsidian-for-antigravity`, version **1.8.7**
- **Source vendored** : copie exacte de l'extension installée, **patchée**
- **Installations patchées en production** :
  - `%USERPROFILE%\.devin\extensions\davissss2.obsidian-for-antigravity-1.8.7\`
  - `%USERPROFILE%\.cursor\extensions\davissss2.obsidian-for-antigravity-1.8.7\`
  - `%USERPROFILE%\.devin\extensions\davissss2.obsidian-for-antigravity-1.8.5\`

## Pourquoi ce patch

L'extension régénérait intégralement `~/.gemini/GEMINI.md` et `~/.gemini/config/GEMINI.md`
à chaque sync/init via `fs.writeFileSync` sur son template « Hermes Core ». Elle
**écrasait le bloc PROTOCOLE HEPHAÏSTOS 2-KIT** (identités binôme Cash = Devin,
Tango = AGY, bus `comms.jsonl`, tunnel `ws://127.0.0.1:7477`) restauré manuellement —
l'identité de Tango sautait à chaque démarrage d'Antigravity.

## Ce qui a été modifié

Helper `writeMarkedMd(filePath, generated)` ajouté en tête de `src/skill-installer.js`
et `src/obsidian-runner.js`. Sémantique d'écriture bornée :

- marqueurs `<!-- obsidian-for-antigravity:start -->` / `:end -->` présents →
  remplace **uniquement** l'intérieur ;
- fichier existant sans marqueurs → préserve tout le contenu, **append** le bloc ;
- fichier vide/absent → écrit le bloc seul.

### Points d'écriture remplacés

| Fichier | Avant | Après |
|---|---|---|
| `src/skill-installer.js` (~l.1398) | `writeFileSync(GEMINI.md ×2)` écrasant | `writeMarkedMd` ×2 |
| `src/skill-installer.js` (~l.1326) | `writeFileSync(obsidian-brain.md)` | `writeMarkedMd(rulePath)` |
| `src/obsidian-runner.js` (~l.222) | `writeFileSync(geminiMdPath + ~/.gemini/GEMINI.md)` | `writeMarkedMd` ×2 |

### Non modifiés (audit justifié)

- `AGENTS.md` : `agentsMdPath` déclaré mais jamais écrit dans cette version.
- `sync-engine.js` : n'écrit que ses propres fichiers (`.agents/rules/project-rules.md`
  = miroir des antipatrons, index, metadata, notes générées) — hors périmètre identité.
- `mcp-server.js` : écrit `userFile`/`projFile` (mémoire extension) — non identitaire.

## Maintenance du sous-module

- À chaque mise à jour upstream (1.8.8+), **réappliquer ce patch** aux mêmes sites
  d'écriture ou reprendre le helper `writeMarkedMd`.
- Les marqueurs sont la convention stable : tout write de l'extension sur un fichier
  canonique Hephaistos doit passer par `writeMarkedMd`.
- Rapport détaillé de la session : `<VAULT>/99_Labo/PATCH_obsidian-for-antigravity.md`.
- Tâche orchestrateur : **#588** (completed) — dispatch #589 (worker sans artefact,
  patch refait en direct par Cash).
