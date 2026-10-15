---
description: Invariants de sûreté pour la commande Devin `/jointes <agent>`.
trigger: always_on
---

- Pour `/jointes <agent>`, appliquer `.devin/skills/jointes/SKILL.md`; la référence canonique est `docs/protocole-binome/README.md`.
- `/jointes` est une skill Devin; ne pas prétendre qu’elle apparaît dans le menu d’un ACP tiers. Le menu ACP dépend des commandes annoncées par le provider sélectionné.
- N’annoncer un join réussi qu’après requête/ACK frais corrélés par `pairId`, `session`, transports, providers et IDs exacts; exiger `established: true`. Les handshakes legacy sont ignorés et le `hint` seul ne prouve rien.
- Séparer strictement les modes `hub`, `acp` et `cli`; Kilo/Hermes peuvent avoir un ID ACP et un ID CLI différents. Aucun fallback d’un mode/session vers l’autre.
- Pour ACP, ne router que vers un couple exact `providerId/sessionId` présent dans l’état ACP, activé et rattaché au workspace courant; restaurer l’onglet existant et revérifier le focus. Session absente, désactivée ou non focalisable = `skipped`.
- Les workers API directs NIM1/NIM2 du registre orchestrateur ne sont pas des sessions. Les providers ACP `nim`/`nim2` sont distincts et ne sont joinables que si une session ACP réelle est listée et acquitte le handshake.
- Ne jamais créer de conversation de remplacement, injecter dans une session non vérifiée, utiliser un toast ou le presse-papiers comme fallback, ni afficher/enregistrer un jeton CSRF ou une clé.
