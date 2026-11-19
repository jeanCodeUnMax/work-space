#!/usr/bin/env node
// hphe-diag.mjs — Staff de diagnostic Hephaistos2-Kit
// Sonde l'architecture complète : hphe-mcp (stdio), hphe-rest (:8792), hphe-indexd,
// hub roster (:7477), orchestrateur, sessions hephaistos-chats, bus comms, n8n.
// Usage : node hphe-diag.mjs [--json] [--alert] [--no-write] [--root <path>] [--timeout <ms>]

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ROOT = path.resolve(opt('--root', path.resolve(HERE, '..', '..')));
const PROBE_TIMEOUT = Number(opt('--timeout', 8000));
const MCP_TIMEOUT = Number(opt('--mcp-timeout', 25000));
const WRITE = !flag('--no-write');
const ALERT = flag('--alert');
const MCP_CALL = opt('--mcp-call', path.join(os.homedir(), '.config', 'devin', 'scripts', 'mcp-call.mjs'));
const MCP_SERVER = 'Hephaistos-everything-search';
const DIAG_DIR = path.join(ROOT, '.agent', 'diagnostics');

const run = (cmd, argv, timeout = PROBE_TIMEOUT) => new Promise((res) => {
  const t0 = Date.now();
  execFile(cmd, argv, { timeout, windowsHide: true }, (err, stdout, stderr) => {
    res({ ok: !err, ms: Date.now() - t0, stdout: String(stdout || ''), stderr: String(stderr || ''), err: err ? (err.killed ? 'timeout' : err.message) : null });
  });
});

const tcpProbe = (port, host = '127.0.0.1', timeout = 4000) => new Promise((res) => {
  const t0 = Date.now();
  const s = net.connect({ port, host, timeout });
  s.on('connect', () => { const ms = Date.now() - t0; s.end(); res({ ok: true, ms }); });
  s.on('timeout', () => { s.destroy(); res({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
  s.on('error', (e) => res({ ok: false, ms: Date.now() - t0, err: e.code || e.message }));
});

const httpProbe = (url, timeout = 4000) => new Promise((res) => {
  const t0 = Date.now();
  const req = http.get(url, { timeout }, (r) => {
    r.resume();
    r.on('end', () => res({ ok: r.statusCode < 500, ms: Date.now() - t0, status: r.statusCode }));
  });
  req.on('timeout', () => { req.destroy(); res({ ok: false, ms: Date.now() - t0, err: 'timeout' }); });
  req.on('error', (e) => res({ ok: false, ms: Date.now() - t0, err: e.code || e.message }));
});

const mcpCall = async (tool, argsJson = '{}') => {
  const r = await run(process.execPath, [MCP_CALL, MCP_SERVER, tool, argsJson], MCP_TIMEOUT);
  if (!r.ok) return { ok: false, ms: r.ms, err: r.err || r.stderr.slice(0, 200) };
  try { return { ok: true, ms: r.ms, data: JSON.parse(r.stdout) }; }
  catch { return { ok: r.stdout.trim().length > 0, ms: r.ms, raw: r.stdout.slice(0, 500) }; }
};

const fileStat = async (rel) => {
  const p = path.join(ROOT, rel);
  try {
    const st = await fs.stat(p);
    return { ok: true, path: p, size: st.size, mtime: st.mtime.toISOString(), ageMin: Math.round((Date.now() - st.mtimeMs) / 60000) };
  } catch (e) { return { ok: false, path: p, err: e.code }; }
};

const lastJsonlTs = async (rel) => {
  const p = path.join(ROOT, rel);
  try {
    const txt = await fs.readFile(p, 'utf8');
    const lines = txt.trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); const ts = o.ts || o.timestamp || o.time || o.at; if (ts) return { ok: true, ts, ageMin: Math.round((Date.now() - new Date(ts).getTime()) / 60000), lines: lines.length }; }
      catch { /* skip bad line */ }
    }
    return { ok: true, ts: null, lines: lines.length, note: 'aucun timestamp trouvé' };
  } catch (e) { return { ok: false, err: e.code }; }
};

const procsNamed = async (name) => {
  const r = await run('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
  const count = (r.stdout.match(new RegExp(name.replace(/\./g, '\\.'), 'gi')) || []).length;
  return { ok: count > 0, count, ms: r.ms };
};

const probes = {
  'proc.indexd':   { critical: true,  label: 'Démon index NTFS hphe-indexd (SYSTEM)', run: () => procsNamed('hphe-indexd.exe') },
  'proc.mcp':      { critical: false, label: 'Instances hphe-mcp.exe actives',        run: () => procsNamed('hphe-mcp.exe') },
  'proc.rest':     { critical: false, label: 'Passerelle hphe-rest.exe présente',     run: () => procsNamed('hphe-rest.exe') },
  'http.rest':     { critical: false, label: 'REST :8792 /health',                    run: () => httpProbe('http://127.0.0.1:8792/health', 4000) },
  'tcp.hub':       { critical: true,  label: 'Hub roster WebSocket :7477',            run: () => tcpProbe(7477) },
  'http.n8n':      { critical: false, label: 'n8n :5678 /healthz',                    run: () => httpProbe('http://127.0.0.1:5678/healthz', 4000) },
  'mcp.index':     { critical: true,  label: 'MCP stdio → everything_index_stats (pipe NTFS)', run: async () => { const r = await mcpCall('everything_index_stats'); return { ok: r.ok, ms: r.ms, detail: r.err || 'indexd répond via MCP' }; } },
  'mcp.orch':      { critical: true,  label: 'MCP orchestrateur → list_agents',       run: async () => { const r = await mcpCall('list_agents'); return { ok: r.ok, ms: r.ms, detail: r.err || 'orchestrateur.db accessible' }; } },
  'mcp.tasks':     { critical: false, label: 'MCP orchestrateur → list_tasks',        run: async () => { const r = await mcpCall('list_tasks', '{}'); return { ok: r.ok, ms: r.ms, detail: r.err || 'file de tâches lisible' }; } },
  'fs.roster':     { critical: true,  label: 'workspace-roster.json + schéma actif',  run: async () => { const p = path.join(ROOT, '.agent', 'workspace-roster.json'); try { const d = JSON.parse(await fs.readFile(p, 'utf8')); const w = d.workflow || {}; return { ok: true, activeSchema: w.activeSchema || null, activeSchemaId: w.activeSchemaId || null, nodes: (w.nodes || []).length }; } catch (e) { return { ok: false, err: e.message }; } } },
  'fs.sessions':   { critical: true,  label: 'hephaistos-chats sessions.json',        run: () => fileStat(path.join('.agent', 'chats', 'sessions.json')) },
  'fs.comms':      { critical: false, label: 'Bus comms.jsonl (fraîcheur dernier msg)', run: () => lastJsonlTs(path.join('.agent', 'comms.jsonl')) },
  'task.watch':    { critical: false, label: 'Tâche planifiée hphe-taskwatch',        run: async () => { const r = await run('schtasks', ['/query', '/tn', 'hphe-taskwatch', '/fo', 'csv', '/nh']); return { ok: r.ok && r.stdout.includes('hphe-taskwatch'), detail: r.ok ? 'installée' : (r.stderr || 'absente') }; } },
};

const main = async () => {
  const t0 = Date.now();
  const entries = Object.entries(probes);
  const results = {};
  await Promise.all(entries.map(async ([id, p]) => {
    try { results[id] = { label: p.label, critical: p.critical, ...(await p.run()) }; }
    catch (e) { results[id] = { label: p.label, critical: p.critical, ok: false, err: e.message }; }
  }));

  const failedCritical = entries.filter(([id, p]) => p.critical && !results[id].ok).map(([id]) => id);
  const failedWarn = entries.filter(([id, p]) => !p.critical && !results[id].ok).map(([id]) => id);
  const verdict = failedCritical.length ? 'down' : (failedWarn.length ? 'degraded' : 'ok');

  const report = {
    ts: new Date().toISOString(),
    root: ROOT,
    verdict,
    durationMs: Date.now() - t0,
    failedCritical, failedWarn,
    probes: results,
  };

  let transition = null;
  if (WRITE) {
    await fs.mkdir(DIAG_DIR, { recursive: true });
    const latest = path.join(DIAG_DIR, 'health-latest.json');
    try { transition = JSON.parse(await fs.readFile(latest, 'utf8')).verdict; } catch { /* first run */ }
    await fs.writeFile(latest, JSON.stringify(report, null, 2));
    await fs.appendFile(path.join(DIAG_DIR, 'health-history.jsonl'), JSON.stringify(report) + '\n');
    report.previousVerdict = transition;
  }

  if (ALERT && verdict !== 'ok' && transition !== verdict) {
    const line = JSON.stringify({
      ts: report.ts, source: 'hphe-diag', type: 'diag-alert',
      verdict, failedCritical, failedWarn,
      to: 'devin', priority: verdict === 'down' ? 'critical' : 'high',
    });
    try { await fs.appendFile(path.join(ROOT, '.agent', 'comms.jsonl'), line + '\n'); report.alert = 'comms.jsonl'; }
    catch (e) { report.alert = `échec alerte: ${e.message}`; }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === 'ok' ? 0 : (verdict === 'degraded' ? 2 : 3));
};

main().catch((e) => { console.error(JSON.stringify({ verdict: 'error', err: e.message })); process.exit(4); });
