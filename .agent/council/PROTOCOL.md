# LLM-Council — protocole Bleubites

Reseau : chaque advisor ecrit son analyse dans `council/<YYYY-MM-DD>/<Q>/advisor-<ROLE>.md`
puis annonce sur le bus `.agent/comms.jsonl` (ligne JSON {from,to:"chairman",type:"advisor-done",path}).

Tour 1 — ANALYSE : le chairman injecte la question -> tu reponds UNIQUEMENT sous ton angle,
8-15 lignes, concrete, pas de hedging. Ecris le fichier puis poste sur le bus.

Tour 2 — PEER-REVIEW : le chairman te re-injecte 6 analyses ANONYMISEES (A1..A6) ->
tu notes chacune (1-10) + 1 ligne de justification, dans `review-<ROLE>.md`. Poste sur le bus.

Le chairman synthetise : verdict + accords/desaccords -> rapport HTML + transcript.

## Supervision Chairman (grave 2026-11-04)

Le Chairman est AUTORITE D'AUDIT : il ne croit jamais une declaration, il verifie le livrable sur disque.
- Dispatch -> `supervise.mjs "question"` : injecte chaque advisor, surveille les fichiers,
  ROTATIONNE vers une fenetre backup tant que le role n'est pas rempli (deadline 4 min/advisor).
- Annonces : chaque agent ecrit sur `.agent/announce-<agent>.jsonl` (append, fichier dedie)
  — JAMAIS `comms.jsonl` en ecriture complete (ecrasement observe en prod).
- Chemins : prompts = chemins ABSOLUS (les resolutions relatives divergent par agent).
- Contexte : chaque nouvelle question prefixee "NOUVELLE QUESTION — ignore tout contexte precedent".
- Verdict partiel autorise si slots morts : consigner les absents dans le rapport.

## Doctrine du Grand Chef (grave 2026-11-04)

Le Chairman est JUGE et GARANT du cercle. Intransigeant, impartial :
- Chaque advisor DOIT produire son livrable. Pas de slot vide accepte.
- Sequence obligatoire : PUSH (re-inject jusqu'a 3 fois) -> ROTATION (backup) -> CONSTAT D'ECHEC documente.
- Aucune excuse retenue : backoff provider, session absente, contexte perdu — la fonction sera remplie par quelqu'un.
- Impartialite : le verdict juge le merite des analyses, jamais la fidelite des agents. Un backup qui livre vaut le titulaire.
- Toute substitution est tracee dans supervision.log — le dossier montre qui a vraiment travaille.
