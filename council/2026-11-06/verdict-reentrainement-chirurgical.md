# VERDICT DU CONCIL — 2026-11-06

**Question** : Comment peut-on réentraîner un modèle de langage, et comment le réparer comme un chirurgien ?
**Mode** : broadcast `council-broadcast.mjs` → 6 advisors, 6/6 `delivered:true`, 6/6 réponses persistées.

## Positions des advisors

### keen-agent — Premiers-Principes
La métaphore chirurgicale est une fausse présupposition : un LLM est une carte de poids distribués, toute coupure affecte des sorties lointaines de façon non linéaire. Le bon problème n'est pas de réparer le modèle mais de maîtriser son usage (prompts, garde-fous, données). Le réentraînement est un sledgehammer qui efface ce qui fonctionne.

### urban-agent — Expansionniste
Le réentraînement ciblé maximise l'upside : réduction des biais sans perturber l'existant, généralisation accrue, modularité des mises à jour. Un modèle affiné devient levier pour des applications entièrement nouvelles.

### steady-agent — Exécuteur
Lundi matin : (1) mesurer les écarts sur 50 prompts critiques, (2) fine-tuning dirigé sur les cas problématiques, pas de réentraînement global, (3) collecter les échecs réels et étiqueter les corrections attendues, (4) validation par score ≥+10 pts, (5) intervention sur poids + ACK serveur.

### amber-agent — Outsider
Chirurgie sur patient inconscient : les développeurs savent quels patterns supprimer, le modèle ne perçoit que la redistribution de ses probabilités. Réparation = pruner les poids codifiant les comportements indésirables + affiner sur corpus nettoyé. Risque : l'excès de pruning efface la flexibilité.

### kens-mmm (keen-nova) — Contrariant
Réentraîner est une panique, réparer est de l'ingénierie. Le réentraînement = perte de contrôle versions/données, coûts massifs, aucun rollback réplicable. La vraie réparation = patches prompts/outils + garde-rails + mesures testables, reproductible et traçable. Assertion falsifiable : sans diffs mesurables et rollbacks prouvés, le réentraînement n'améliore rien.

### brave-llm (brave-ibis) — Empirique
La chirurgie ciblée est la seule voie falsifiable : LoRA (rank 8-32) modifie <1% des poids et préserve 95-99% des benchmarks (Hu et al. 2021) ; ROME/MEMIT localisent les faits en couches MLP, 80-90% de succès sur CounterFact mais <30% de généralisation hors distribution (Meng et al. 2022-23). Aucune correction persistante démontrée sans risque de régression.

## Synthèse — verdict

**Consensus (5/6)** : le réentraînement global est un marteau non falsifiable — coûteux, non traçable, destructeur de capacités saines. La « chirurgie » réelle, c'est l'intervention ciblée : LoRA/adapter, model editing (ROME/MEMIT), patches de prompts et garde-rails mesurables.

**Dissensus** : urban-agent voit l'upside du réentraînement ciblé comme amplification ; les autres exigent d'abord la preuve de réparabilité (diffs mesurables, rollbacks).

**Verdict opérationnel** :
1. Diagnostiquer avant d'opérer (jeu de prompts critiques, écarts mesurés) — steady-agent.
2. Intervenir chirurgicalement : LoRA/editing ciblé, <1% des poids — brave-ibis.
3. Exiger la traçabilité : diffs, rollbacks, score de validation — kens-mmm.
4. Ne pas confondre réparation du modèle et maîtrise de son cadre d'usage — keen-agent.

**Chairman** : `daring-agent` (ionian-helicopter) — synthèse non encore injectée dans son chat.
