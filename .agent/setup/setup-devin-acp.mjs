#!/usr/bin/env node
// setup-devin-acp.mjs — provisionne les agents ACP dans les settings Devin IDE.
//
// Cible : %APPDATA%\devin\User\settings.json (JSONC toléré : commentaires +
// virgules finales stripped avant parse).
//
// Ce que ce script garantit (merge non-destructif, --force pour écraser) :
//   devin.acp.enabledAgents     — providers du kit activés/désactivés
//   devin.acp.agentEnv          — PATH augmenté des binaires détectés
//   devin.acp.agentPreferences  — entrées créées si absentes (pas de modèle
//                                 par défaut : choisi dans l'UI, lié au compte)
//   devin.acp.preferredAgent    — défini seulement si absent
//
// Usage : node setup-devin-acp.mjs [--verify] [--force] [--preferred <id>]
//                                [--settings <path>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const VERIFY = has('--verify');
const FORCE = has('--force');
const SETTINGS = opt('--settings',
  path.join(process.env.APPDATA || '', 'devin', 'User', 'settings.json'));

// Providers reconnus par le kit (miroir de la config de référence).
const KIT_ENABLED = {
  'devin-cli': true, 'devin-cloud': true, 'opencode': true,
  'antigravity-acp': true, 'hermes': true, 'mistral-vibe': true,
  'openrouter': true, 'ollama': true, 'nim': true, 'nim2': true,
  'kilo': false, 'gemini': false, 'cline': false, 'vtcode': false,
  'codex-acp': false, 'huggingface': false,
};

// Providers qui reçoivent un PATH augmenté (mêmes que la config de référence).
const KIT_ENV_PROVIDERS = [
  'antigravity-acp', 'opencode', 'openrouter', 'ollama',
  'nim', 'nim2', 'kilo', 'mistral-vibe',
];

// Modes sûrs quand une entrée de prefs est créée ex nihilo (jamais de modèle
// codé : il dépend du compte/abonnement de l'utilisateur).
const KIT_PREF_DEFAULTS = {
  'devin-cli': { mode: 'accept-edits' },
  'hermes': { mode: 'build' },
  'ollama': { mode: 'build' },
  'nim': { mode: 'build' },
  'nim2': { mode: 'build' },
  'antigravity-acp': { mode: 'default' },
};

// Dossiers probables des connecteurs ACP — seuls ceux qui EXISTENT sont
// injectés dans le PATH des agents.
const ENV_DIRS = [
  '%LOCALAPPDATA%\\agy\\bin',
  '%LOCALAPPDATA%\\Programs\\agy-acp',
  '%LOCALAPPDATA%\\hermes\\bin',
  '%LOCALAPPDATA%\\hermes\\node',
  '%USERPROFILE%\\.opencode\\bin',
  '%LOCALAPPDATA%\\Programs\\opencode',
  '%LOCALAPPDATA%\\Programs\\vibe',
  '%USERPROFILE%\\.grok\\bin',
  '%LOCALAPPDATA%\\FreeToken\\bin',
].map((p) => p.replace(/%(\w+)%/g, (_, v) => process.env[v] || ''))
  .filter((p) => p && !p.includes('%'));

// Binaires à détecter pour la table --verify (sonde PATH + ENV_DIRS).
const BINARIES = {
  'opencode': 'opencode.exe',
  'antigravity-acp': 'agy_acp_server.exe',
  'hermes': 'hermes.exe',
  'kilo': 'kilo.exe',
  'mistral-vibe': 'vibe-acp.exe',
};

// --- JSONC → JSON -------------------------------------------------------------
function stripJsonc(src) {
  let out = '';
  let i = 0, inStr = false, q = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; }
      else if (c === q) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function findBinary(name) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).filter(Boolean);
    if (out.length) return out[0];
  } catch { /* not on PATH */ }
  for (const d of ENV_DIRS) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function augmentPath() {
  const found = ENV_DIRS.filter((d) => fs.existsSync(d));
  return [...found, process.env.PATH || ''].join(';');
}

// --- main ---------------------------------------------------------------------
if (!fs.existsSync(SETTINGS)) {
  console.error(`[FAIL] settings.json introuvable : ${SETTINGS}`);
  console.error('       (Devin Desktop doit avoir été lancé au moins une fois)');
  process.exit(1);
}

const raw = fs.readFileSync(SETTINGS, 'utf8');
let settings;
try {
  settings = JSON.parse(stripJsonc(raw));
} catch (e) {
  console.error(`[FAIL] settings.json non parsable (${e.message}) — corrige-le à la main, je n'écris rien.`);
  process.exit(1);
}

const enabled = settings['devin.acp.enabledAgents'] || {};
const env = settings['devin.acp.agentEnv'] || {};
const prefs = settings['devin.acp.agentPreferences'] || {};
const preferred = settings['devin.acp.preferredAgent'];

const rows = [];
const newPath = augmentPath();
let changed = 0;

for (const [provider, want] of Object.entries(KIT_ENABLED)) {
  const cur = enabled[provider];
  const binary = BINARIES[provider] ? findBinary(BINARIES[provider]) : null;
  const status = cur === want ? 'OK' : 'DIFF';
  rows.push({ provider, want, cur: cur === undefined ? '(absent)' : cur, binary: binary || '—', status });
  if (status === 'DIFF' && (FORCE || cur === undefined || want === true)) {
    enabled[provider] = want; changed++;
  } else if (FORCE && cur !== want) {
    enabled[provider] = want; changed++;
  }
}

// agentEnv : PATH augmenté pour les providers kit (créé si absent ; PATH
// réécrit seulement en --force ou si absent).
for (const p of KIT_ENV_PROVIDERS) {
  if (!env[p] || FORCE) { env[p] = { PATH: newPath }; changed++; }
  else if (!env[p].PATH) { env[p].PATH = newPath; changed++; }
}

// agentPreferences : crée les entrées manquantes, n'écrase jamais un modèle.
for (const [p, def] of Object.entries(KIT_PREF_DEFAULTS)) {
  if (!prefs[p]) { prefs[p] = def; changed++; }
  else { for (const [k, v] of Object.entries(def)) if (prefs[p][k] === undefined) { prefs[p][k] = v; changed++; } }
}

let prefAction = 'conservé';
if (!preferred) {
  const want = opt('--preferred') || (enabled['opencode'] && findBinary(BINARIES['opencode']) ? 'opencode' : 'devin-cli');
  settings['devin.acp.preferredAgent'] = want; prefAction = `défini → ${want}`; changed++;
}

console.log('\n=== devin.acp.enabledAgents ===');
for (const r of rows) {
  const tag = r.status === 'OK' ? '[OK]  ' : '[DIFF]';
  console.log(`${tag} ${r.provider.padEnd(16)} activé=${String(r.cur).padEnd(8)} attendu=${r.want}  binaire=${r.binary}`);
}
console.log(`preferredAgent : ${preferred ?? '(absent)'} (${prefAction})`);
console.log(`env providers  : ${KIT_ENV_PROVIDERS.filter((p) => env[p]).length}/${KIT_ENV_PROVIDERS.length} couverts`);

if (VERIFY) {
  const bad = rows.filter((r) => r.status === 'DIFF').length;
  console.log(bad === 0 ? '\n[VERIFY] conforme' : `\n[VERIFY] ${bad} provider(s) non conforme(s) — relance sans --verify`);
  process.exit(bad === 0 ? 0 : 1);
}

if (!changed) { console.log('\nRien à écrire — déjà conforme.'); process.exit(0); }

settings['devin.acp.enabledAgents'] = enabled;
settings['devin.acp.agentEnv'] = env;
settings['devin.acp.agentPreferences'] = prefs;

const bak = `${SETTINGS}.bak-acp-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(SETTINGS, bak);
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`\nÉcrit ${SETTINGS} (${changed} changement(s)), backup → ${path.basename(bak)}`);
console.log('Recharge la fenêtre Devin (Ctrl+Shift+P → Developer: Reload Window) pour appliquer.');
