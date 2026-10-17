# Prompt à coller tel quel à l'agent du collègue

> Copier tout le bloc ci-dessous. L'agent doit exécuter chaque étape,
> produire un tableau PASS/FAIL à la fin, et ne **rien** inventer.

---

```text
MISSION : vérifier et compléter l'installation Hephaistos2-Kit sur cette
machine pour qu'elle soit conforme à la référence. Tu travailles en
LECTURE D'ABORD, tu ne modifies que ce qui est manquant ou non conforme.
Ne devine jamais un chemin, un ID de session ou un provider : tout est
détecté par les scripts du repo.

ÉTAPE 0 — Localiser le clone
- Le repo hephaistos2-kit est déjà cloné sur cette machine. Si tu ne sais
  pas où : demande-moi le chemin. Toutes les commandes ci-dessous se
  lancent depuis <REPO> = racine du clone (où se trouve install.ps1).

ÉTAPE 1 — État du repo
  cd <REPO>
  git pull
  git submodule update --init --recursive
- Vérifie : extensions/orchestrator-monitor/package.json → version 0.0.59.
- Vérifie : hphe/Cargo.toml existe (sous-module non vide). Sinon FAIL.

ÉTAPE 2 — Dépendances bridge
  cd <REPO>\.agent\agent-bridge
  npm install --omit=dev
- Vérifie : node_modules\ws existe. Sans lui binome.js plante.

ÉTAPE 3 — Install en lecture seule, puis réelle
  cd <REPO>
  pwsh -ExecutionPolicy Bypass -File install.ps1 -CheckOnly
- Rapporte chaque [WARN]/[FAIL]. Ensuite :
  pwsh -ExecutionPolicy Bypass -File install.ps1
- Ne touche à AUCUN fichier de config existant qui n'est pas prévu par
  install.ps1. Ne supprime jamais une politique .mcp-access déployée.

ÉTAPE 3b — Agents ACP dans Devin (LE POINT QUE TON INSTALL MANQUAIT)
  cd <REPO>
  node .agent\setup\setup-devin-acp.mjs --verify
- Si [VERIFY] conforme → passe à l'étape 4. Sinon :
  node .agent\setup\setup-devin-acp.mjs
- Ce script provisionne `devin.acp.enabledAgents`, `devin.acp.agentEnv`
  (PATH augmenté des binaires détectés), `devin.acp.agentPreferences` et
  `devin.acp.preferredAgent` dans %APPDATA%\devin\User\settings.json —
  avec backup automatique et merge non-destructif.
- SANS ces clés, aucun provider ACP ne peut recevoir session/load → aucun
  ACK → aucun binôme. C'est LE point de défaillance classique.
- Après écriture : recharge la fenêtre Devin.
- Vérifie ensuite : les providers listés ont un binaire détecté
  (colonne `binaire=`). `—` pour opencode/hermes/etc. = CLI absent de la
  machine, à installer avant de pouvoir le joindre.

ÉTAPE 4 — Extension monitor 0.0.59
  pwsh -ExecutionPolicy Bypass -File .agent\setup\install-extension-hub.ps1 -CheckOnly
- Attendu : orchestrator-monitor 0.0.59 détectée. Sinon installe
  extensions\orchestrator-monitor\orchestrator-monitor-0.0.59.vsix
  dans %USERPROFILE%\.devin\extensions\hephaistos.orchestrator-monitor-0.0.59
  (le VSIX contient extension\ à la racine de l'archive).
- Vérifie : %USERPROFILE%\.devin\extensions\hephaistos.orchestrator-monitor-0.0.59\node_modules\ws\package.json EXISTE.
  S'il manque, le VSIX est défectueux → FAIL, ne le bricole pas à la main,
  repackage avec `npm run release` depuis extensions/orchestrator-monitor.
- Puis : recharge la fenêtre Devin (Ctrl+Shift+P → Developer: Reload Window).

ÉTAPE 5 — Règles et skills GLOBALES (pour TOUS les clients)
  pwsh -ExecutionPolicy Bypass -File .agent\setup\setup-agent-surfaces.ps1
  pwsh -ExecutionPolicy Bypass -File .agent\setup\setup-agent-surfaces.ps1 -Verify
- Attendu : 6x [OK]. Le script propage .agent/rules/global_rules.md vers :
    %USERPROFILE%\.config\devin\global_rules.md        (Devin CLI)
    %USERPROFILE%\.claude\CLAUDE.md                   (Devin IDE, bloc marqué)
    %USERPROFILE%\.codeium\windsurf\memories\global_rules.md
    %USERPROFILE%\.gemini\config\rules\global_rules.md (ou GEMINI.md)
  et les skills /chat-id + /jointes vers :
    %APPDATA%\devin\skills\         (Devin global)
    %USERPROFILE%\.gemini\config\skills\  (Antigravity global)
- Chaque cible DOIT exister sur disque. Un [FAIL] = corriger puis relancer -Verify.

ÉTAPE 6 — Canal binôme
  pwsh -ExecutionPolicy Bypass -File .agent\setup\setup-devin-binome.ps1 -Verify
- Attendu : [OK] partout. Un WARN "aucun pair frais" est NORMAL si aucun
  /jointes n'a été lancé — ne crée pas de pair toi-même.

ÉTAPE 7 — Inventaire ACP (lecture seule)
  cd <REPO>\.agent\agent-bridge
  node devin-hub.js acp-list
- Liste les providerId/sessionId ACP réellement activés du workspace.
  NE JAMAIS deviner d'ID : seuls ceux listés ici existent.

ÉTAPE 8 — Tests ping-pong
  cd <REPO>
  pwsh -ExecutionPolicy Bypass -File tutorial-pour-les-nuls\scripts\2-verifie-tout.ps1
  pwsh -ExecutionPolicy Bypass -File tutorial-pour-les-nuls\scripts\3-teste-le-ping-pong.ps1

RÈGLES STRICTES (protocole binôme — non négociable)
- /chat-id est lecture seule : ID de la session focalisée EXACTE ; si
  ambiguïté, demander un ID, jamais choisir la plus récente.
- Un join n'est déclaré réussi qu'après request/ACK frais corrélés par
  pairId avec established:true. Le hint seul ne prouve rien.
- Transports hub / acp / cli strictement séparés, aucun fallback.
- AGY hub : --model obligatoire (label Gemini/AGY exact), jamais Argon
  par défaut.
- ACP : uniquement un couple providerId/sessionId exact, activé, rattaché
  au workspace. Jamais de session/new, de conversation de remplacement,
  de toast ou de presse-papiers.
- Les workers NIM1/NIM2 (API directe) ne sont PAS des sessions ACP.
- Aucun token CSRF ni clé API ne doit apparaître dans ta sortie.

LIVRABLE : un tableau | Étape | PASS/FAIL | Preuve (sortie courte) |
puis la liste exacte de ce qui reste à corriger. Pas de "ça devrait
marcher" — uniquement des faits vérifiés.
```

---

## Résumé des cibles à vérifier (aide-mémoire)

| Élément            | Chemin attendu                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| VSIX source          | `<REPO>\extensions\orchestrator-monitor\orchestrator-monitor-0.0.59.vsix`                                                                    |
| Extension installée | `%USERPROFILE%\.devin\extensions\hephaistos.orchestrator-monitor-0.0.59\` (+ `node_modules\ws`)                                            |
| Règles Devin CLI    | `%USERPROFILE%\.config\devin\global_rules.md`                                                                                                |
| Règles Devin IDE    | `%USERPROFILE%\.claude\CLAUDE.md` (bloc marqué `HEPHAISTOS`)                                                                              |
| Règles Windsurf     | `%USERPROFILE%\.codeium\windsurf\memories\global_rules.md`                                                                                   |
| Règles AGY          | `%USERPROFILE%\.gemini\config\rules\global_rules.md` ou `GEMINI.md`                                                                        |
| Skills Devin         | `%APPDATA%\devin\skills\{chat-id,jointes}\SKILL.md`                                                                                          |
| Skills AGY           | `%USERPROFILE%\.gemini\config\skills\{chat-id,jointes}\SKILL.md`                                                                             |
| ws bridge            | `node_modules\ws` dans `<REPO>\.agent\agent-bridge\`                                                                                       |
| Scripts vérif       | `install.ps1 -CheckOnly`, `setup-agent-surfaces.ps1 -Verify`, `setup-devin-binome.ps1 -Verify`, `install-extension-hub.ps1 -CheckOnly`, `node .agent/setup/setup-devin-acp.mjs --verify` |
| Agents ACP Devin    | `devin.acp.*` dans `%APPDATA%\devin\User\settings.json` — provisionné par `setup-devin-acp.mjs` (appelé aussi par `install.ps1`) |
