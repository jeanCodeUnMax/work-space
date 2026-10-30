# SWAT Fix-Rapide / Audit Sécurité — Rapport d'Audit

**Fichiers cibles (non fournis au worker) :**
- `C:/Program Files/Projet-complet/hephaistos2-kit/.agent/agent-bridge/agy-hub.js`
- `C:/Program Files/Projet-complet/hephaistos2-kit/extensions/orchestrator-monitor/src/extension.ts`

---

## ⚠️ VERDICT : **AUDIT IMPOSSIBLE — FICHIERS SOURCES MANQUANTS**

Le worker **n'a aucun accès au système de fichiers** (règle absolue : pas d'outils, pas de lecture fichier). Les contenus des deux fichiers à auditer n'ont pas été fournis dans le contexte de la tâche.

---

## 🔍 POINTS DE CONTRÔLE DEMANDÉS (checklist pour ré-audit une fois fichiers fournis)

| # | Zone | Critère | Preuve attendue (n° ligne) |
|---|------|---------|----------------------------|
| 1 | `agy-hub.js` → `sendMessage` | `SetBrowserOpenConversation` **uniquement** si `AGY_FOCUS=1` | `if (process.env.AGY_FOCUS === '1')` |
| 2 | `agy-hub.js` → `ask` | Logs `agent-reply` / `agent-error` ; réponses vides filtrées | `console.log('[agent-reply]', ...)` + `if (!reply?.trim()) return` |
| 3 | `agy-hub.js` → `listHubs` / `pickHub` | Aucune interpolation shell non échappée | `spawn(cmd, args)` jamais `exec(\`cmd ${input}\`)` |
| 4 | `extension.ts` → `wakeAntigravity` | Garde `AGY_FOCUS=1` respectée | `if (process.env.AGY_FOCUS !== '1') return` |
| 5 | **Commun** | Aucune fuite secret (CSRF, API keys) dans `stdout` / comms | Grep `csrf`, `api[_-]?key`, `token`, `secret` → 0 occurrence |
| 6 | **Commun** | Aucune ouverture fenêtre non voulue | Pas de `window.open`, `vscode.window.showInformationMessage` hors garde |
| 7 | **Commun** | Voie *draft* intacte (pas d'écriture directe en prod) | Chemins `draft/` ou `.draft` utilisés, pas de `writeFileSync(prodPath)` |

---

## 📝 CORRECTIONS TYPE PROPOSÉES (patterns sécurisés)

```js
// agy-hub.js — sendMessage (exemple)
async function sendMessage(hub, text) {
  if (process.env.AGY_FOCUS !== '1') return; // garde
  // spawn uniquement, argv array — JAMAIS template string dans shell
  const { spawn } = require('child_process');
  const child = spawn('agy-cli', ['send', '--hub', hub, '--text', text], { stdio: 'ignore' });
  child.unref();
}

// ask — filtrage réponses vides + logs structurés
async function ask(hub, prompt) {
  const reply = await ipcRequest(hub, 'ask', { prompt });
  if (!reply?.content?.trim()) {
    console.log('[agent-reply]', { hub, status: 'empty-filtered' });
    return null;
  }
  console.log('[agent-reply]', { hub, length: reply.content.length });
  return reply.content;
}

// extension.ts — wakeAntigravity
export function wakeAntigravity() {
  if (process.env.AGY_FOCUS !== '1') return; // garde stricte
  // logique antigravity ici — pas de window.open sans garde
}
```

---

## 🚀 PROCHAINE ÉTAPES REQUISES

1. **Fournir les deux fichiers sources** (contenu brut) au worker via le dispatcher.
2. Le worker relancera l'audit ligne par ligne avec numéros de ligne exacts.
3. Livraison finale : `C:/Program Files/Projet-complet/hephaistos2-kit/.agent/reports/swat-fix-audit.md`

---

**Taille du rapport** : ~1.2 KB  
**Statut** : *En attente des artefacts sources*
