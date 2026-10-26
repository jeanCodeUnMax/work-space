# Verdict de faisabilité : hephaistos2-kit → Plugin Devin

**VERDICT : FAISABLE-CONDITIONS**  
L'intégration est techniquement réalisable mais nécessite des conditions de sécurité, de cycle de vie et de normalisation des données avant déploiement en production.

---

## Options d'architecture (3-4)

| Option | Pour | Contre |
|--------|------|--------|
| **1. Plugin + IPC direct vers hphe-mcp.exe**<br>Le plugin Devin lance `hphe-mcp.exe` en processus enfant et communique via stdin/stdout ou named pipe. Les 58 outils sont exposés directement. | Intégration serrée, aucun intermédiaire, réutilisation immédiate des outils existants. | Gestion du cycle de vie du processus depuis le plugin, risque d'oubli d'arrêt propre, dépendance au contexte utilisateur local. |
| **2. Hybridation extension VS Code ↔ Plugin Devin**<br>L'extension `hephaistos-chats` reste interface UI/Chat, le plugin ajoute une barre d'actions rapides et des compétences Devin. | Repose sur l'UI existante, minimise les refontes, utilisateur garde ses workflows habituels. | Double maintenance UI, synchronisation des états (canvas React Flow vs panneaux Devin), potentielle redondance de commandes. |
| **3. Gateway MCP proxy**<br>Le plugin expose un gateway léger (HTTP/named-pipe) qui forward les requêtes vers `hphe-mcp.exe` distant ou local. | Isole le plugin du démarrage direct de processus lourd, permet exécution distante, surface de sécurité contrôlée. | Latence ajoutée, surface d'attaque accrue, besoin de confiance dans le gateway, complexité de déploiement. |
| **4. Couche de normalisation des skills**<br>Un module de mapping traduit les formats internes `.agent/skills` vers des schémas JSON compatibles Devin avant exposition. | Abstraction propre, futur-proof, cache les complexités des 58 outils derrière des contrats stables. | Effort de développement pour normaliser formats, risque de perte de fonctionnalités fines des outils originaux. |

---

## Risques majeurs

- **Sécurité / Privilèges** : Exposition de 58 outils Rust dont certains accèdent au système de fichiers NTFS ; nécessite sandboxing strict et validation utilisateur par action.
- **Cycle de vie du MCP** : Démarrage/arrêt/redémarrage de `hphe-mcp.exe` mal géré peut laisser des processus fantômes ou verrouiller des ressources.
- **Sérialisation des compétences** : Formats internes aux modules `.agent/skills` (notamment `bleubite-dispatch`, `flux`) peuvent nécessiter des transformations lourdes pour matcher les schémas attendus par Devin.
- **Conflits extension ↔ plugin** : Redondance potentielle de commandes slash, de points d'entrée UI, et de gestion de contexte entre l'extension VS Code et le plugin Devin.

---

## Questions tranchées à décider avec le commandant

1. **Mode exécution du MCP** : `hphe-mcp.exe` doit-il être lancé automatiquement par le plugin à chaque session Devin, ou rester en service système indépendant avec gestion à la demande ?
2. **Normalisation des skills** : Les formats de données des skills `.agent/skills` doivent-ils être adaptés/standardisés avant exposition plugin, ou le plugin accepte-t-il les formats bruts via un wrapper ?
3. **Synchronisation état UI** : Existe-t-il un besoin de partager l'état du canvas React Flow ou les conversations chat entre extension et plugin ? Dans l'affirmative, quel mécanisme (mémoire partagée, fichier de état commun, RPC) est privilégié ?
4. **Permissions utilisateur** : Les outils NTFS de `hphe-mcp.exe` auront-ils les droits requis automatiquement dans le contexte d'exécution du plugin, ou faut-il préconfigurer des élévations de privilèges dans le manifeste Devin ?

---

*Livrable généré : `.agent/flux/feas-verdict.md`*
