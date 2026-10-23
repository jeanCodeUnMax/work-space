// taskwatch.mjs — veille de la file orchestrateur (hphe-mcp).
// Déployé par install.ps1 dans <INSTALL>/extension/server/taskwatch.mjs et
// enregistré en tâche planifiée `hphe-taskwatch` (toutes les 5 min).
// Comble le trou : create_task ne notifie personne — ce script réveille
// le destinataire via le bus (.agent/comms.jsonl) + acp-inject pour devin.
// Workspace résolu via HPHE_WORKSPACE, sinon le projet canonique.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const WS = process.env.HPHE_WORKSPACE || 'F:/Promgramation-teste/Herald-OS';
const BRIDGE = WS + '/.agent/agent-bridge';
// SYSTEM n'a pas le meme USERPROFILE — resoudre mcp-call.mjs par candidats.
const MCP_CALL = [
  process.env.HPHE_MCP_CALL,
  process.env.USERPROFILE && process.env.USERPROFILE + '/.config/devin/scripts/mcp-call.mjs',
  'C:/Users/Administrator/.config/devin/scripts/mcp-call.mjs',
].find(p => p && existsSync(p)) || null;
const STATE = (process.env.HPHE_DATA || 'C:/Program Files/servers/hephaistos2-kit/data') + '/taskwatch-state.json';
const log = (m) => console.log(`[taskwatch ${new Date().toISOString()}] ${m}`);

// Sous SYSTEM, APPDATA/USERPROFILE pointent vers systemprofile : la config MCP
// de Devin est introuvable. On force le profil qui detient mcp_config.json.
const CHILD_ENV = { ...process.env };
if (!existsSync(process.env.APPDATA + '/devin/mcp_config.json')
    && existsSync('C:/Users/Administrator/AppData/Roaming/devin/mcp_config.json')) {
  CHILD_ENV.APPDATA = 'C:/Users/Administrator/AppData/Roaming';
  CHILD_ENV.USERPROFILE = 'C:/Users/Administrator';
  CHILD_ENV.HOME = 'C:/Users/Administrator';
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
