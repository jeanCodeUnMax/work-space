# Hephaistos Engine — Dossier de conception

> Étude + spec d'un moteur de recherche/indexation **autonome et détenu**,
> destiné à remplacer la dépendance à `Everything.exe` (voidtools) et,
> à terme, à unifier le stockage fichier / vectoriel / graphe du
> Hephaistos-Kit dans un seul processus Rust.

**Statut :** cible arrêtée (scénario C, 2026-10-12) — PRD rédigé, prêt pour
l'implémentation. Aucun code encore produit.
**Date :** 2026-10-12.

---

## Documents

| # | Document | Contenu |
|---|---|---|
| 01 | [SPEC-MOTEUR](01-SPEC-MOTEUR.md) | Spec design du moteur : démon élevé, parseur `$MFT`, index RAM orienté colonnes, deltas USN, named pipe, protocole requêtes, phases de livraison |
| 02 | [PORTABILITE-RUST](02-PORTABILITE-RUST.md) | Étude de portage complet en Rust : ce qui bascule (moteur, serveur MCP, fs_tools, policy), ce qui reste (extension JS), élimination de la dépendance Python |
| 03 | [FAISABILITE-UNIFICATION](03-FAISABILITE-UNIFICATION.md) | Intégration au système d'indexation Hephaistos-Kit + étude du remplacement partiel/total de Zvec, Qdrant et SQLite par un store intégré — **décision arrêtée §0** |
| 04 | [PRD](04-PRD.md) | Product Requirements Document : architecture figée, phases P0→P6 étape par étape, critères d'acceptation, matrice de délégation Orchestrateur MCP |

---

## Synthèse exécutive

**Question** : peut-on atteindre la vélocité d'Everything.exe (~50-150 ms sur
15,8 M d'entrées) dans un moteur 100 % maison ? **Oui.** La vitesse d'Everything
vient de techniques NTFS publiques et reproductibles : lecture séquentielle du
`$MFT`, index résident en RAM en colonnes contiguës, scan substring à bande
passante mémoire (SIMD), deltas du journal USN appliqués en continu. Ce n'est
ni du code ni des secrets protégés — c'est de l'ingénierie OS documentée.

**Ce qui est structurel et non négociable** : un composant **élevé** (service
Windows ou tâche planifiée HIGHEST) pour lire `\\.\X:` et le journal USN. On ne
supprime pas l'élévation, on la porte nous-mêmes — c'est le prix de
l'autonomie, et c'est exactement le modèle à deux processus qu'Everything
utilise (service + clients).

**Ce que l'autonomie débloque** : une base d'index *à nous* — extensible
(colonnes custom, watch temps réel, contenu BM25, vecteurs, graphe), un VSIX
sans dépendance externe, et la possibilité de fondre une partie de
l'architecture mémoire unifiée (Qdrant + Zvec + SQLite) dans le même processus.

**Verdict global** :

| Projet | Faisabilité | Complexité | Valeur |
|---|---|---|---|
| Moteur fichier (remplacer Everything) | ✅ Élevée | Moyenne-élevée (~4-7 k lignes Rust) | Forte — supprime la dépendance, vélocité égale ou supérieure |
| Portage Rust complet (serveur MCP inclus) | ✅ Élevée | Moyenne | Forte — binaire unique, plus de `spawn python ENOENT` |
| Index de contenu + vecteurs intégrés | ✅ Élevée | Élevée | Forte — recherche hybride native (nom + contenu + sémantique) |
| Remplacer Qdrant + Zvec par store embarqué | ✅ Élevée | Moyenne | Moyenne-forte — même vélocité, zéro serveur, fusion native |
| Remplacer les SQLite (KG, cache) | ⚠️ Partielle | Moyenne | Faible-moyenne — SQLite n'est pas le goulot ; conserver sauf unification |

**Décision arrêtée (2026-10-12)** : scénario **C** — moteur fichier + contenu
BM25 (tantivy) + vecteurs embarqués (**usearch**) + **MCP unifié `hphe-mcp.exe`**
(fs + everything + memory + semantic). Supprimé du runtime : `Everything.exe`,
`Qdrant :6333`, `Zvec :8001`, serveur `agentmemory`, `sqlite-node` (stores
mémoire), Python/`server.py`. Conservé : fichiers `.db` SQLite (servis via
`rusqlite` bundled), Orchestrateur MCP, embeddings NVIDIA NIM. Séquence :
P0→P6, chaque phase livrable et réversible — détail dans [04-PRD](04-PRD.md).

---

## Prérequis lus avant cette étude

- `everything_ipc.py` — protocole QUERY2/WM_COPYDATA actuel
- `fs_tools.py`, `server.py`, `categories.py` — surface d'outils MCP
- `_obsolete/ntfs_index.py`, `query_parser.py`, `build_index.py` — ancienne
  architecture maison (référence : ce qui a marché et pourquoi on a migré)
- `.agent/memory/*.md` — architecture mémoire unifiée (SQLite, Qdrant, Zvec)
- `.agent/rag/*` — pipeline RAG (chunker, tagger, router, embedder, fusion)
- `docs/wiki/Architecture.md`, `Benchmarks.md` — raisons de la migration IPC
