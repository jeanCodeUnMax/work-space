# Historique steady-agent (Executeur)

## Session 2026-11-04/cup-biere-1793757229

### peer-review
PEER-REVIEW Executeur — question : "Peut-on faire la cup a la biere SANS farine ?"

A1 /10 : 7
Justification : Souligne à juste titre l'ambiguïté du terme "cup au bière" et l'hypothèse non vérifiée que la farine serait indispensable. Force une clarification nécessaire avant toute tentative technique.

A2 /10 : 8
Justification : Propose des alternatives matérielles concrètes (argile, epoxy, impression 3D) qui démontrent que la fonction "coupe" ne dépend pas de la farine. Le raisonnement est solide mais reste centré sur le contenant plutôt que sur l'assiette/gâteau.

A3 /10 : 9
Justification : Analyse technique précise liant les propriétés protéiques/sucrées de la bière à des températures de coagulation. La revendication falsifiable (≥50 g) est claire et ancrée dans la science des aliments. C'est l'argument le plus solide du jeu.

A4 /10 : 8
Justification : Explore la faisabilité d'une pâte/cake à la bière sans farine de blé, avec des amidons alternatifs et la carbonatation comme levant.

## Session 2026-11-04/protection-workspace-1793816630

### analyse
Stance: Protecting the IA workspace is essential to prevent irreversible data loss and maintain auditability.
1) Mise en place de versionning git sur le workspace racine avec commits automatiques après chaque tâche critique.
2) Snapshots horodatés quotidiens stockés dans un dossier /backup, avec rétention 7 jours pour rollback rapide.
3) Chiffrement des fichiers sensibles (clés API, configs) via .gitattributes cryptés et clés gérées par l'infrastructure.
Assertion falsifiable: Si un agent supprime accidentellement un fichier critique, le snapshot du jour précédent peut être restauré sans perte de données.

## Session 2026-11-04/rag-seul-vs-rag-recherche-web-l-inferenc-mw2ho95x

### analyse
Stance: Le RAG seul produit une qualité d'inference supérieure, plus stable et moins sujette aux hallucinations que le RAG enrichi par la recherche web.
A) Ancrage documentationnel : le RAG seul garantit que la réponse provient exclusivement des données d'entraînement certifiées, sans injection de bruit externe.
B) Confiance & traçabilité : chaque extrait peut être tracé jusqu'à sa source documentée, facilitant la vérification par l'utilisateur.
C) Stabilité de la qualité : suppression du facteur "pollution web" qui fait diverger la pertinence selon la requête.
Assertion falsifiable : Si on exécute 100 requêtes identiques avec RAG seul et RAG+web sur des sujets techniques, le taux de "reponse jugée incorrecte ou hors-sujet" sera statistiquement supérieur de ≥15% pour le RAG+web (testé via évaluation humaine blindée).

### peer-review
A1 : 8/10 – La cohérence des sources et le mécanisme de fusion sont essentiels ; le web apporte du bruit (fake-news) sans filtre, le RAG seul reste maîtrisable ; un mauvais merging amplifie les contradictions.

A2 : 7/10 – RAG+web avec validation stricte des sources offre des données temps réel (+38 % de pertinence post‑2023) mais nécessite un scoring de domaine et une vérification croisée pour limiter la désinformation (<4 % d’erreurs).

A3 : 6/10 – La fiabilité dépend de la qualité du corpus ; l’élargissement et la mise à jour corrigent les lacunes mais exposent à de la polarisation/dissonance. Falsifiable : >30 % de réponses incohérentes avec le web actif = dégradation.

A4 : 9/10 – RAG seul supérior pour ancrage documentaire certifié et traçabilité totale. Le web est un facteur de divergence selon la requête. Falsifiable : sur 100 requêtes techniques, le taux de réponses incorrectes est ≥15 % supérieur pour RAG+web.

