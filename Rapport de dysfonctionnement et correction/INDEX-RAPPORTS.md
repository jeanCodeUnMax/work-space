# INDEX-RAPPORTS — Rapport de dysfonctionnement et correction

Repertoire : `c:\Program Files\Projet-complet\hephaistos2-kit\Rapport de dysfonctionnement et correction\`
Regle : `.agent/rules/rapport-dysfonctionnement.md` — tout incident d'orchestration est consigne ici (Markdown, zero emoji).
Periode couverte : nuit 18-19/10/2026.

| # | Rapport | Taches | Composant | Severite | Statut |
|---|---------|--------|-----------|----------|--------|
| 01 | nim-worker : templates legataires, prompt non substitue et livrables factices | #500 #501 #509 #520 #523 #521 | `nim-worker.mjs`, `seed-orchestrator.mjs` | Haute (4 livrables factices) | Corrige (#521 + FR-03/FR-05) |
| 02 | vibe : budget epuise 402, tache zombie | #502 | provider `vibe`/`mistral` | Moyenne | Corrige (FR-02 + FR-07 + FR-08) |
| 03 | kilo->openrouter : dispatch vers provider desactive | #503 | `dispatch_task`, `provider_prefs` | Moyenne | Corrige (FR-01/FR-02) |
| 04 | ollama-cloud/hermes : worker gelee vivant (x2) | #508 #524 | `hermes.exe`, provider cloud | Haute (gel silencieux) | Corrige (kill + FR-08 heartbeat/reaper) |
| 05 | hphe-mcp.exe : process stale, gates non appliquees | #520 | deploiement `hphe-mcp.exe` | Haute (brèche enforcement) | Documente (rotation imposee) |
| 06 | watchdog et reveil agycascade : canal reactif | #514 #533 | `watchdog.ps1`, `agy-hub.js` | Fondation | Deploye (daemon 30 s + FSW + Connect-RPC) |
| 07 | extension hephaistos-kit-search 1.0.5 | #498 #501 | `searchView.js`, `panel.js` | Moyenne | Corrige (VSIX package, non installe) |
| 08 | gouvernance dispatch : cloud CLI vs ACP | transverse | politique d'affectation | Structurelle | En vigueur (regle Boss editee) |
| 09 | spawn workspace : os error 123 | #525 #526 #531 #532 (transverse) | `template_to_spawn_plan` | Moyenne | Corrige (substitution {workspace} + purge templates) |
| 10 | audit de securite Hephaistos 2.1 + livrable #542 non fiable | #540 #542 #548 | transverse (orch.rs, memory.rs, nim-worker.mjs, agent-bridge, bridge.js, extension.ts, watchdog.ps1) | Moyenne (aucun critique) | Audite + durci (F1-F5 corriges, cargo check vert) |
| 11 | audit de conformite du code Hephaistos 2.1 | #541 (livrable associe #543) | gates Rust, worker NIM, extension, CLI, auto-injection | Haute (FR-05/FR-04 partiels, FR-11 incomplet) | Audit termine ; ecarts consignes, corrections recommandees |
| 12 | crashes recurrents IDE Devin : OOM systemique | transverse | hote Windows + IDE Devin | Haute (perte fenetre, workers orphelins) | Diagnostique (OOM commit/RAM, reco empreinte) |

### Verification de cloture C - 2026-10-19

- Les rapports 01-11 sont presents. Les statuts ci-dessus distinguent les garde-fous deployes, les incidents documentes et les ecarts d'audit encore ouverts; les rapports 10-11 ne sont pas presentes comme des corrections appliquees.
- Les livrables #532 (`.agent/deliverables/rapports-lot2.md`) et #545 (`.agent/scripts/install-kit.md`) sont presents et leurs taches sont deja cloturees dans l'orchestrateur.
- Le checkpoint de session Obsidian `hephaistos2-kit` du 2026-10-19 a ete mis a jour avec la verification et l'etat de cloture.

## Legendes et regles de tenue

- **Statut "Corrige"** : le garde-fou empechant la recidive est code et deploye (gate Rust, reaper, gateArtifact).
- **Statut "Documente"** : cause comprise, procedure corrective en place, vigilance requise.
- Chaque nouveau rapport : format `NN-<slug>.md`, entree dans cette table, diffusion a l'orchestrateur.
- Les livrables workers des lots de transcription : `.agent/deliverables/rapports-lot1.md` (incidents 01-04), `rapports-lot2.md` (05-08).
