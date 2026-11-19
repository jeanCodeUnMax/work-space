/**
 * ws-bridge-http — shim HTTP -> WebSocket pour n8n (le bridge agent est WS-only sur :7477).
 * Ecoute http://127.0.0.1:7478 — auth: Authorization: Bearer <ws-bridge.token>
 *
 * Endpoints:
 *   GET  /health                    -> {ok, wsPort}
 *   GET  /v1/sessions?providerId=&workspaceRoot=   -> list_acp_sessions
 *   POST /v1/wake-acp   {text, sessionId, providerId, workspaceRoot}  -> wake_acp_agent
 *   POST /v1/wake-devin {text, cascadeId}                            -> wake_devin
 *   POST /v1/wake-agy   {text, agyCascadeId, replyToCascadeId}       -> wake_antigravity
 *   POST /v1/open-chat  {sessionId}                                  -> open_chat
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.WS_BRIDGE_HTTP_PORT || 7478);
const WS_PORT = Number(process.env.WS_BRIDGE_PORT || 7477);

function findToken() {
    if ((process.env.ORCH_MONITOR_TOKEN || '').trim()) return process.env.ORCH_MONITOR_TOKEN.trim();
    const roots = [
        process.env.HEPHAISTOS_WORKSPACE,
        process.cwd(),
        path.join(os.homedir(), 'hephaistos2-kit'),
        'C:/data-sys/hephaistos2-kit',
        'C:/data-sys/Cornelius',
    ].filter(Boolean);
    for (const r of roots) {
        try {
            const t = fs.readFileSync(path.join(r, '.agent', 'ws-bridge.token'), 'utf8').trim();
            if (t) return t;
        } catch { /* absent */ }
    }
    return '';
}
const TOKEN = findToken();
const LOG = path.join(process.env.HEPHAISTOS_WORKSPACE || process.cwd(), '.agent', 'logs', 'ws-bridge-http.log');
function log(...a) {
    try {
        fs.mkdirSync(path.dirname(LOG), { recursive: true });
        fs.appendFileSync(LOG, String(new Date().toISOString()) + ' ' + a.join(' ') + String.fromCharCode(10));
    } catch {}
}

// Workspaces candidats (ordre : env, cwd, ingest-roots, racines connues).
function candidateRoots() {
    const roots = [process.env.HEPHAISTOS_WORKSPACE, process.cwd(),
        ...(process.env.HEPHAISTOS_WORKSPACES || '').split(/[;\s]+/),

        'C:/data-sys/ia-lacal-multi-gpu', 'C:/data-sys/hephaistos2-kit', 'C:/data-sys/Cornelius'];
    try {
        const d = process.env.HPHE_DATA || path.join(os.homedir(), '.hephaistos', 'data');
        roots.push(...fs.readFileSync(path.join(d, 'ingest-roots.txt'), 'utf8').split(/\s+/));
    } catch {}
    return [...new Set(roots.map((r) => (r || '').trim()).filter(Boolean))];
}

// Sonde parallele : un workspace "live" repond meme avec une liste vide ;
// un workspace sans IDE connecte ne repond pas (timeout).
let liveRoot = null;
async function resolveLiveRoot(hint) {
    if (hint) return hint;
    if (liveRoot) return liveRoot;
    const probes = await Promise.allSettled(
        candidateRoots().map((r) => wsCall('list_acp_sessions', { workspaceRoot: r }, 'acp_sessions_result', 5000).then((x) => r))
    );
    const hit = probes.find((p) => p.status === 'fulfilled');
    if (hit) { liveRoot = hit.value; log('live workspace: ' + liveRoot); }
    return liveRoot;
}

const wsUrl = () => `ws://127.0.0.1:${WS_PORT}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;

function wsCall(command, payload, resultType, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const ws = new WebSocket(wsUrl());
        const done = (fn, v) => { clearTimeout(t); try { ws.close(); } catch {} fn(v); };
        const t = setTimeout(() => done(reject, new Error(`timeout ${command}`)), timeoutMs);
        ws.onopen = () => {
            ws.send(JSON.stringify({ command, requestId, ...payload }));
            if (!resultType) setTimeout(() => done(resolve, { sent: true }), 300);
        };
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
            if (!resultType || m?.requestId !== requestId || m?.type !== resultType) return;
            if (m.error) done(reject, new Error(String(m.error))); else done(resolve, m);
        };
        ws.onerror = () => done(reject, new Error(`${command}: erreur ws`));
        ws.onclose = () => done(reject, new Error(`${command}: connexion close avant reponse`));
    });
}

// Roster SWAT : role -> session, source de verite pour le routage agent.
function readRoster(root) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'workspace-roster.json'), 'utf8'));
        const agents = [];
        for (const [group, list] of Object.entries(d.core || {})) {
            if (!Array.isArray(list)) continue;
            for (const a of list) {
                if (a?.sessionId) agents.push({
                    role: a.role || a.title || null, title: a.title || null,
                    providerId: a.providerId || '', sessionId: a.sessionId,
                    group, hidden: Boolean(a.hidden),
                });
            }
        }
        return agents;
    } catch { return []; }
}

// Le store Bleubites vit dans LE workspace proprietaire (souvent hephaistos2-kit).
function bleubiteRoot(sessionId) {
    for (const r of candidateRoots()) {
        try {
            const ss = JSON.parse(fs.readFileSync(path.join(r, '.agent', 'chats', 'sessions.json'), 'utf8'));
            if (ss.some((s) => s.id === sessionId)) return r;
        } catch { /* absent */ }
    }
    return null;
}

// Injection dans une fenetre Bleubite chat-* : tour agent reel via acp-inject.
function injectBleubite(root, sessionId, text, timeoutSec) {
    return new Promise((resolve, reject) => {
        const script = path.join(root, '.agent', 'agent-bridge', 'acp-inject.js');
        const child = spawn(process.execPath, [
            script, '--provider', 'hephaistos', '--session', sessionId,
            '--prompt', text, '--cwd', root, '--wait', 'turn', '--timeout', String(timeoutSec),
        ], { windowsHide: true, timeout: (timeoutSec + 10) * 1000 });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                try { resolve(JSON.parse(out)); } catch { resolve({ status: 'sent', raw: out.trim() }); }
            } else reject(new Error(`acp-inject exit ${code}: ${err.slice(-300) || out.slice(-300)}`));
        });
    });
}

// Fallback disque : sessions ACP persistees par l'IDE (state.vscdb).
function listSessionsDirect(providerId) {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const dbPath = path.join(appdata, 'Devin', 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(dbPath)) return [];
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return []; }
    try {
        const rows = db.prepare(
            "SELECT value FROM ItemTable WHERE key LIKE 'windsurf.acp.sessioninfo.session.%'"
        ).all();
        const out = [];
        for (const r of rows) {
            try {
                const p = JSON.parse(r.value);
                if (providerId && p.providerId !== providerId) continue;
                const info = p.info || {};
                if (!info.sessionId) continue;
                out.push({
                    sessionId: info.sessionId,
                    providerId: p.providerId || '',
                    title: info.title || '',
                    focused: Boolean(info.focused ?? p.focused),
                    updatedAt: info.updatedAt || '',
                    source: 'state.vscdb',
                });
            } catch { /* non-JSON */ }
        }
        return out;
    } finally { try { db.close(); } catch {} }
}

const readBody = (req) => new Promise((res, rej) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => res(Buffer.concat(c).toString('utf8'))); req.on('error', rej);
});
const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    log(`${req.method} ${u.pathname}`);
    if (req.method === 'GET' && u.pathname === '/health') {
        return sendJson(res, 200, { ok: true, httpPort: PORT, wsPort: WS_PORT, authed: Boolean(TOKEN) });
    }
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!TOKEN || auth !== TOKEN) return sendJson(res, 401, { error: 'bad bearer token' });

    try {
        if (req.method === 'GET' && (u.pathname === '/v1/sessions' || u.pathname === '/sessions')) {
            const providerId = u.searchParams.get('providerId') || '';
            const root = u.searchParams.get('workspaceRoot') || '';
            if (root) {
                try {
                    const r = await wsCall('list_acp_sessions', { providerId, workspaceRoot: root }, 'acp_sessions_result', 8000);
                    return sendJson(res, 200, r);
                } catch {
                    liveRoot = liveRoot === root ? null : liveRoot;
                    return sendJson(res, 200, { sessions: listSessionsDirect(providerId), source: 'state.vscdb' });
                }
            }
            // Pas de workspaceRoot : sonde tous les workspaces enregistres, garde les live.
            const probes = await Promise.allSettled(
                candidateRoots().map(async (r) => {
                    const x = await wsCall('list_acp_sessions', { providerId, workspaceRoot: r }, 'acp_sessions_result', 5000);
                    return (x.sessions || []).map((s) => ({ ...s, workspaceRoot: r }));
                })
            );
            const sessions = probes.filter((p) => p.status === 'fulfilled').flatMap((p) => p.value);
            if (sessions.length) return sendJson(res, 200, { sessions, source: 'live' });
            return sendJson(res, 200, { sessions: listSessionsDirect(providerId), source: 'state.vscdb' });
        }
        if (req.method === 'GET' && (u.pathname === '/roster' || u.pathname === '/v1/roster')) {
            const root = u.searchParams.get('workspaceRoot') || await resolveLiveRoot('');
            if (!root) return sendJson(res, 503, { error: 'aucun IDE live' });
            const agents = readRoster(root);
            // focus live (best-effort)
            let focused = null;
            try {
                const r = await wsCall('list_acp_sessions', { workspaceRoot: root }, 'acp_sessions_result', 5000);
                focused = (r.sessions || []).find((s) => s.focused)?.sessionId || null;
            } catch { /* extension sourde */ }
            return sendJson(res, 200, {
                workspaceRoot: root, focusedSession: focused,
                agents: agents.map((a) => ({ ...a, focused: a.sessionId === focused })),
            });
        }

        if (req.method === 'POST') {
            const b = JSON.parse((await readBody(req)) || '{}');
            if (u.pathname === '/v1/wake-acp' || u.pathname === '/ask') {
                const root = await resolveLiveRoot(String(b.workspaceRoot || '').trim());
                if (!root) return sendJson(res, 503, { error: 'aucun IDE live (workspace introuvable)' });
                const timeoutSec = Math.min(Number(b.timeoutSec || 30), 300);

                // Routage par role SWAT : resout providerId+sessionId dans le roster.
                let providerId = b.providerId, sessionId = b.sessionId, role = b.role;
                if (role && !sessionId) {
                    const agent = readRoster(root).find((a) => a.role === role);
                    if (!agent) return sendJson(res, 404, { error: `role '${role}' introuvable dans le roster de ${root}` });
                    providerId = agent.providerId; sessionId = agent.sessionId;
                    log(`role '${role}' -> ${sessionId} (${providerId})`);
                }
                if (!sessionId || !providerId) return sendJson(res, 400, { error: 'sessionId+providerId ou role requis' });

                // Fenetre Bleubite chat-* : injection tour reel via acp-inject.
                if (String(sessionId).startsWith('chat-')) {
                    const bRoot = bleubiteRoot(sessionId) || root;
                    const r = await injectBleubite(bRoot, sessionId, b.text, timeoutSec);
                    log(`ask ${sessionId} -> reply ${String(r.reply || '').length}c`);
                    return sendJson(res, 200, { type: 'bleubite_result', status: 'sent', role, ...r });
                }

                const fullId = String(sessionId).includes('/') ? sessionId : `acp/${providerId}/${sessionId}`;
                const r = await wsCall('wake_acp_agent', {
                    text: b.text, sessionId: fullId, providerId, workspaceRoot: root,
                }, 'acp_wake_result', timeoutSec * 1000);
                log(`ask ${fullId} -> ${r.status}`);
                return sendJson(res, 200, r);
            }
            if (u.pathname === '/v1/wake-devin') return sendJson(res, 200, await wsCall('wake_devin', { text: b.text, cascadeId: b.cascadeId }));
            if (u.pathname === '/v1/wake-agy') return sendJson(res, 200, await wsCall('wake_antigravity', { text: b.text, agyCascadeId: b.agyCascadeId, replyToCascadeId: b.replyToCascadeId || '' }));
            if (u.pathname === '/v1/open-chat') return sendJson(res, 200, await wsCall('open_chat', { sessionId: b.sessionId }));
        }
        sendJson(res, 404, { error: `unknown ${req.method} ${u.pathname}` });
    } catch (e) {
        sendJson(res, 500, { error: e?.message || String(e) });
    }
}).listen(PORT, '127.0.0.1', () => console.log(`[ws-bridge-http] http://127.0.0.1:${PORT} -> ws://127.0.0.1:${WS_PORT} (token ${TOKEN ? 'ok' : 'MISSING'})`));
