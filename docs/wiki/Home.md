# Hephaistos2-Kit — Wiki

**Hephaistos2-Kit** est une plateforme Windows de recherche filesystem
ultra-rapide pour agents IA. Un démon Rust (`hphe-indexd`, tâche planifiée
SYSTEM) lit directement le `$MFT` NTFS et suit le journal USN en continu :
recherches en **< 50 ms** sur tout le PC, **sans `Everything.exe`**.

Au-dessus de l'index, un serveur MCP unique (`hphe-mcp`, **58 outils**)
couvre recherche NTFS, indexation de contenu (Tantivy), recherche vectorielle
(usearch 2048D), orchestration multi-agents, routage de modèles NIM, mémoire
unifiée et ingestion. La passerelle `hphe-rest` (`127.0.0.1:8792`) expose les
mêmes outils en HTTP plus une boucle d'ingestion automatique.

## Chiffres clés

| Métrique | Valeur |
|---|---|
| Entrées indexées | ~6,4 M (démon `hphe-indexd`, 4 volumes NTFS) |
| Latence recherche | ~30–50 ms typique (snapshot mmap, USN live) |
| Droits admin | démon SYSTEM uniquement ; clients sans droits |
| Backend | Rust — aucun binaire externe |
| Transport | stdio MCP + named pipe `\\.\pipe\hphe-index` + REST :8792 |
| Outils | 57 (6 familles) — voir `docs/MCP-TOOLS.md` |

## Ce que ça remplace

v1 reposait sur `Everything.exe` (thin client Python IPC) + une galaxie de
serveurs MCP : orchestrator Node, agentMemory, nim-router, model-discovery,
qdrant, zvec, pont RAG. Tout est absorbé par `hphe-mcp`. Les anciens serveurs
sont dans `servers\servers_backup\` (rollback possible).

## Pages

- [[Architecture]] — composants et flux de données
- [[IPC-Protocol]] — protocole NDJSON du named pipe hphe
- [[Tools-Reference]] — pointeur vers `docs/MCP-TOOLS.md` (58 outils)
- [[Query-Syntax]] — syntaxe de requête (compatible Everything)
- [[Security]] — `.mcp-access`, allowlist, gestion des secrets
- [[Benchmarks]] — protocole de mesure et résultats
- [[Dev-Guide]] — build, tests, release, sous-modules
