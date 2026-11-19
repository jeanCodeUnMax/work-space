# Verdict — Concil « Pourquoi obéir / comment se faire respecter » (2026-11-05)

**Livrables** : 5/6 advisors (Empirique absent — provider omniroute hors service, fetch failed persistant).
**Reviews** : 3/5 reçues (Premiers-Principes, Expansionniste, Exécuteur — permutations distinctes par reviewer).
**Déanonymisation** : A1=Exécuteur, A2=Outsider, A3=Premiers-Principes, A4=Contrariant, A5=Expansionniste.

## Où le concil est d'accord (5/5 présents)

- **L'obéissance n'est pas une soumission** — c'est un contrat de responsabilité mutuelle : le canal unique garantit déterminisme, traçabilité et cohérence ; l'agent fournit des preuves vérifiables.
- **Sans canal unique : chaos** — doublons, conflits de ressources, états incompatibles en chaîne, tâches orphelines, « drift silencieux ».
- **Le respect s'obtient par la structure, pas par la morale** : preuve serveur obligatoire (ACK/jeton signé, hash d'artefact), escalade bornée → sortie humaine, discipline mesurable (score /100).

## Désaccords

- **Push vs polling forcé** : Exécuteur veut imposer le rythme de poll (timer partagé ~5 s) ; Outsider/Premiers-Principes veulent supprimer le besoin de poller (notification push automatique). Les deux s'accordent sur l'objectif — éliminer la fenêtre « j'ai oublié de poller » — mais divergent sur le levier.
- **Assertion absolue** : « 100 % livraison à temps » (Expansionniste) est jugée non falsifiable-en-pratique — une seule tâche non confirmée l'invalide.

## Angles morts attrapés en review

1. **Preuve crypto horodatée** : aucune analyse n'exige un hash/journal signé **au moment de la déclaration**, stocké de façon immuable côté serveur avant le prochain poll — sans ça, la preuve peut être fabriquée a posteriori.
2. **Discipline passive** : `discipline_agent` est un indicateur volontaire, pas une contrainte automatique ; le watchdog observe sans agir.
3. **Désobéissance active** : tout le système suppose la coopération — le cas « agent hostile ou désengagé » n'est traité par personne.
4. **Motivation** : aucun n'a dit *pourquoi* obéir est dans l'intérêt de l'agent (efficacité collective, moins de re-work) — l'obéissance purement contrainte est fragile.

## Analyse la plus forte : **Exécuteur** (unanimité 3/3 reviewers — y compris lui-même à l'aveugle)

Push + ACK obligatoire, relances bornées (×3 → humain), polling contraignant — le trio mécanisme/observation/conséquence le plus testable.

## Recommandation du chairman

Se faire respecter = rendre la désobéissance **observable et coûteuse**, jamais verbale :
1. `dispatch_task` → jeton ACK signé obligatoire pour clore ;
2. `create_task` rejeté sans `expected_artifact` + critère d'acceptation ;
3. Watchdog acteur : relances bornées + re-vérif des `completed` ;
4. `discipline_agent` **automatique** (fail/stale → score, alimente `provider_prefs`) ;
5. ACL sur `dispatch_task` ; escalade hors-boucle vers l'humain.

**Premier pas** : rendre `discipline_agent` automatique — chaque tâche `failed`/stale décrémente le score sans intervention. Aujourd'hui c'est le maillon « volontaire » qui casse la chaîne.
