# 21 — Concile aligné sur la méthodologie LLM Council (skill `llm-council`)

Date : 2026-11-04 · Agent : Devin (Cash)

## Contexte

Le schéma SWAT `Concile` (mode `council`) a été corrigé pour suivre la
méthodologie Karpathy implémentée par le skill `llm-council`
(https://github.com/tenfoldmarc/llm-council-skill), installé dans :
`~/.claude/skills`, `~/.devin/skills`, `~/.config/devin/skills`,
`~/AppData/Roaming/devin/skills` et `.agent/skills` (canonique kit).
Registre skill-mux reconstruit : `llm-council` résolu en source `canonical`.

## Dysfonctionnements corrigés

1. **Discussion séquentielle à transcript partagé** — chaque expert voyait
   les réponses des précédents, ce qui casse l'indépendance des avis.
   → `executeCouncil` refait en 4 phases : avis indépendants en parallèle
   (sans transcript) → revue par les pairs en parallèle sur avis **mélangés
   et anonymisés** (Réponse A, B, C…) → **débat ouvert séquentiel**
   (anonymat levé, chaque conseiller réplique à ses pairs en lisant tout
   le transcript — vraie discussion horizontale) → verdict chairman en
   5 sections (Consensus / Désaccords / Angles morts / Recommandation /
   Premier pas concret). Fichier : `extensions/hephaistos-chats/src/
   workflowRunner.ts` (+ `out/` régénéré par tsc).

2. **Pas de rapport visuel** — seul un transcript MD existait.
   → `concil-<runId>.html` auto-contenu ajouté dans `.agent/reports`
   (verdict en évidence, interventions en `<details>` repliés).

3. **Rôles d'experts métier au lieu de styles de pensée** — le schéma
   portait Expert-Architecture/Sécurité/Perf/Qualité/Faisabilité +
   Avocat-du-Diable. → Remappé sur les personas du skill : le chairman
   Devin (ionian-helicopter) soumet la question à **6 conseillers** —
   Contrariant (chat-de8acfde), Premiers-Principes (chat-mvmw59wa),
   Expansionniste (chat-mvmtldvy), Outsider (chat-mvmw5chd),
   Executeur (chat-mvpfinfra) et Empirique (chat-58bb1bda, l'avocat
   de la preuve — données, mesures, précédents ; 6e persona ajouté pour
   conserver les 6 sièges bleubites). Skills des nœuds annotés
   `llm-council`. Fichiers :
   `.agent/templates/schemas/Concile.json` (kit + VIdo_Prod),
   `VIdo_Prod/.agent/workspace-roster.json` (workflow actif),
   banque `~/.hephaistos-workflow-schemas.json` (auto-réparée).
   + **Maillage complet entre conseillers** — disposition en table ronde
   hexagonale (chairman au centre, 6 conseillers en cercle) avec le
   graphe complet K6 = **15 arêtes** entre pairs + 6 rayons chairman→
   conseillers (21 arêtes). Chaque conseiller est visuellement relié à
   tous les autres : full duplex assumé sur le canvas.
   + **Débat en 2 tours** — chaque conseiller prend deux fois la parole
   en chaîne (vrai va-et-vient multi-tour via le transcript broadcast).

4. **Question gravée en dur dans la mission du chairman** — la mission du
   noeud portait la question de migration. → Séparation structure/run :
   les 7 missions sont des prompts `ROLE:` polyvalents (réutilisables
   pour toute problematique). La question devient un parametre d'execution
   resolu par `resolveCouncilQuestion` : `node.question` → `graph.question`
   → dernier message utilisateur de la session chairman → mission legacy
   non prefixee `ROLE:` → erreur explicite. `validateWorkflow` preserve
   desormais `question` (noeud + graphe) — attention : l'extension chargee
   en memoire garde l'ancien roster.js tant qu'elle n'est pas rechargee,
   un sync peut restripper le champ avant reload. Fichiers :
   `src/workflowRunner.ts`, `src/extension.ts` (param `question` du message
   `run_workflow`), `.agent/agent-bridge/workspace-roster.js`.

## Correction bonus : test pré-existant cassé

`workflow.test.cjs` — "standard schemas are flagged builtin…" échouait
déjà : `deleteSchema` refuse volontairement les schémas standards
(`protected: true`) et `listSchemas` auto-restaure les gabarits ; le test
attendait une suppression effective. Réécrit pour couvrir le comportement
réel : suppression refusée + auto-guérison d'un graphe divergent
(`restoreStandardSchemas` → `(repare)`).

## Vérif

- `npx tsc -p ./` : clean · `node --check out/workflowRunner.js` : OK
- `node --test test/workflow.test.cjs` : 11/11
- `skill-mux__skills_resolve(["llm-council"])` : resolved via mcp-mux

## Limite connue

L'anonymat de la revue est structurel mais pas parfait : chaque conseiller
garde son propre message dans l'historique de sa session chat et peut
reconnaître son avis. Le mélange + étiquetage A–E supprime néanmoins le
biais positionnel sur les autres avis.
