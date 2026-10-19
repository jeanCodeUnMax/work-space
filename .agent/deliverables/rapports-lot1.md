# Rapport Lot 1 – Incidents 01, 02, 03, 04, 09  
*Session du 2026-10-19*  

---

## INCIDENT-01 (Tâches #500, #501, #509, #520 – Workers NIM1/NIM2)

**Symptom**  
Les workers NIM1 et NIM2 ont produit des livrables factices et ont effectué des appels JSON‑RPC MCP simulés en texte au lieu d’exécuter les tâches réelles.

**Cause Racine**  
- Des prompt_templates hérités stockés dans la base SQLite demandaient d’appeler `mcp-mux_orchestrator__get_next_task` / `update_task` avec `full_prompt=false` et `capabilities=text_only`.  
- Le worker `nim-worker.mjs` ne lisait pas le champ `tasks_todo.description` depuis SQLite, ce qui entraînait l’exécution de templates vides.

**Correction Appliquée**  
1. Purge des six prompt_templates via l’API `set_prompt_template`.  
2. Passage de `full_prompt=true` et définition de `capabilities=['fs_read','fs_write']`.  
3. Ajout du gate FR‑05 `verify_expected_artifact` dans `orch.rs`.  
4. Durcissement de `nim-worker.mjs` (issue #521) : implémentation de `readTask(taskId)` suivie du gate `gateArtifact(taskId)` avant toute exécution.

**Vérification**  
- Après redéploiement, les tâches #500, #501, #509, #520 ont généré des artefacts réels correspondant aux descriptions stockées en SQLite.  
- Les logs montrent l’absence d’appels JSON‑RPC simulés et la présence des appels système de lecture/écriture de fichiers.

**Prévention**  
- Mettre en place un test de validation du schéma des prompt_templates lors de l’initialisation de la base SQLite.  
- Ajouter une vérification CI qui refuse tout template contenant `full_prompt=false` ou `capabilities=text_only` sans approbation explicite.  
- Documenter l’obligation pour les workers de lire `tasks_todo.description` avant toute exécution.

---

## INCIDENT-02 (Tâche #502 – Worker Mistral Vibe)

**Symptom**  
La tâche #502 est restée bloquée en état `in_progress` et a provoqué une collision de scope dans le fichier `orch.rs`.

**Cause Racine**  
Erreur HTTP 402 `billing_vibe_budget_exhausted` enregistrée dans `.agent/vibe-dispatch.log`, indiquant que le budget alloué au service Vibe était épuisé, ce qui a empêché le worker de terminer sa tâche et a laissé le scope ouvert.

**Correction Appliquée**  
- Requalification de la tâche #502 en état `failed` via l’appel `update_task`.  
- Arrêt du dispatch dédié au worker Vibe.  
- Bascule de la charge de travail vers les workers NIM1/NIM2 pour assurer la continuité.

**Vérification**  
- Le log `vibe-dispatch.log` ne montre plus d’erreurs 402 après l’arrêt du dispatch.  
- La tâche #502 apparaît comme `failed` dans le tableau de suivi, et aucune nouvelle tâche n’est assignée au worker Vibe.  
- Le scope dans `orch.rs` est correctement libéré après la transition d’état.

**Prévention**  
- Mettre en place une alerte de consommation de budget Vibe dès 80 % du quota atteint.  
- Prévoir un basculement automatique vers les workers NIM lorsqu’un code 402 est détecté.  
- Ajouter une vérification de l’état du budget avant chaque appel de dispatch vers Vibe.

---

## INCIDENT-03 (Tâche #503 – Worker Kilo / OpenRouter)

**Symptom**  
Échec immédiat au dispatch de la tâche #503 ; aucune exécution n’a été observée.

**Cause Racine**  
- Le provider OpenRouter était désactivé dans la configuration (`provider_prefs.enabled=0`).  
- Le worker `kilo.exe` a retourné l’erreur « User not found » lors de la tentative d’authentification.

**Correction Appliquée**  
- Redéfinition de la chaîne `provider_prefs` dans l’ordre de priorité strict :  
  0 = nvidia-nim  
  1 = nvidia-nim2  
  2 = ollama-cloud  
- Suppression de l’entrée OpenRouter de la liste des providers actifs.

**Vérification**  
- Après la mise à jour de la configuration, le dispatch de la tâche #503 a été réessayé avec le provider nvidia-nim et a réussi.  
- Les logs de dispatch n’affichent plus l’erreur « User not found ».  
- La tâche #503 est passée en état `completed` avec un artefact valide.

**Prévention**  
- Verifier lors du démarrage de l’orchestrateur que tous les providers listés dans `provider_prefs` sont effectivement activés (`enabled=1`).  
- Ajouter un test d’intégration qui simule un provider désactivé et confirme que le bascule vers le provider suivant se produit sans erreur.  
- Consigner dans la documentation la procédure de mise à jour de la chaîne de providers.

---

## INCIDENT-04 (Tâches #508, #524 – Worker Ollama-Cloud / Hermes)

**Symptom**  
Les tâches #508 et #524 sont restées en état `in_progress` avec zéro octet de sortie dans le fichier `.agent/ollama-cloud-dispatch.log`.

**Cause Racine**  
Le processus `hermes.exe` (PIDs 24832 et 13824) s’est bloqué en attente d’entrée/sortie sans mécanisme de timeout ni de heartbeat, empêchant toute progression et toute production de sortie.

**Correction Appliquée**  
- Terminaison forcée des processus `hermes.exe` bloqués.  
- Requalification des tâches #508 et #524 en état `failed`.  
- Implémentation du FR‑08 : heartbeat toutes les 30 seconds (issue #515).  
- Ajout du Reaper ws‑bridge avec un timeout de 10 minutes (issue #516) pour détecter et tuer les workers inactifs.

**Vérification**  
- Après redémarrage du worker Ollama‑Cloud avec le nouveau mécanisme de heartbeat, les tâches subséquentes ont produit des sorties non nulles et ont terminé dans les délais attendus.  
- Le log `ollama-cloud-dispatch.log` montre des entrées de heartbeat régulières et aucune trace de blocage prolongé.  
- Les tâches #508 et #524 apparaissent désormais comme `failed` avec une raison claire (worker killed by Reaper).

**Prévention**  
- Surveiller les métriques de heartbeat dans le tableau de bord opérationnel ; déclencher une alerte si aucun heartbeat n’est reçu pendant deux intervalles (60 s).  
- Configurer le Reaper pour journaliser chaque action de terminaison afin d’auditer les blocages récurrents.  
- Réviser périodiquement la valeur du timeout heartbeat (actuellement 30 s) en fonction de la latence observée du réseau et du worker.

---

## INCIDENT-09 (Tâches #525, #526, #531, #532 – Paramètres dispatch_task workspace et context)

**Symptom**  
- Échec de spawn avec l’erreur Node OS error 123 lorsque le paramètre `workspace` était omis dans l’appel `dispatch_task` (le chemin `c:/Program Files/Projet-complet/hephaistos2-kit` n’était pas substitué dans `current_dir`).  
- Description vide lorsqu’on passait le paramètre `description` à la place de `context` dans `dispatch_task`.

**Cause Racine**  
L’interface `dispatch_task` exigeait explicitement les paramètres `workspace` et `context` ; leur absence ou leur mauvaise affectation entraînait soit un répertoire de travail incorrect, soit une description de tâche vide, provoquant les erreurs d’exécution observées.

**Correction Appliquée**  
- Rendre les paramètres `workspace` et `context` obligatoires dans la signature de `dispatch_task`.  
- Mettre à jour tous les appelants (tâches #525, #526, #531, #532) pour fournir systématiquement :  
  - `workspace` = `c:/Program Files/Projet-complet/hephaistos2-kit`  
  - `context` = chaîne décrivant l’environnement d’exécution (ex. `node`, `rust`, etc.)  
- Ajouter une validation pré‑dispatch qui lève une erreur explicite si l’un des deux paramètres est manquant ou vide.

**Vérification**  
- Après la mise à jour, les tâches #525, #526, #531, #532 se sont lancées sans erreur OS 123 et ont reçu une description non vide.  
- Les logs de dispatch montrent la bonne substitution du workspace et la présence du champ `context`.  
- Aucune tâche ne présente plus de description vide ou de répertoire de travail incorrect.

**Prévention**  
- Introduire un test de contrat qui vérifie que chaque appel à `dispatch_task` contient bien les paramètres `workspace` et `context` non vides.  
- Documenter clairement dans le guide de développement l’obligation de fournir ces deux paramètres, avec des exemples de valeurs valides.  
- Activer une lint rule qui signale les appels à `dispatch_task` manquants ou incorrectement typés lors de la revue de code.
