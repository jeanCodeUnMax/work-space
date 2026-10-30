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
| 13 | demarrage ingestion workspace dual-mode | - | pipeline ingestion | - | Documente |
| 14 | dispatches non signes hors chaine provider : equal-level (Bleubite 1) | #556-#560 | dispatch_task, acp-messages, discipline | Moyenne | Sanctionne + corrige (signature imposee) |
| 15 | devin-hub : attribution sourceAgent='agy' par defaut, confusion d'identite sessions + protocole PING/PONG canonique | transverse | agent-bridge/devin-hub.js, comms.jsonl, protocole-binome | Moyenne | Corrige (defaut honnete + --as + doc 9) |
| 16 | wake_acp_agent : prompt livre dans la mauvaise fenetre (redux focusedSessionId != panneau chat) | transverse | extension.ts wakeAcpAgent, matchesWorkspace | Haute (perte silencieuse de prompts) | Corrige (openCascadeIdInChatPanel systematique + fallback FIFO + post-verif) |
| 17 | Herald OS : chaine VPN Delirium non persistante au reboot + perte LAN lors du `up` | transverse | deliriuum-direct/lanfix/cerber-canal, bootc timer, groupe deliriuum | Haute (fenetres privees hors service, acces distant perdu) | Corrige (services enables, deliriuum-autoup cree, timer bootc desactive, ordre direct->lanfix->up->canal) |
| 18 | persistance positions React Flow schemas | transverse | webview workspace.tsx, workflowStore | Moyenne | Documente |
| 19 | Herald OS : canal prive tunnel SSH absent | transverse | canal prive herald-os | Moyenne | Documente |
| 20 | Run SWAT analyse : bug parsing `devin-hub send` (filtre --as avale args[0]), `ping` global sur cascades ACP (focus hijack + ping d'agent occupe), `fs_write` Bleubite backslashes doubles hors workspace, NIM 503, statut `acp-missing` trompeur | #735-#740 | agent-bridge/devin-hub.js, workspace-roster.js ping, acp-inject, fs_write worker | Moyenne (bug livraison reel + pieges d'usage) | Partiellement corrige (devin-hub fixe) + documente |
| 21 | Onglet ComfyUI vide : `403` ComfyUI `origin_only_middleware` sur `Sec-Fetch-Site: cross-site` envoye par l'iframe webview (curl 200 / iframe 403) ; WS proxy casse (Host duplique), proxy jamais lance si :8188 up, launcher absent du PATH | hephaistos2-kit | ComfyUI server.py middlewares, run_comfyui.bat --enable-cors-header, comfyui.cmd PATH, comfyui-proxy.mjs host filter, extension.ts ensureServiceOnce | Haute (debug live obligatoire, aucun fix par git pull) | Corrige (flag CORS + launcher + proxy WS) + documente |
| 22 | Memo operationnel : chaine ports/services saine, regles a ne jamais casser (cors-header, comfyui.cmd, node_modules monitor), checklist onglet vide, extensions canoniques, politique git pull org/push jcum | transverse | run_comfyui.bat, comfyui.cmd, extensions.json, update-kit.ps1 | Reference | Documente |

### Verification de cloture C - 2026-10-19

- Les rapports 01-11 sont presents. Les statuts ci-dessus distinguent les garde-fous deployes, les incidents documentes et les ecarts d'audit encore ouverts; les rapports 10-11 ne sont pas presentes comme des corrections appliquees.
- Les livrables #532 (`.agent/deliverables/rapports-lot2.md`) et #545 (`.agent/scripts/install-kit.md`) sont presents et leurs taches sont deja cloturees dans l'orchestrateur.
- Le checkpoint de session Obsidian `hephaistos2-kit` du 2026-10-19 a ete mis a jour avec la verification et l'etat de cloture.

## Legendes et regles de tenue

- **Statut "Corrige"** : le garde-fou empechant la recidive est code et deploye (gate Rust, reaper, gateArtifact).
- **Statut "Documente"** : cause comprise, procedure corrective en place, vigilance requise.
- Chaque nouveau rapport : format `NN-<slug>.md`, entree dans cette table, diffusion a l'orchestrateur.
- Les livrables workers des lots de transcription : `.agent/deliverables/rapports-lot1.md` (incidents 01-04), `rapports-lot2.md` (05-08).
