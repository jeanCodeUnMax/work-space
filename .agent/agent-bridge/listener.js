#!/usr/bin/env node
// agent-ws-bridge — écoute ws://127.0.0.1:7477 (orchestrator-monitor bridge)
// et imprime des tags console pour réveiller l'agent qui le lance en tâche de fond.
// Usage : node listener.js [--agent Devin] [--tasks 84,85] [--url ws://127.0.0.1:7477] [--quiet]
//
// Tags émis :
//   [WS-OPEN]      connexion établie
//   [WS-SNAPSHOT]  résumé au branchement / changement agents (sauf --quiet)
//   [WS-TASK]      chaque transition de tâche : [WS-TASK] #85 in_progress -> completed
//   [WS-WAKE]      transition TERMINALE (completed/failed) — le réveil proprement dit
//   [WS-EVENT]     événements annexes (clear_result)
//   [WS-CLOSE]/[WS-ERR]  perte/erreur connexion (retry auto toutes les 3s)

const args = process.argv.slice(2);
const opt = { agent: 'agent', url: 'ws://127.0.0.1:7477', tasks: null, quiet: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent') opt.agent = args[++i];
  else if (args[i] === '--url') opt.url = args[++i];
  else if (args[i] === '--tasks') opt.tasks = new Set(args[++i].split(',').map(s => parseInt(s, 10)));
  else if (args[i] === '--quiet') opt.quiet = true;
}

let WebSocket;
try { WebSocket = require('ws'); }
catch {
  // fallback : ws du monitor installé ou du repo
  for (const p of [
    'F:/Promgramation-teste/Hephaistos-Kit/extensions/orchestrator-monitor/ws-bridge/node_modules/ws',
    `${process.env.USERPROFILE}/.devin/extensions/hephaistos.orchestrator-monitor-0.0.15/ws-bridge/node_modules/ws`,
    `${process.env.USERPROFILE}/.devin/extensions/hephaistos.orchestrator-monitor-0.0.14/ws-bridge/node_modules/ws`,
  ]) { try { WebSocket = require(p); break; } catch {} }
}
if (!WebSocket) { console.error('[WS-ERR] module "ws" introuvable — npm i ws'); process.exit(2); }

const TERMINAL = new Set(['completed', 'failed']);
const lastStatus = new Map();
let ws, retry = null;

function tag(name, msg) {
  console.log(`${name} ${new Date().toISOString().slice(11, 19)} [${opt.agent}] ${msg}`);
}

function taskLine(t) {
  const prev = lastStatus.get(t.id);
  lastStatus.set(t.id, t.status);
  const arrow = prev && prev !== t.status ? `${prev} -> ${t.status}` : t.status;
  const line = `#${t.id} ${arrow} — ${(t.title || '').slice(0, 70)}${t.model ? ` (${t.provider}/${t.model})` : ''}`;
  if (opt.tasks && !opt.tasks.has(t.id)) return;
  if (TERMINAL.has(t.status) && prev !== t.status) tag('[WS-WAKE]', line);
  else tag('[WS-TASK]', line);
}

function connect() {
  ws = new WebSocket(opt.url);
  ws.on('open', () => {
    tag('[WS-OPEN]', `${opt.url} — en écoute`);
    ws.send(JSON.stringify({ command: 'refresh' }));
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    switch (m.type) {
      case 'snapshot': {
        const counts = {};
        for (const t of m.tasks || []) counts[t.status] = (counts[t.status] || 0) + 1;
        // met à jour les états connus sans spammer (les nouveaux seront des task_update)
        for (const t of m.tasks || []) {
          if (opt.tasks && !opt.tasks.has(t.id)) continue;
          lastStatus.set(t.id, t.status);
        }
        if (!opt.quiet) tag('[WS-SNAPSHOT]', `${(m.tasks || []).length} tâche(s) ${JSON.stringify(counts)} — ${(m.agents || []).length} agent(s)`);
        break;
      }
      case 'task_update':
        if (m.task) taskLine(m.task);
        break;
      case 'clear_result':
        tag('[WS-EVENT]', `clear_result ${JSON.stringify(m)}`.slice(0, 150));
        break;
    }
  });
  ws.on('close', () => {
    tag('[WS-CLOSE]', 'connexion perdue — retry dans 3s');
    retry = setTimeout(connect, 3000);
  });
  ws.on('error', (e) => {
    tag('[WS-ERR]', e.message);
    try { ws.close(); } catch {}
  });
}

process.on('SIGINT', () => { clearTimeout(retry); process.exit(0); });
connect();
