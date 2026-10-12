// Propage le CANON AGY≠GEMINI + provider_prefs dans toutes les copies de global_rules.md
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const FILES = [
  'F:/Promgramation-teste/Hephaistos-Kit/.agent/rules/global_rules.md',              // master (déjà patché)
  'F:/Promgramation-teste/Hephaistos-Kit/cli/opencli-cookies/.agent/rules/global_rules.md',
  'F:/Promgramation-teste/Hephaistos-Kit/mcp/servers/nim-router-mcp/.agent/rules/global_rules.md',
  'F:/Promgramation-teste/Hephaistos-Kit/mcp/servers/orchestrator-server/.agent/rules/global_rules.md',
  'C:/Users/Administrator/.codeium/windsurf/memories/global_rules.md',
  'C:/Users/Administrator/.config/devin/global_rules.md',
];

const CANON = `### ⛩️ CANON (2026-10-08) — AGY ≠ GEMINI, deux canaux distincts

- **AGY / Antigravity** = l'extension IDE \`google.google-antigravity\` + son CLI \`agy.exe\` (\`%LOCALAPPDATA%\\agy\\bin\`) + son hub local (\`--hub-port\`). Abonnement. Routage réponse : \`[agycascade:<uuid>]\`. **Jamais appelé "gemini".**
- **Gemini CLI** = \`@google/gemini-cli\` (\`gemini.cmd\`), authentifié par **\`GEMINI_API_KEY\`** (env) + \`~/.gemini/settings.json\` → \`selectedType: "gemini-api-key"\` → API Developer. Headless OK (\`gemini -p\`, exit 0).
- Aucun recouvrement : une demande « gemini » n'est PAS « agy », et réciproquement.

### ⛩️ CANON — l'ordre des providers vient du MONITOR

La table **\`provider_prefs\`** (\`orchestrator.db\`), réglée dans l'extension **orchestrator-monitor** (toggles + glisser-déposer), est la **source de vérité runtime** de la chaîne de providers — \`enabled=0\` → sauté, \`position\` → priorité ; dérogation uniquement sur demande explicite de l'utilisateur. Clés : NIM1 = directs, NIM2 = agents, GEMINI_API_KEY = gemini-cli.

`;

const OLD_GEMINI = /\*\*Gemini CLI\*\*[^\n]*/;
const NEW_GEMINI = '**Gemini CLI** : headless OK via `GEMINI_API_KEY` + `selectedType:"gemini-api-key"` (`gemini -p` → exit 0). `oauth-personal` MORT (IneligibleTierError) — voir CANON.';
const OLD_CONFUSE = /⚠️ Ne PAS confondre avec `gemini` CLI stock[^\n]*/;
const NEW_CONFUSE = '⚠️ `agy` ≠ `gemini` : deux canaux distincts — voir CANON.';
const OLD_BLOCKED = /gemini CLI stock bloqué/g;

for (const f of FILES) {
  let t;
  try { t = readFileSync(f, 'utf8'); } catch { console.log('SKIP absent:', f); continue; }
  let c = t;
  if (!/CANON.*AGY ≠ GEMINI/.test(c)) {
    const anchor = c.match(/### RÈGLE FONDAMENTALE/);
    if (anchor) c = c.replace(/### RÈGLE FONDAMENTALE/, CANON + '### RÈGLE FONDAMENTALE');
    else c += '\n\n---\n\n' + CANON;
  }
  c = c.replace(OLD_GEMINI, NEW_GEMINI).replace(OLD_CONFUSE, NEW_CONFUSE).replace(OLD_BLOCKED, 'gemini CLI stock : mode api-key requis');
  if (c !== t) { copyFileSync(f, f + '.bak-' + Date.now()); writeFileSync(f, c); console.log('PATCHED:', f); }
  else console.log('DÉJÀ CONFORME:', f);
}
