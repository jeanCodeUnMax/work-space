---
name: swat-concile
description: Orchestre le concile SWAT bleubites (methode llm-council) via acp-inject dans les fenetres ACP reelles. Avis paralleles → revue anonymisee → debat chaine → verdict chairman. A utiliser pour toute decision soumise au concile.
---

# SWAT Concile — procedure orchestrateur

Script : `.agent/scripts/council-run.py "<question>"` (question en argv — jamais dans le schema, jamais dans node.task).

## Pre-flight (obligatoire)
1. `node .agent/agent-bridge/workspace-roster.js status` — noter les acp-missing (non bloquant : inject ecrit dans sessions.json meme fenetre fermee)
2. `available_models` hphe → catalogue verifie ; assigner 1 modele distinct par conseiller dans `.agent/chats/sessions.json`
3. Ping inject par session (`--wait turn`, prompt 1 mot). 401/erreur → rebasculer provider (nim2 lightning = valeur sure) jusqu'a 6/6 OK.

## Run
- Phase 1 : avis independants en parallele (prompt : reponds TEXTE, zero outil, 150-300 mots)
- Phase 2 : revue anonymisee A–F en parallele (3 questions, <200 mots)
- Phase 3 : debat ouvert chaine 2 tours (exiger argument nouveau ou concession — jamais de recap)
- Phase 4 : verdict chairman en 5 sections → inject dans la fenetre chairman + rapport `.agent/reports/`

## Pieges connus (voir rapport 22)
- PYTHONIOENCODING=utf-8 ; subprocess `encoding="utf-8", errors="replace"`
- Collecter par compteur de messages, pas par diff de texte
- omniroute/uncloseai : souvent 401 — preferer nim/nim2
- node.question peut etre re-strippe par une extension < 0.3.40 → question en argv
