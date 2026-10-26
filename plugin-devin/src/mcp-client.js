'use strict';
/* Client du demon mcp-daemon.js — lit l'annonce daemon.json {pid,port,token},
 * connecte TCP loopback, envoie la requete (token inclus). Si le demon est
 * absent/stale -> spawn detached + retry borne. Toute erreur -> throw :
 * l'appelant fait fallback vers le spawn-per-call historique. */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ANNOUNCE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'hephaistos2-kit', 'daemon.json');
const DAEMON = path.join(__dirname, 'mcp-daemon.js');
const SPAWN_WAIT_MS = 4000;
const RESPONSE_TIMEOUT_MS = 20000;

let daemonSpawned = false;

function readAnnounce() {
  try {
    const a = JSON.parse(fs.readFileSync(ANNOUNCE, 'utf8'));
    if (a && a.port && a.token) return a;
  } catch {}
  return null;
}

function alive(announce) {
  if (!announce) return false;
  try { process.kill(announce.pid, 0); return true; } catch { return false; }
}

function tryConnect(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const t = setTimeout(() => { s.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function spawnDaemon() {
  if (daemonSpawned) return;
  const p = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  daemonSpawned = true;
}

async function callViaDaemon(request) {
  let announce = readAnnounce();
  if (!alive(announce)) {
    spawnDaemon();
    const deadline = Date.now() + SPAWN_WAIT_MS;
    for (;;) {
      await new Promise(r => setTimeout(r, 150));
      announce = readAnnounce();
      if (alive(announce)) break;
      if (Date.now() > deadline) throw new Error('daemon indisponible');
    }
  }
  const socket = await tryConnect(announce.port, 1000);
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => { socket.destroy(); reject(new Error('daemon response timeout')); }, RESPONSE_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(t);
        socket.end();
        try { resolve(JSON.parse(buf.slice(0, idx))); }
        catch { reject(new Error('daemon bad json')); }
      }
    });
    socket.on('error', (e) => { clearTimeout(t); reject(e); });
    socket.write(JSON.stringify({ token: announce.token, ...request }) + '\n');
  });
}

module.exports = { callViaDaemon, ANNOUNCE };
