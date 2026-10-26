'use strict';
/* Demon persistant hephaistos2-kit — possede UN process hphe-mcp.exe
 * (via mcp-proxy : initialize() + callTool() avec validation TOOL_SCHEMAS,
 * blocage __confirmed — enforcement serveur-side).
 * Transport : TCP 127.0.0.1 (les named pipes serveur sont bloquees EACCES
 * sur ce poste). Annonce : %LOCALAPPDATA%\hephaistos2-kit\daemon.json
 * {pid,port,token} — le token (aleatoire, fichier non exporte) est requis
 * dans chaque requete : gate d'acces local.
 * Protocole : lignes JSON
 *   {"token":"...","method":"tools/call","params":{"name":"<t>","arguments":{...}}}
 *   {"token":"...","method":"daemon/ping"} -> {pid,uptime}
 * Idle-timeout : exit apres IDLE_MS sans requete. */
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const IDLE_MS = 10 * 60 * 1000;
const ANNOUNCE_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'hephaistos2-kit');
const ANNOUNCE = path.join(ANNOUNCE_DIR, 'daemon.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const startedAt = Date.now();
let idleTimer = null;
let proxyReady = null;

function ensureProxy() {
  if (!proxyReady) {
    proxyReady = (async () => {
      const proxy = require(path.join(__dirname, 'mcp-proxy.js'));
      await proxy.initialize();
      return proxy;
    })();
  }
  return proxyReady;
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
}

async function handle(req) {
  if (!req || req.token !== TOKEN) return { error: 'forbidden' };
  if (req.method === 'daemon/ping') {
    return { result: { pid: process.pid, uptime: Math.round((Date.now() - startedAt) / 1000) } };
  }
  if (req.method === 'tools/call') {
    const name = req.params && req.params.name;
    const args = (req.params && req.params.arguments) || {};
    if (typeof name !== 'string' || !name) return { error: 'tool name required' };
    try {
      const proxy = await ensureProxy();
      const result = await proxy.callTool(name, args);
      return { result };
    } catch (e) {
      return { error: e.message };
    }
  }
  return { error: 'unknown method: ' + req.method };
}

const server = net.createServer((socket) => {
  let buf = '';
  socket.on('data', (chunk) => {
    touch();
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { socket.write(JSON.stringify({ error: 'bad json' }) + '\n'); continue; }
      handle(req).then((res) => { try { socket.write(JSON.stringify(res) + '\n'); } catch {} });
    }
  });
  socket.on('error', () => {});
});

server.on('error', (e) => { console.error('server error:', e.message); process.exit(1); });
server.listen(0, '127.0.0.1', () => {
  fs.mkdirSync(ANNOUNCE_DIR, { recursive: true });
  fs.writeFileSync(ANNOUNCE, JSON.stringify({ pid: process.pid, port: server.address().port, token: TOKEN, startedAt }), { mode: 0o600 });
  touch();
  ensureProxy().catch(() => {});
});
process.on('exit', () => { try { fs.unlinkSync(ANNOUNCE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
