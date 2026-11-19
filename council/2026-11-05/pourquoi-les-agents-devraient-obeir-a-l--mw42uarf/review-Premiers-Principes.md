# TOUR 2 Peer-Review — Premières-Principes

## Notes individuelles (1-10, mérite)

**A1** : 7/10 – Identifie le gap de polling et l’absence d’ACL, mais l’assertion sur la notification push reste hypothétique.

**A2** : 8/10 – Lie la responsabilité au score /100 et propose une cible quantitative (<5 % de déclarations non vérifiées) dès le 3ᵉ cycle.

**A3** : 9/10 – Articule les mécanismes les plus concrets (push+ACK obligatoires, relances néesborées, polling contraint) et l’assertion lie directement la perte d’ACK à la chute du score discipline.

**A4** : 6/10 – Présente les trois piliers (contrôle d’accès, preuve vérifiable, escalade limitée), mais l’assertion « 100 % des agents livrent à temps » est abs‑olutiste et se révèle fausse si une seule tâche manque de confirmation.

**A5** : 7/10 – Instaure un contrat de responsabilité mutuelle, preuve tracée et relances forcées, mais l’assertion sur la chute du score sans ACL est spéculative.

## Plus forte analyse : A3 (score 9/10)

## Plus gros angle mort (commun à toutes) : Absence de preuve matérialisée et immuable capturée **avant** la fenêtre de polling suivante – aucune des analyses ne impose de hash/checksum/extrait de journal signé au moment même de la complétion de la tâche, de sorte que la preuve peut être altérée ou fabriquée a posteriori.

## Ce que TOUTES ont raté : Pas de exigence de fournir une empreinte cryptographique (hash) ou extrait de journal immuable au moment de la déclaration de succès, stocké de façon immuable sur le serveur avant le prochain polling. Sans ce point de repère vérifiable, toutes les contraintes d’obéissance, de relance et d’escalade restent théoriques.