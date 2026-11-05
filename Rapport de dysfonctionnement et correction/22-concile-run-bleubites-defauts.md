# 22 — Concile bleubites : premier run live — defauts et correctifs

Date : 2026-11-04 · Workspace : VIdo_Prod · Question : "pate a crepe halal sans biere ni farine"
24/24 tours executes (6 avis + 6 revues + 12 debat). 19 reponses reelles, 5 tronquees, 1 perdue (401).

## Defauts rencontres

| # | Defaut | Cause racine | Correctif applique |
|---|--------|--------------|--------------------|
| 1 | inject hephaistos `code 1` | acp-inject resout `extensions/hephaistos-chats/acp-server.mjs` relatif au workspace — absent de VIdo_Prod | PROVIDERS.hephaistos → chemin absolu kit (env `HPHE_ACP_SERVER` en override) — A PROPAGER au kit |
| 2 | 5 reponses tronquees `[echec inject]` | subprocess stdout decode cp1252 → crash + relecture sessions.json concurrente | `encoding="utf-8", errors="replace"` dans council-run.py |
| 3 | 3 fenetres omniroute 401 | provider `uncloseai` beta publique fermee | bascule sessions.json → nim2, puis diversite 6 modeles via `available_models` hphe |
| 4 | `acp-missing` / restore `ws module introuvable` | tunnel ws :7477 non resolu hors IDE | inject direct sessions.json — fonctionne fenetre fermee |
| 5 | `node.question` re-strippe | extension live < 0.3.40 avec vieux validateWorkflow en cache | v0.3.40 deployee ; question passee en argv du script (immunisee) |
| 6 | Outsider fait `fs_list_directory` parasite | prompt trop ouvert, l'agent outille | durcir prompt : "reponds texte, zero outil" |
| 7 | Debat repetitif (recap des revues) | prompt autorise le résumé | exiger du NEUF : "argument nouveau ou concession, jamais de recap" |
| 8 | Verdict non injecte dans fenetre chairman | script s'arrete au transcript | phase 5 : inject verdict → ionian-helicopter + rapport |
| 9 | Collecte par diff de contenu | compare dernier msg assistant → rate si meme texte | collecter par COMPTEUR de messages avant/apres |

## Recommandations orchestrateur (a implementer)

1. **Pre-flight health check** : ping chaque bleubite avant run ; provider KO → rebascule auto via `available_models` hphe (boucle jusqu'a 6/6 vivants)
2. **Skill `swat-concile`** : figer la procedure (prompts, phases, collecte, verdict) dans `.agent/skills/swat-concile/SKILL.md`
3. **Diversite de modeles par design** : 1 modele distinct par conseiller (verifies discovery) — perspectives reellement differentes
4. **UTF-8 partout** : PYTHONIOENCODING=utf-8 + encoding explicite dans tout subprocess
5. **Tasks hphe par noeud** : create_task par conseiller a chaque phase, update_task a la reponse — traçabilite orchestrateur native
6. **Verdict dans la fenetre** : injecter la synthese dans ionian-helicopter + ecrire HTML/MD dans .agent/reports/
