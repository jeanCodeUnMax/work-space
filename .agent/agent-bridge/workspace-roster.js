#!/usr/bin/env node
/**
 * workspace-roster.js — manifeste local des fenêtres/agents du workspace
 * (« SWAT de base ») + restauration et ping-pong de vérification.
 *
 * Le manifeste `.agent/workspace-roster.json` décrit les conversations qui
 * appartiennent au workspace : agents Devin natifs (ACP), Cerberos, et les
 * Bleubites de l'extension hephaistos-chats. Au reopen du workspace :
 *
 *   restore → rouvre les panneaux Bleubites via le bus `open_chat`
 *             (bridge ws://127.0.0.1:7477 → extension → ChatPanel.open,
 *             réutilise le panneau existant — jamais de doublon) ;
 *             vérifie la présence des sessions ACP natives sans rien créer.
 *   ping    → envoie « PING : réponds uniquement PONG » sur chaque transport :
 *             - providers injectables (hephaistos, cerberos, nim, …) :
 *               acp-inject.js --wait turn → exige delivered + end_turn + reply ;
 *             - devin-cli : wake_acp_agent via le bridge (focus onglet existant,
 *               ouvre si absent, soumet le texte — pas de reply texte dispo).
 *   status  → état live : sessions ACP listées (Redux via bridge, fallback
 *             disque) + sessions Bleubites persistées (.agent/chats/sessions.json).
 *
 * --write persiste verification.lastPing + results dans le manifeste.
 *
 * CLI :
 *   node workspace-roster.js status|restore|ping [--write] [--json]
 *   node workspace-roster.js ping --only chat-mvlpm7vh,acp/cerberos/local-…
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PING_TEXT = 'PING : réponds uniquement PONG';
const DEFAULT_PORT = 7477;

let WebSocket = null;
try { WebSocket = require('ws'); } catch { /* bridgeSend sera indisponible */ }

function workspaceRoot() {
    if (process.env.HEPHAISTOS_WORKSPACE) return process.env.HEPHAISTOS_WORKSPACE;
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        if (fs.existsSync(path.join(dir, '.agent', 'workspace-roster.json'))) return dir;
    }
    return process.cwd();
}

function rosterPath(root) {
    return path.join(root, '.agent', 'workspace-roster.json');
}

function loadRoster(root) {
    return JSON.parse(fs.readFileSync(rosterPath(root), 'utf8'));
}

function* entries(roster) {
    for (const group of ['devin', 'cerberos', 'bleubites']) {
        for (const e of (roster.core && roster.core[group]) || []) {
            yield { group, ...e };
        }
    }
}

function hephaistosSessions(root) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), 'utf8'));
        const s = Array.isArray(d) ? d : (d.sessions || []);
        return new Set(s.map(x => x.id || x.sessionId).filter(Boolean));
    } catch { return new Set(); }
}

function bridgeToken(root) {
    if (process.env.ORCH_MONITOR_TOKEN) return process.env.ORCH_MONITOR_TOKEN;
    try { return fs.readFileSync(path.join(root, '.agent', 'ws-bridge.token'), 'utf8').trim(); } catch { return ''; }
}

/** Envoi fire-and-forget d'une commande au bridge (open_chat n'a pas de réponse). */
function bridgeSend(root, msg, port = DEFAULT_PORT, timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!WebSocket) return resolve({ sent: false, error: 'ws module introuvable' });
        const tok = bridgeToken(root);
        const ws = new WebSocket(`ws://127.0.0.1:${port}${tok ? `?token=${encodeURIComponent(tok)}` : ''}`);
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ sent: false, error: 'timeout' }); }, timeoutMs);
        ws.on('open', () => {
            ws.send(JSON.stringify(msg), () => {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                resolve({ sent: true });
            });
        });
        ws.on('error', (e) => { clearTimeout(timer); resolve({ sent: false, error: e.message }); });
    });
}

async function liveAcpSessions(root, providerId) {
    const hub = require('./devin-hub');
    try {
        return await hub.listAcpSessions(providerId, DEFAULT_PORT, root);
    } catch { return []; }
}

function injectPing(root, providerId, sessionId) {
    const res = spawnSync(process.execPath, [
        path.join(__dirname, 'acp-inject.js'),
        '--provider', providerId,
        '--session', sessionId,
        '--prompt', PING_TEXT,
        '--cwd', root,
        '--wait', 'turn',
        '--timeout', '90',
    ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    try {
        return JSON.parse((res.stdout || '').trim());
    } catch {
        return { sent: false, error: (res.stderr || res.stdout || 'spawn failed').slice(0, 300) };
    }
}

function currentDevinSession(root) {
    try {
        const id = spawnSync(process.execPath, [
            path.join(__dirname, 'current-cascade.js')
        ], { encoding: 'utf8', cwd: root, windowsHide: true }).stdout.trim();
        return id.startsWith('acp/') ? id : `acp/devin-cli/${id}`;
    } catch { return null; }
}

async function pingEntry(root, e) {
    if (e.providerId === 'devin-cli') {
        // Jamais de ping sur la session courante de l'agent : s'injecter soi-
        // même ouvre un doublon de la conversation active dans l'IDE.
        const self = currentDevinSession(root);
        if (self && e.sessionId === self) {
            return { transport: 'wake_acp_agent', status: 'skipped-self', delivered: false };
        }
        const hub = require('./devin-hub');
        const r = await hub.sendToAcpAgent(PING_TEXT, e.sessionId, e.providerId, DEFAULT_PORT, root);
        return { transport: 'wake_acp_agent', status: r.status, delivered: r.status === 'sent' || r.status === 'delivered' };
    }
    const r = injectPing(root, e.providerId, e.sessionId);
    return {
        transport: 'acp-inject',
        delivered: !!r.delivered || !!r.sent,
        stopReason: r.stopReason || null,
        // Reply tronquée : le manifeste est commité, il ne doit pas
        // embarquer de contenu d'agent (données internes potentielles).
        reply: (r.reply || '').slice(0, 160) || null,
        pong: !!(r.delivered && r.stopReason === 'end_turn' && /pong/i.test(r.reply || '')),
        error: r.error || null,
    };
}

async function cmdStatus(root, roster) {
    const chats = hephaistosSessions(root);
    const byProvider = {};
    const list = [...entries(roster)];
    for (const e of list) {
        if (e.providerId === 'hephaistos') {
            e._status = chats.has(e.sessionId) ? 'session-present' : 'session-missing';
            continue;
        }
        if (!(e.providerId in byProvider)) byProvider[e.providerId] = await liveAcpSessions(root, e.providerId);
        const sid = e.sessionId.split('/').pop();
        const found = byProvider[e.providerId].find(s => {
            const id = s.sessionId || s.id || '';
            return id === e.sessionId || id === sid || id.endsWith(`/${sid}`);
        });
        e._status = found ? `acp-listed${found.focused ? '+focused' : ''}` : 'acp-missing';
    }
    return list;
}

async function cmdRestore(root, roster) {
    const results = {};
    for (const e of entries(roster)) {
        if (e.restore !== 'open-or-reveal') { results[e.sessionId] = 'existing-only'; continue; }
        if (e.providerId === 'hephaistos') {
            const r = await bridgeSend(root, { command: 'open_chat', sessionId: e.sessionId });
            results[e.sessionId] = r.sent ? 'open-requested' : `open-failed:${r.error}`;
        } else {
            results[e.sessionId] = 'no-restore-path';
        }
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0] || 'status';
    const root = workspaceRoot();
    const roster = loadRoster(root);
    const onlyIdx = args.indexOf('--only');
    const only = (onlyIdx >= 0 ? args[onlyIdx + 1] || '' : '').split(',').filter(Boolean);
    const pick = e => !only.length || only.includes(e.sessionId);

    if (cmd === 'status') {
        const list = await cmdStatus(root, roster);
        const out = list.map(e => ({ sessionId: e.sessionId, providerId: e.providerId, group: e.group, status: e._status }));
        console.log(JSON.stringify({ command: 'status', workspace: roster.workspace, entries: out }, null, 1));
        return;
    }

    if (cmd === 'restore') {
        const results = await cmdRestore(root, roster);
        console.log(JSON.stringify({ command: 'restore', workspace: roster.workspace, results }, null, 1));
        return;
    }

    if (cmd === 'ping') {
        const results = {};
        for (const e of entries(roster)) {
            if (!pick(e)) continue;
            results[e.sessionId] = await pingEntry(root, e);
        }
        if (args.includes('--write')) {
            // Fusion : --only <subset> ne doit pas effacer les résultats des
            // agents non pingés — chaque entrée garde son dernier verdict.
            const prev = roster.verification?.results || {};
            roster.verification = { lastPing: new Date().toISOString(), results: { ...prev, ...results } };
            fs.writeFileSync(rosterPath(root), JSON.stringify(roster, null, 2) + '\n', 'utf8');
        }
        console.log(JSON.stringify({ command: 'ping', workspace: roster.workspace, results }, null, 1));
        return;
    }

    console.error('usage: workspace-roster.js status|restore|ping [--write] [--only id1,id2]');
    process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
