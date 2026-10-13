# Adaptateur Recherche Vectorielle — Hephaistos2-Kit

> Wrapper pour la recherche vectorielle via Qdrant (2048D NIM) et Zvec (384D local).

---

## Routage automatique — Quel store utiliser ?

| Critères | Store recommandé | Outil MCP |
|-----------|------------------|-----------|
| Recherche par **tags catégoriques** (type, domain, scope, priority) | Qdrant | `mcp_qdrant_search` |
| Recherche par **similarité sémantique** (concept, action, entity, relation) | Zvec | `mcp_zvec_semantic_search` |
| Recherche **mixte** (catégorique + sémantique) | Dual (Qdrant + Zvec) | Les deux, fusionner les résultats |

---

## Embeddings doubles — deux index complémentaires

Les deux stores utilisent des modèles différents, par conception :

| Store | Modèle | Dimensions | Rôle |
|-------|--------|------------|------|
| Qdrant | `nvidia/nemotron-3-embed-1b` (NIM) | 2048 | Index large / catégorique |
| Zvec | `Xenova/all-MiniLM-L6-v2` (local) | 384 | Index fin / sémantique locale |

- Clés côté environnement : `NVIDIA_API_KEY` (embeddings NIM 2048D) et `QDRANT_API_KEY` (accès au serveur Qdrant) — jamais `OPENAI_API_KEY`, jamais de secret dans le code ni les `.env` distribués.
- Zvec n'a besoin d'aucune clé : embedding local côté serveur (`ZVEC_EMBEDDING_PROVIDER=local`).

**Un vecteur 2048D ne va PAS dans Zvec, et un vecteur 384D ne va PAS dans Qdrant** — générer le vecteur dans la dimension du store ciblé.

---

## Qdrant (Vector Store 2048D)

### Collections disponibles

| Collection | Dimension | Contenu |
|------------|-----------|---------|
| `doc_index` | 2048 | Documentation technique |
| `code_index` | 2048 | Morceaux de code source |
| `config_index` | 2048 | Fichiers de configuration |
| `skill_index` | 2048 | Compétences |
| `workflow_index` | 2048 | Workflows (slash commands) |
| `code_hephaistos_kit` | 2048 | Code Hephaistos2-Kit |
| `ide_*` | 2048 | Index IDE-spécifiques |
| `<projet>_algos` | 2048 | Algorithmes du projet |
| `<projet>_runs` | 2048 | Exécutions du projet |
| `<projet>_timesfm` | 2048 | Prédictions TimesFM du projet |

> Les collections `*_index` et `ide_*` sont hybrides (dense + sparse). Les `<projet>_*` sont dense-seul.

### Recherche catégorique

```
Équivalent MCP: mcp_qdrant_search

Usage: Recherche dans une collection Qdrant par vecteur pré-calculé.
```

**Procédure :**
1. Générer le vecteur de recherche via NIM (`input_type: "query"`)
2. Identifier la collection cible (ex: `doc_index` pour la documentation)
3. Optionnellement, spécifier des filtres catégoriques (tags: type, domain, scope)
4. Appeler `mcp_qdrant_search(collection="nom_collection", vector=vecteur, filter={...}, limit=20)`

**Exemple :**
```
# Rechercher de la documentation sur l'authentification JWT
vecteur = embed_nim("authentification JWT spring security configuration", input_type="query")
mcp_qdrant_search(
    collection="doc_index",
    vector=vecteur,   # nommé "dense" pour collections hybrides
    filter={"type": "security", "domain": "backend"},
    limit=10
)
→ Retourne: 10 documents les plus pertinents avec scores
```

---

## Zvec (Vector Store 384D local)

### Collections disponibles

| Collection | Dimension | Contenu |
|------------|-----------|---------|
| `entities_index` | 384 | Entités du KG (noms, descriptions) |
| `concepts_index` | 384 | Concepts abstraits (tags sémantiques) |
| `actions_index` | 384 | Actions/verbes (tags sémantiques) |
| `relations_index` | 384 | Relations entre entités |
| `context_index` | 384 | Contexte sémantique |
| `learning_insights` | 384 | Insights d'apprentissage |

> Les collections sont créées à la première insertion par le serveur Zvec (embedding local `Xenova/all-MiniLM-L6-v2`, `ZVEC_EMBEDDING_PROVIDER=local` — pas de NIM, pas de clé API).

### Recherche sémantique

```
Équivalent MCP: mcp_zvec_semantic_search

Usage: Recherche sémantique dans une collection Zvec par texte brut.
```

**Procédure :**
1. Identifier la collection cible (ex: `entities_index` pour les entités)
2. Appeler `mcp_zvec_semantic_search(collection="nom_collection", query="texte de la requête", limit=20)`
   — le paramètre est `query` (texte), PAS `query_vector` : le serveur embarque l'embedding 384D en interne.
3. `mcp_zvec_hybrid_search` existe aussi (mêmes paramètres) pour dense+sparse.

---

## Procédure EMBED-FIRST (Qdrant uniquement)

```
Avant tout appel Qdrant, générer le vecteur de requête (2048D NIM).
Zvec prend le texte brut — pas d'étape d'embedding pour Zvec.
```

### Génération de vecteur (Qdrant seulement)

```
POST https://integrate.api.nvidia.com/v1/embeddings
Headers: Authorization: Bearer <NVIDIA_API_KEY>
Body: {
  "model": "nvidia/nemotron-3-embed-1b",
  "input": "texte à encoder",
  "input_type": "query"    # "passage" pour indexer, "query" pour chercher
}

→ Retourne: {"data": [{"embedding": [float32 x 2048]}]}
```

---

## Fusion des résultats (routage dual)

```
Lorsque la recherche nécessite à la fois des critères catégoriques et sémantiques,
utiliser le routage dual : Qdrant + Zvec, puis fusionner les résultats.
```

**Procédure :**
1. Générer le vecteur NIM 2048D pour Qdrant ; pour Zvec, garder le texte brut (embedding 384D côté serveur)
2. Exécuter `mcp_qdrant_search` (vector) et `mcp_zvec_semantic_search` (query) en parallèle
3. Normaliser les scores (0-1)
4. Appliquer les poids de fusion :
   - Qdrant: 0.4 (catégorique)
   - Zvec: 0.4 (sémantique)
   - Memory: 0.2 (KG complémentaire, optionnel)
5. Trier les résultats fusionnés par score décroissant
6. Limiter à `RAG_FUSION_MAX_RESULTS=20`

---

## Bonnes pratiques

1. **EMBED-FIRST = Qdrant seulement** — `qdrant.search` exige `vector` (2048D NIM). `zvec.semantic_search`/`zvec.hybrid_search` prennent `query` (texte brut).
2. **Choisir le bon store** — Catégorique → Qdrant, Sémantique → Zvec, Mixte → Dual.
3. **Spécifier des filtres lorsque c'est possible** — Les filtres catégoriques améliorent la précision de la recherche Qdrant.
4. **Limiter les résultats** — `limit=20` maximum (RAG_FUSION_MAX_RESULTS). Plus de résultats = plus de tokens.
5. **Vérifier les scores minimum** — `min_score=0.5` pour filtrer les résultats non pertinents.
6. **Documenter les requêtes fréquentes** — Si une requête est récurrente, créer une entité "frequent-query-{slug}" dans le KG pour retrouver le contexte sans re-embedding.

---

## Dépannage

### Problème: Aucun résultat

1. Pour Qdrant : vérifier que le vecteur est correctement généré (2048 dims, NIM). Pour Zvec : passer le texte brut, vérifier que le serveur tourne (`ZVEC_DATA_DIR` accessible).
2. Vérifier que la collection existe et contient des données
3. Baisser le `min_score` (ex: 0.3) pour obtenir plus de résultats
4. Essayer une requête plus large (moins de filtres, mots-clés plus généraux)

### Problème: Résultats non pertinents

1. Affiner les filtres catégoriques (plus de tags, plus spécifiques)
2. Réduire le `limit` pour se concentrer sur les meilleurs résultats
3. Essayer le routage dual pour combiner catégorique + sémantique

### Problème: Embedding NIM indisponible

1. Vérifier `NVIDIA_API_KEY` dans l'environnement (User scope) ou dans l'env du serveur MCP
2. Tester `GET https://integrate.api.nvidia.com/v1/models` avec la clé
3. Fallback : sqlite-node `memory` (KG) ou recherche texte directe
