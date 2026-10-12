# Portabilité Rust complète — étude de faisabilité

> Question : peut-on porter **l'ensemble** de la chaîne en Rust — pas seulement
> le moteur d'index, mais aussi le serveur MCP, les fs_tools et la policy —
> pour obtenir une distribution 100 % binaire, sans Python ?

**Réponse courte : oui, et c'est même le scénario le plus propre.** La couche
Python actuelle n'a aucune dépendance qui la retient : `server.py` est de la
NDJSON sur stdio, `fs_tools.py` du `os.*`, `everything_ipc.py` du ctypes. Tout
se porte en Rust avec des équivalents directs. Seule l'extension VS Code reste
en JS — et c'est structurel (VS Code = Node), elle n'a pas besoin de changer :
elle parle MCP sur stdio à un binaire, comme aujourd'hui à `python server.py`.

---

## 1. Cartographie de portage

| Composant actuel | LOC | Port Rust | Difficulté | Notes |
|---|---|---|---|---|
| `server.py` (boucle NDJSON JSON-RPC, registry 18 outils, `_fix_schemas`, handlers) | 562 | `hphe-mcp.exe` : stdin/stdout ligne à ligne, `serde_json`, registry statique | **Faible** | Le protocole MCP est trivial à réécrire ; pas de framework lourd requis. La crate `rmcp` (SDK officiel Rust) existe si on veut du structuré — optionnel. |
| `everything_ipc.py` (WM_COPYDATA, fenêtre cachée, QUERY2) | 384 | Client **named pipe** `hphe_pipe.rs` | **Faible** et **simplifiant** | Plus de fenêtre cachée/message loop : un pipe est un fichier. Le code devient 3× plus simple et portable. |
| `fs_tools.py` (12 outils fs + policy `.mcp-access` + `EVERYTHING_MCP_ROOTS`) | 364 | `std::fs`, `globset` (crate), même moteur de règles | **Faible** | Attention au port exact : `_long()` (préfixe `\\?\`), `path_allowed` last-match-wins, `fnmatch` → `globset`. À porter à la lettre avec tests de parité. |
| `categories.py` | 60 | `static`/`phf` map | Trivial | |
| `_obsolete/ntfs_index.py` (référence) | 802 | `mft_reader` + `usn_watcher` + `index` dans le démon | **Élevée** | Le cœur du projet — voir `01-SPEC-MOTEUR.md`. La logique USN est à porter, le parseur MFT est nouveau. |
| `_obsolete/query_parser.py` | 310 | `query_engine` du démon | Moyenne | Parser → AST → prédicats compilés. |
| `build_index.py` + `*.ps1` | ~160 | `--install`/`--service` du binaire + Windows Service | Moyenne | `windows-service` + OpenSCManager ; ou schtasks en transitoire. |
| Extension VS Code (`extension.js`, `searchView.js`, `mcpClient.js`, panel) | ~3-4 k | **Non portée — non portable** | n/a | VS Code impose JS/TS. `mcpClient.js` spawn `hphe-mcp.exe` au lieu de `python -u server.py` : diff de ~10 lignes. Le VSIX devient autonome **complet**. |

**Bilan : ~80 % du code actuel porte en difficulté faible ; les 20 % élevés
sont le moteur d'index lui-même** (nouveau code, pas un port).

---

## 2. Architecture Rust cible

```
crate workspace hphe/
├── hphe-core/        # index SoA, query engine, snapshot (lib — testable)
├── hphe-ntfs/        # mft_reader, usn_watcher (lib — isolée, Windows)
├── hphe-indexd/      # binaire démon : service + pipe serveur     [élevé]
├── hphe-mcp/         # binaire MCP stdio : tools + policy + pipe client
├── hphe-fs/          # port de fs_tools (lib partagée hphe-mcp)
└── hphe-cli/         # hphe.exe — status/rebuild/query/bench
```

Deux binaires livrés : `hphe-indexd.exe` (élevé, install service) +
`hphe-mcp.exe` (non-élevé, spawné par l'IDE) + `hphe.exe` (ops, optionnel).

**Séparation stricte** : la policy `.mcp-access` et les outils `fs_*` vivent
dans `hphe-mcp` (non-élevé) — le démon ne sert que l'index. Le démon peut
recevoir le profil en handshake pour pré-filtrer en option (v2), mais la règle
« policy au bord » reste en MCP layer : même modèle de confiance qu'aujourd'hui.

---

## 3. Ce que le portage complet apporte concrètement

| Gain | Détail |
|---|---|
| **Fin de `spawn python ENOENT`** (CHANGELOG 1.0.1) | Le VSIX embarque `hphe-mcp.exe` ~5-15 Mo ; plus d'interpréteur à détecter, plus de `python`/`python3`/`py -3` fallback — le problème disparaît **par construction**. |
| Binaire unique, démarrage < 10 ms | pas de JIT/interpréteur, spawn MCP instantané |
| Pas de GIL | scan parallèle (rayon) dans le démon ; le serveur MCP reste léger |
| Un seul langage à maintenir | la surface ctypes/ctypes-structs disparaît (structures via `windows-sys` typées) |
| Performances structures | `memchr`/`aho-corasick`/`rkyv` = le même arsenal que ripgrep — littéralement l'état de l'art du scan texte |
| Sécurité mémoire | le parseur MFT (données hostiles par nature : un disque peut être corrompu) bénéficie de la sûreté Rust — les bugs de parsing de records sont des panics, pas des corruptions |

## 4. Ce qu'on perd / risques

| Coût | Commentaire |
|---|---|
| Réécriture effective (~4-7 k lignes) | Le port des couches minces est mécanique mais il faut **tester la parité** : batterie de requêtes `everything_search`/`fs_*` comparées ancien/nouveau backend. |
| Itérations plus lentes que Python | debuggage service Windows + pipes — compensé par `hphe-cli` et les tests `hphe-core` hors service |
| Écosystème MCP Rust jeune | `rmcp` est récent ; mais notre besoin = NDJSON + `serde_json` manuel → aucune dépendance à un framework |
| `std::fs` ≠ `os` à la virgule près | cas limites à verrouiller par tests : `\\?\`, symlinks/junctions, ACL, ADS, fichiers verrouillés, chemins > 260 |
| Binaires signés ? | SmartScreen/antivirus : un `.exe` non signé spawné par l'IDE peut alerter — prévoir signature ou documentation |

---

## 5. Stratégie de portage recommandée

1. **Co-existence** : le démon Rust est développé et testé *pendant* que
   `server.py` continue de parler à Everything.exe — aucun risque pour
   l'existant.
2. **Backend switchable** : `server.py` gagne un backend `hphe` (pipe) à côté
   de `everything` — bascule par env var → A/B test des deux backends en
   conditions réelles.
3. **Port MCP** : quand le démon est prouvé, `hphe-mcp.exe` réimplémente les
   18 outils à l'identique (les schémas JSON sont copiés tels quels ;
   `_fix_schemas` devient une définition correcte d'emblée).
4. **Retrait** : `everything_ipc.py` + Python deviennent `_obsolete/` v2.
   La dépendance à Everything.exe peut rester un backend optionnel de
   secours tant qu'il est présent.

Critère de coupure : batterie de parité (même requêtes → mêmes `total`,
mêmes top-N triés) + latence ≤ IPC actuel + fraîcheur ≤ 1 s.

---

## 6. Verdict

**Faisable et recommandé.** Le portage n'est pas un pari technique : c'est une
réécriture mécanique pour les couches client/serveur + un vrai développement
pour le moteur. En échange : distribution monolithique, zéro Python, zéro
dépendance externe, et la base technique pour les phases suivantes
(unification mémoire — doc 03).

Points de vigilance : parité bit-à-bit du comportement `fs_*` (tests), gestion
des privilèges (le démon = SYSTEM, le MCP = user), et signature du binaire
pour l'expérience install.
