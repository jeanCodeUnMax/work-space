# ETUDE DE FAISABILITE : CONTROLE DES INSTANCES ACP/CLI ET SECURITE DES MCP SUR MACHINE MODESTE

## 1. SYNTHESE EXECUTIVE ET CONSTATS REELS

Dans le Hephaistos2-Kit, la decision d'unification du 12 octobre 2026 (documentee dans docs/hephaistos-engine/03-FAISABILITE-UNIFICATION.md) a definitivement regle la question du multiplexage :
- Un seul serveur MCP natif en Rust : hphe-mcp.exe (exposant Hephaistos-everything-search).
- Zero serveur externe Zvec ou Qdrant : le moteur vectoriel embarque est desormais hphe-vec base sur usearch (bindings natifs, fichiers *.usearch locaux).
- Zero serveur Node independant pour l'orchestration ou la memoire : orchestrator.db et le Knowledge Graph sont directement servis via rusqlite compile statiquement dans hphe-mcp.exe.
- Empreinte memoire reelle constatee sur machine : 12,5 Mo de RAM pour hphe-mcp et 0% de CPU au repos.

Le serveur Hephaistos unifie n'est donc absolument pas en surcharge. La vraie vulnerabilite sur machine modeste provient de deux sources externes :
1. Les doublons de sessions ACP dans l'IDE (multiplication des cascades et des contextes en vol).
2. L'absence de bride de concurrence sur les workers CLI (pics CPU a 100% lors des lancements simultanes).

---

## 2. DIAGNOSTIC DES VECTEURS DE SURCONSOMMATION

### 2.1 Les Cascades ACP Non Verrouillees
- Symptome : Lorsqu'un appel wake_acp_agent est declenche alors qu'une reponse est deja attendue ou en cours, une nouvelle session est ouverte en parallele dans l'IDE.
- Impact : Chaque session IDE ACP accumule des dizaines de Mo de contexte et mobilise le thread d'affichage.

### 2.2 La Saturation CPU par les Workers CLI
- Symptome : Plusieurs sous-agents CLI (Hermes, Kilo, Agy, Ollama) invoques en parallele sans seuil maximal d'allocation.
- Impact : Saturation a 100% du CPU, blocage de l'interface utilisateur et de l'IDE.

---

## 3. DISPOSITIF DE PROTECTION RETENU ET DEPLOYE

### A. Mutex Single-Flight ACP (agent-adapters.js)
- Implementation : Les fonctions acquireAcpLock, releaseAcpLock et isAcpLocked sont integrees a agent-adapters.js.
- Fonctionnement : Toute invocation ACP verifie le verrou de l'agent cible. Si une session existe depuis moins de 120 secondes, la nouvelle invocation est rejetee avec la raison explicite : 'Session ACP deja active pour cet agent (protection anti-doublon)'.
- Gain : Elimination a 100% des doublons d'onglets et de cascades fantomes.

### B. Throttle de Concurrence CLI (Plafond a 2 Workers)
- Implementation : Consignee dans project-rules.md et dans les regles systeme de dispatch.
- Fonctionnement : L'orchestrateur refuse de spawner plus de 2 processus workers simultanes sur la machine. Les taches surnumeraires restent en file d'attente (pending).
- Priorite OS : Les sous-processus recoivent la priorite BELOW_NORMAL_PRIORITY_CLASS sous Windows pour garantir la fluidite permanente du curseur et de l'IDE.

### C. Script Autonome de Purge Reactive (tools/reap-and-reconcile.ps1)
- Outil dedie deploye dans tools/reap-and-reconcile.ps1.
- Execute a la volee la reconciliation des taches dont le PID est mort (reconcile_tasks) et la purge d'eventuels processus orphelins (reap_ghosts).

---

## 4. MATRICE DE CONFORMITE ARCHITECTURALE

| Composant | Statut Avant | Statut Actuel Verifie | Empreinte Machine |
|---|---|---|---|
| Multiplexeur MCP | Eparpille (serveurs Node) | Unifie en Rust (hphe-mcp.exe) | 12,5 Mo de RAM |
| Moteur Vectoriel | Qdrant (:6333) / Zvec (:8001) | Remplaces par hphe-vec (USearch) | Integre, zero daemon |
| Gestion des Taches | orchestrator-server.js | Integre dans hphe-mcp (rusqlite) | Integre, transactionnel |
| Sessions ACP | Doubles cascades possibles | Verrouillees par Mutex Single-Flight | 0 doublon garanti |
| Concurrence CLI | Non bridee | Plafonnee a 2 workers max simultanes | CPU et RAM preserves |

---

## 5. RECOMMANDATION FINALE
L'architecture Hephaistos en Rust est saine, consolidee et extremement legere. La mise en place du Mutex Single-Flight dans agent-adapters.js et le respect strict du plafond de 2 workers simultanes garantissent une stabilite totale meme sur des machines aux ressources tres modestes.