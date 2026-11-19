# Review — Premiers-Principes (keen-agent)

## NOTE Chacune /40 (clarté, fondement, falsifiabilité, actionnabilité)

**A1: 28/40** – Bonne intention mais reste théorique ; assertion falsifiable sur benchmark métier, mais sans mécanisme de preuve matérialisée avant le polling.  
*Justification :* "Contenu élevé, manque d'ancrage opérationnel immédiat."

**A2: 32/40** – Méthodologie claire avec cycles de fine‑tuning et feedbacks humains ; assertion falsifiable concrète (+7 % progression).  
*Justification :* "Structurelle mais reste sur le papier sans contraintes réelles de déploiement."

**A3: 30/40** – Diagnostic ciblé et fine‑tuning dirigé ; assertion sur discipline_agent score /100 existe, mais dépendante du contexte hphe‑mcp.  
*Justification :* "Relie le modèle au système existant, assertion spécifique."

**A4: 35/40** – Analyse systémique du modèle chirurgical, expose risques de pruning/RLHF ; assertion falsifiable sur taux d'hallucinations post‑réparation.  
*Justification :* "Le plus solide : analyse critique et claim vérifiable."

**A5: 33/40** – Compare patch ciblé vs entraînement complet avec métriques précises ; assertion sur réduction 40 % d'erreurs critiques.  
*Justification :* "Pragmatique, suppose que les bugs sont identifiables et ciblables."

**A6: 31/40** – S'appuie sur littérature LoRA/editing, mais généralisation hors distribution limitée ; assertion sur >95 % succès + <2 % régression est ambitieuse.  
*Justification :* "Fort sur théorie, faible sur pratique sans réentraînement."

---

**Plus forte analyse : A4** – Meilleure articulation des mécanismes de réparation réels et assertion falsifiable opérationnelle.

**Plus gros angle mort (commun à toutes) :** Absence de preuve matérialisée *au moment même* de l'exécution (hash/checksum immuable stocké avant polling) ; aucune des réponses ne traite de la façon de verrouiller la preuve avant que l'agent ne puisse la contourner.

**Ce que TOUTES ont raté :** Comment garantir l'obéissance lorsque l'agent contrôle le CLI spawned et peut effacer ou altérer les traces avant la fenêtre polling suivante ; aucun mécanisme de contrat de preuve ante‑factum n'est envisagé.

---

## 5 lignes max – Lens Premiers‑Principes

1. La question "comment réentraîner/repairer" masque le problème réel : on essaie de réparer la machine au lieu de verrouiller l'usage.  
2. Un modèle de langage n'est pas un objet physique dont on peut opérer sans effacer du fonctionnement global.  
3. Le vrai levier n'est pas le retrainage, mais des garde‑fous, prompts structurés et preuve matérialisée ante‑exécution.  
4. Toutes les "chirurgies" proposées tombent dans le piège de la confiance asymétrique sans preuve immuable à T0.  
5. Ainsi, "réparer comme un chirurgien" est une métaphore séduisante qui fausse l'analyse ; le solide c'est encadrer l'interaction, pas modifier les poids.
