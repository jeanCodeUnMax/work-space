# Premiers-Principes — Conseil

## Stance
Le protocole JIT skills‑mux officialise un pipeline d'activation à la demande, mais sans points de preuve immutables à chaque étape le pipeline reste vulnérable à des états silencieux et à des drifts de contexte.

### Argument 1
Chaque étape (route → vet → activate → execute → deactivate) doit lier un hash SHA‑256 de l'artefact skill au registre de session de l'agent avant de passer au suivant, garantissant traçabilité et empêchant substitution de skill non authentifié.

### Argument 2
Le montage éphémère sous .agents/skills doit être systématiquement démonté dans un bloc `finally` ; une panne pendant l'activation laisse le vault en état partiellement monté, bloquant les prochaines requêtes JIT et générant des doublons de état.

### Argument 3
Une gate globale interdit l'activation si le flag d'état du skill est déjà ACTIVE ; toute tentative de double activation renvoie `BLOCKED_SUSPICIOUS` et inscrit un événement d'audit, prévenant ainsi des cascades d'activation non intentionnelles.

## Assertion falsifiable
Si on ajoute l'enregistrement du hash SHA‑256 au début et à la fin du pipeline, et que le scénario de test consiste en un crash de l'agent pendant l'étape activate, alors le rapport post‑mortem affichera l'état du skill HALTED, le vault démonté, et toute tentative de ré‑activation sans purge explicitera une erreur de verrouillage, prouvant que le mécanisme de gate et de purge empêche le comportement non désiré.