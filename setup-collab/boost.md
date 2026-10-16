---
description: Mode Boost — Parallélisation maximale, délégation agressive aux subagents, cadrage Hephaistos et vérification continue
---

# Workflow /boost — Mode Boost Haute Performance

Ce workflow est déclenché par la commande /boost. Il active le mode d'ingénierie avancée, de parallélisation et d'autonomie maximale.

## 1. Directives Opérationnelles du Mode Boost
- **Autonomie Maximale :** Skip systématique des demandes de confirmation pour les étapes évidentes (création de fichiers, lectures, tests, exécution de scripts non destructifs).
- **Parallélisation & Délégation Agressive :** Déléguer immédiatement toute sous-tâche d'exploration, de recherche ou d'analyse lourde (>3 fichiers ou >150 lignes) à des sous-agents en tâche de fond.
- **Rigueur Chirurgicale :** Zéro placeholder, zéro code mort, zéro supposition. Chaque implémentation doit être complète et fonctionnelle.

## 2. Phase 0 : Cadrage & Indexation Immédiate (Hephaistos)
- **Interdiction Formelle :** Ne jamais lancer de commandes lentes comme Get-ChildItem -Recurse, find ou dir /s.
- **Recherche Instantanée :** Interroger en priorité le serveur MCP Hephaistos-everything-search :
  - `everything_search` : localiser instantanément les fichiers cibles et leurs dépendances sur le disque.
  - `content_search` / `hybrid_search` : localiser les symboles, types et interfaces.
- **Fallback CLI si MCP non exposé :**
  `node "%USERPROFILE%\.config\devin\scripts\mcp-call.mjs" Hephaistos-everything-search everything_search '{"query":"<terme>"}'`

## 3. Phase 1 : Exécution & Délégation
- Verrouiller la session en **Mode Plan Strict** pour structurer l'intervention.
- Diviser le travail en blocs étanches et indépendants.
- Injecter directement les chemins absolus découverts par Hephaistos dans le contexte de travail pour éliminer toute perte de cycles.

## 4. Phase 2 : Boucle de Validation & Auto-Correction
- Exécuter les linters, vérifications de syntaxe et compilations.
- Lancer les suites de tests unitaires et d'intégration associées.
- Si une régression ou une erreur survient : diagnostiquer la cause racine, corriger immédiatement et re-tester avant de clore la session.

---
*Invoquer avec : /boost*
