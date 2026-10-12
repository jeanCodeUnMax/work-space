# Query Syntax

L'argument `query` de `everything_search` / `everything_count` utilise la
**syntaxe de requête Everything** — `hphe-indexd` la réimplémente en Rust
(`hphe-query`), le comportement observable est identique à v1.

## Opérateurs et modificateurs

| Syntaxe | Signification |
|---|---|
| `*` `?` | jokers (`*` = séquence, `?` = un caractère) |
| `a|b` | OU |
| `!term` | NON |
| espace | ET implicite |
| `ext:py;txt` | liste d'extensions (séparées par `;`) |
| `size:>10mb` | taille (`<` `>`, unités kb/mb/gb) |
| `dm:today` | date de modif (`yesterday`, `thisweek`, `2024`, `>2024-01-01`…) ; `dc:`/`da:` pour création/accès |
| `path:X:\dir` | chemin contient |
| `parent:X:\dir` | répertoire parent direct |
| `regex:...` | le reste est une expression régulière |
| `case:foo` | terme sensible à la casse |
| `ww:foo` | mot entier |
| `startwith:` `endwith:` | préfixe / suffixe du nom |
| `folder:` | répertoires seulement |
| `file:` | fichiers seulement |
| `audio:` `video:` `document:` `executable:` `picture:` `compressed:` | catégories intégrées (`extension/server/categories.py`) |

Exemples :

```
dots folder:                      # dossiers nommés *dots*
*.log dm:today size:>1mb          # gros logs du jour
ext:py|ext:ps1 path:/servers/     # python ou powershell sous /servers
!node_modules *.json              # json hors node_modules
regex:^report-\d{4}\.xlsx$        # match regex
report document:                  # docs nommés *report*
```

## `matchpath:`

`matchpath:` / `matchpath` seul = flag "matcher le chemin complet au lieu du
nom seul" (global à la requête, pas par terme). Pour du path-scoped précis,
préférer `path:` / `parent:`.

## Casse / encodage

Le pipe NDJSON est UTF-8 bout-en-bout : noms accentués, CJK, emoji OK.
Matching insensible à la casse par défaut ; `case:` inverse.

## Tri et pagination

Tri côté démon (`sort` = `name` `path` `ext` `date` `size`, +`descending`).
`offset` + `max_results` paginent ; `total` = compte complet, boucler
`offset += max_results` jusqu'à `total` (plafond : 10 000 lignes/appel).
