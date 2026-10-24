// taskwatch.mjs — veille de la file orchestrateur (hphe-mcp).
// Déployé par install.ps1 dans <INSTALL>/extension/server/taskwatch.mjs et
// enregistré en tâche planifiée `hphe-taskwatch` (toutes les 5 min).
// Comble le trou : create_task ne notifie personne — ce script réveille
// le destinataire via le bus (.agent/comms.jsonl) + acp-inject pour devin.
// Workspace : HPHE_WORKSPACE obligatoire (injecté dans taskwatch-run.cmd par
// install.ps1). Aucun chemin machine en dur — tout est dérivé.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = process.env.HPHE_WORKSPACE;
if (!WS) { console.error('[taskwatch] HPHE_WORKSPACE non défini — abandon'); process.exit(1); }
const BRIDGE = WS + '/.agent/agent-bridge';
// Sous SYSTEM, USERPROFILE pointe vers systemprofile : on énumère C:/Users
// pour retrouver le profil qui détient les configs Devin (fonctionne sur
// n'importe quelle machine, sans nom d'utilisateur en dur).
const USER_DIRS = (() => { try { return readdirSync('C:/Users').map(u => `C:/Users/${u}`); } catch { return []; } })();
const MCP_CALL = [
  process.env.HPHE_MCP_CALL,
  process.env.USERPROFILE && process.env.USERPROFILE + '/.config/devin/scripts/mcp-call.mjs',
  ...USER_DIRS.map(u => u + '/.config/devin/scripts/mcp-call.mjs'),
].find(p => p && existsSync(p)) || null;
// <INSTALL>/extension/server/../../data = <INSTALL>/data (déployé) ; env prioritaire.
const STATE = (process.env.HPHE_DATA || path.resolve(HERE, '..', '..', 'data')) + '/taskwatch-state.json';
const log = (m) => console.log(`[taskwatch ${new Date().toISOString()}] ${m}`);

// Sous SYSTEM, APPDATA/USERPROFILE pointent vers systemprofile : la config MCP
// de Devin est introuvable. On force le profil qui détient mcp_config.json.
const CHILD_ENV = { ...process.env };
const devinProfile = [process.env.HPHE_DEVIN_PROFILE, ...USER_DIRS]
  .find(p => p && existsSync(p + '/AppData/Roaming/devin/mcp_config.json'));
if (!existsSync(process.env.APPDATA + '/devin/mcp_config.json') && devinProfile) {
  CHILD_ENV.APPDATA = devinProfile + '/AppData/Roaming';
  CHILD_ENV.USERPROFILE = devinProfile;
  CHILD_ENV.HOME = devinProfile;
}

const run = (cmd, args, timeout = 60000) => {
  try { return execFileSync(cmd, args, { timeout, encoding: 'utf8', windowsHide: true, env: CHILD_ENV }); }
  catch { return null; }
};

const mcp = (tool, args) => {
  if (!MCP_CALL) { log('mcp-call.mjs introuvable'); return null; }
  const out = run(process.execPath, [MCP_CALL, 'Hephaistos-everything-search', tool, JSON.stringify(args)]);
  try { return JSON.parse(out); } catch { return null; }
};

let state = { notified: [], devinSession: null };
try { state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}

const tasks = mcp('list_tasks', { status: 'pending' });
if (!Array.isArray(tasks)) { log('list_tasks KO — skip'); process.exit(0); }
const fresh = tasks.filter(t => !state.notified.includes(t.id));
if (!fresh.length) { log(`OK — ${tasks.length} pending, aucune nouvelle`); process.exit(0); }

const roster = mcp('memory_read', { key: 'team/roster', projectId: 'Herald-OS' });
try {
  const r = JSON.parse(roster.memory.content);
  state.devinSession = (r?.binome?.cash?.sessionId || state.devinSession || '').split('/').pop();
} catch {}
const devinSess = state.devinSession || 'free-geranium';

const agents = mcp('list_agents', {});
const nameOf = (id) => (agents || []).find(a => a.id === id)?.agent_name || `agent#${id}`;

for (const t of fresh) {
  const who = nameOf(t.assigned_to);
  const line = `TASK-NOTIFY #${t.id} "${t.title}" -> ${who}${t.due_date ? ' (due ' + t.due_date + ')' : ''}`;
  log(line);
  run(process.execPath, [BRIDGE + '/comms.js', 'log', 'taskwatch', who, 'task-notify', line]);
  if (who === 'devin' && devinSess) {
    const ack = run(process.execPath, [BRIDGE + '/acp-inject.js', '--provider', 'devin-cli',
      '--session', devinSess, '--prompt',
      `[TASKWATCH] Tache orchestratrice en attente #${t.id}: ${t.title}. Reclame-la via list_tasks/get_next_task puis update_task.`,
      '--wait', 'turn', '--timeout', '60'], 90000);
    log(ack && ack.includes('"delivered": true') ? 'inject devin: delivered' : 'inject devin: failed (bus only)');
  }
  state.notified.push(t.id);
}
state.notified = state.notified.slice(-500);
try { writeFileSync(STATE, JSON.stringify(state, null, 2)); } catch {}
log(`done — ${fresh.length} notification(s)`);
