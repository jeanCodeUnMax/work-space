---
name: skills-mux
description: Routeur et gestionnaire de compétences JIT (Just-In-Time). Utilisez ce skill dès qu'une tâche nécessite une compétence spécialisée non couverte par les outils natifs (vidéo, PPTX, diagrammes SVG, reverse-engineering, marketing, TDD, TypeScript avancé, etc.) pour router, auditer et monter/démonter temporairement le skill requis.
---

# Skills MUX — Routeur & Interrupteur JIT

Playbook d'orchestration pour le chargement et déchargement sécurisé à la demande des compétences issues du catalogue local `c:/data-sys/claude-skills-mux/claude-skills-mux`.

## Règle Absolue d'Exécution (Cycle JIT)

Ne jamais charger un skill de manière permanente sans raison. Toute activation suit strictement les 5 étapes :

### 1. Routage Sémantique (Identifier le bon candidat)
Exécuter la recherche hybride avec l'intention utilisateur en langage naturel :
```bash
python c:/data-sys/claude-skills-mux/claude-skills-mux/skills_mux.py route "<intention utilisateur>" --limit 3
```
Examiner la fiche des **5 Doigts de la Main** pour valider :
- Pouce (Intention réelle)
- Index (Gain immédiat)
- Majeur (Contrepartie / Prix à payer)
- Annulaire (Rayon d'action / Blast radius)
- Auriculaire (La gifle de la réalité / Limite dure)

### 2. Audit de Sécurité Déterministe
Vérifier l'absence de scripts hostiles, binaires non vérifiés et hooks NPM silencieux :
```bash
python c:/data-sys/claude-skills-mux/claude-skills-mux/skills_mux.py vet <slug>
```
Si le statut est `BLOCKED_SUSPICIOUS`, stopper et refuser l'activation sans autorisation explicite.

### 3. Activation Éphémère (Switch ON)
Monter temporairement le skill dans le workspace :
```bash
python c:/data-sys/claude-skills-mux/claude-skills-mux/skills_mux.py activate <slug>
```
Le playbook du skill devient actif dans `.agents/skills/<slug>/SKILL.md`.

### 4. Exécution de la Tâche
Appliquer les consignes et exécuter la tâche demandée avec rigueur.

### 5. Désactivation Immédiate (Switch OFF / Purge Contexte)
Dès que la tâche est terminée et vérifiée, libérer la mémoire :
```bash
python c:/data-sys/claude-skills-mux/claude-skills-mux/skills_mux.py deactivate <slug>
```
Ou purger tout résidu éventuel :
```bash
python c:/data-sys/claude-skills-mux/claude-skills-mux/skills_mux.py cleanup
```
