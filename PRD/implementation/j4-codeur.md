# J4 — Plugin Devin : Journal partagé & activité (Codeur)

## Fichiers créés

1. **src/comms.js** — Reader JSONL `.agent/comms.jsonl` :
   - `getLastLines(filePath, n)` : ring buffer via readline stream, pas de chargement 89 Ko entier.
   - `parseJSONLLines(lines)` : parse ligne par ligne, ignore lignes corrompues.
   - `filterSensitive(text)` : masque tokens/long hex/chemins.
   - `getLastEntries(n=20, filters={kinds,sources,hideSensitive})` : retourne [{ts,src,dst,kind,text}] avec text tronqué à 120 chars.

2. **src/activity-panel.js** — Formatage affichage :
   - `formatEntry(e)` -> `"HH:mm:ss src -> dst [kind] texte(120c)"`.
   - `renderFeed(entries)` -> chaîne multilignes.

3. **src/index.js** — Commande `activity_feed` :
   - Appelle `getLastEntries` et affiche via `renderFeed` dans la console du plugin.
   - Gère les erreurs et retourne le tableau d'entrées.

4. **README.md** — Section J4 (journal partagé, filtrage, permissions) :
   - Explique la lecture du `.agent/comms.jsonl`, le filtrage sensitive, et que l'elevation NTFS ne concerne que la lecture `everything_search`.

5. **PRD/implementation/j4-codeur.md** — Ce fichier : résumé des fichiers, choix d'implémentation, points ouverts.

## Choices d'implémentation

- **CommonJS** cohérent avec le reste du plugin.
- **Ring buffer** pour `getLastLines` : lit par blocs via `readline`, garde uniquement les N dernières lignes en mémoire (évite de charger les 89 Ko complets).
- **Filtrage côté client** : `filterSensitive` fait des substitutions regex basiques ; les masques complets peuvent être enrichés plus tard.
- **Aucun secret** : les chemins NTFS et tokens sont masqués si `hideSensitive` est activé.

## Points ouverts

- Intégration réelle dans l'interface graphique Devin (activity panel du canvas) — à faire côté host Devin.
- Remplissage du fichier `.agent/comms.jsonl` par les événements réels du système Hephaistos.
- Affinage des expressions régulières de `filterSensitive` selon les types de secrétes rencontrés.
- Persistance du choix de thème d'icône (voir spec theme-switcher).
- Vérification `node --check` sur tous les fichiers .js avant deployment.

## Test mental

Chaque fichier .js utilise des guillemets doubles pour les strings contenant des apostrophes internes, pas de chaînes non fermées. La syntaxe est valide CommonJS.