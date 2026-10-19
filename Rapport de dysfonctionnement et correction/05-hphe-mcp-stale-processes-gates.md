# 05 — hphe-mcp.exe : process stale, gates deployees mais non appliquees

- **Date :** 2026-10-19
- **Taches :** #520 (dispatch illegal), Phase 1 deploiement
- **Composant :** `hphe-mcp.exe`, deploiement canonique `servers/hephaistos2-kit/extension/server/`
- **Detecteur :** Cash · **Correcteur :** Cash (alerte) + procedure de rotation documentee

## Symptome

Apres deploiement de la Phase 1 (gates FR-01 a FR-04), la tache #520 — une mission `explore` exigeant `fs_read` — a ete dispatchee avec succes vers `nim1` dont `capabilities=["text_only"]`. Le gate FR-03 aurait du refuser : il n'a pas bloque.

## Cause racine

Quatre process `hphe-mcp.exe` etaient actifs depuis avant le deploiement (heures de demarrage 13:38/02:13, deploye ~04:15). Windows permet le rename/copy d'un exe en cours (strategie `.old` + copie), mais les process deja lances gardent l'ancien code en memoire. Le dispatch de #520 est passe par l'un de ces process stale : les nouvelles gates n'y existaient pas.

## Correction appliquee

- Alerte transmise a Tango : les gates n'ont d'effet qu'au recyclage des process MCP.
- Documentation : tout deploiement de `hphe-mcp.exe` impose une rotation des sessions MCP actives (reload fenetre IDE ou reconnexion des clients) pour etre effectif.
- Compensations transitoires : veille Cash a intercepte le livrable factice de #520 (nim1 incapable d'ecrire) ; la tache a ete requalifiee `failed`.

## Verification et prevention

- Procedure deploiement : rename exe vivant -> `.old-<date>`, copie du nouveau, puis rotation des process.
- Ajoute aux exigences non fonctionnelles du PRD consolide (section 9).
- Watchdog : l'etat `hphe_health` et les anomalies de dispatch sont suivis ; un gate contourne par process stale produit des alertes de veille visibles.
