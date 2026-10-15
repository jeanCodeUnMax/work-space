#!/usr/bin/env node
/**
 * devin-hub.js — Client de communication directe avec Devin dans l'IDE (sans orchestrateur).
 *
 * Symétrique à agy-hub.js (qui pilote Antigravity en Connect-RPC).
 * devin-hub.js communique via le bridge WebSocket local (ws://127.0.0.1:7477)
 * vers l'extension orchestrator-monitor qui exécute devin.sendChatActionMessage.
 *
 * Usage :
 *   node devin-hub.js current                     → cascadeId active de Devin
 *   node devin-hub.js send <texte> [cascadeId]    → injecte un message direct dans le chat Devin
 *   node devin-hub.js status                      → statut de connexion au bridge
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
let WebSocket;
const wsCandidates = [
    path.join(__dirname, '..', '..', 'extensions', 'orchestrator-monitor', 'ws-bridge', 'node_modules', 'ws'),
    path.join(__dirname, '..', 'ws-bridge', 'node_modules', 'ws'),
    path.join(os.homedir(), '.devin', 'extensions', 'hephaistos.orchestrator-monitor-0.0.34', 'ws-bridge', 'node_modules', 'ws'),
    'C:/Program Files/Projet-complet/hephaistos2-kit/extensions/orchestrator-monitor/ws-bridge/node_modules/ws',
    'ws'
];
for (const cand of wsCandidates) {
    try {
        WebSocket = require(cand);
        if (WebSocket) break;
    } catch { /* try next */ }
}
if (!WebSocket) {
    console.error('[devin-hub] ws module introuvable');
    process.exit(1);
}

let comms;
try { comms = require('./comms'); } catch { comms = null; }

function getActiveCascade() {
    // 1) Source fiable : sessioninfo.updatedAt du globalStorage Devin (activité
    //    utilisateur réelle) — délégué à current-cascade.js. Le .pb mtime est
    //    pollué par des writes de fond (chats vierges au reload, wakes injectés)
    //    et ciblait la mauvaise conversation.
    try {
        const id = execFileSync(process.execPath,
            [path.join(__dirname, 'current-cascade.js')],
            { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
        if (id) return id;
    } catch { /* fallback .pb */ }
    // 2) Fallback : .pb le plus récemment écrit
    try {
        const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.pb') && !f.endsWith('.archived'))
            .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        if (!files.length) return null;
        return files[0].f.replace(/\.pb$/, '');
    } catch { return null; }
}

function sendToDevin(text, cascadeId, port = 7477, sourceAgent = 'agy') {
    return new Promise((resolve, reject) => {
        // Cible explicite d'abord (un message adressé à X ne doit jamais
        // atterrir dans Y) ; sans cible, la conv actuellement active.
        const targetId = cascadeId || getActiveCascade();
        if (!targetId) { reject(new Error('Aucune session Devin cible')); return; }
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`Timeout de connexion au bridge Devin ws://127.0.0.1:${port}`));
        }, 5000);

        ws.on('open', () => {
            const payload = {
                command: 'wake_devin',
                text: text,
                cascadeId: targetId
            };
            ws.send(JSON.stringify(payload));
            if (comms) {
                comms.log({
                    src: sourceAgent,
                    dst: 'devin',
                    kind: 'prompt',
                    text: text,
                    convId: targetId
                });
            }
            clearTimeout(timeout);
            setTimeout(() => {
                ws.close();
                resolve({ sent: true, cascadeId: targetId });
            }, 300);
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function bridgeRequest(command, payload, resultType, port = 7477, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { ws.close(); } catch { /* noop */ }
            fn(value);
        };
        const timeout = setTimeout(() => finish(reject, new Error(`Timeout ${command} via Devin bridge`)), timeoutMs);
        ws.on('open', () => ws.send(JSON.stringify({ command, requestId, ...payload })));
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg?.requestId !== requestId || msg?.type !== resultType) return;
            if (msg.error) finish(reject, new Error(String(msg.error)));
            else finish(resolve, msg);
        });
        ws.on('error', (error) => finish(reject, error));
        ws.on('close', () => {
            if (!settled) finish(reject, new Error(`${command} bridge connection closed before response`));
        });
    });
}

async function listAcpSessions(providerId, port = 7477, workspaceRoot = process.env.HEPHAISTOS_WORKSPACE || process.cwd()) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw new Error('ACP session listing requires an explicit workspace');
    const result = await bridgeRequest('list_acp_sessions', { providerId: providerId || '', workspaceRoot }, 'acp_sessions_result', port);
    return Array.isArray(result.sessions) ? result.sessions : [];
}

async function sendToAcpAgent(text, sessionId, providerId, port = 7477, workspaceRoot = process.env.HEPHAISTOS_WORKSPACE || process.cwd()) {
    if (typeof text !== 'string' || !text || typeof sessionId !== 'string' || !sessionId ||
        typeof providerId !== 'string' || !providerId || typeof workspaceRoot !== 'string' || !workspaceRoot) {
        throw new Error('ACP send requires explicit text, sessionId, providerId and workspace');
    }
    const result = await bridgeRequest('wake_acp_agent', { text, sessionId, providerId, workspaceRoot }, 'acp_wake_result', port, 15000);
    return { status: result.status, sessionId, providerId };
}

// CLI
if (require.main === module) {
    const [cmd, ...args] = process.argv.slice(2);
    if (!cmd || cmd === 'help') {
        console.log('Usage:');
        console.log('  node devin-hub.js current');
        console.log('  node devin-hub.js send <texte> [cascadeId]');
        console.log('  node devin-hub.js acp-list [providerId]  → sessions ACP activées du workspace');
        console.log('  node devin-hub.js status');
        process.exit(0);
    }

    if (cmd === 'current') {
        const id = getActiveCascade();
        if (id) {
            console.log(id);
            process.exit(0);
        } else {
            console.error('Aucune session Devin active trouvée');
            process.exit(1);
        }
    }

    if (cmd === 'acp-list') {
        listAcpSessions(args[0] || undefined)
            .then((sessions) => console.log(JSON.stringify(sessions, null, 1)))
            .catch((err) => { console.error(JSON.stringify({ error: err.message }, null, 1)); process.exit(1); });
    }

    if (cmd === 'status') {
        const ws = new WebSocket('ws://127.0.0.1:7477');
        ws.on('open', () => {
            console.log(JSON.stringify({ status: 'connected', port: 7477, activeCascade: getActiveCascade() }, null, 2));
            ws.close();
        });
        ws.on('error', (e) => {
            console.error(JSON.stringify({ status: 'error', error: e.message }, null, 2));
            process.exit(1);
        });
    }

    if (cmd === 'send') {
        const text = args[0];
        if (!text) {
            console.error('Erreur: texte requis. Usage: node devin-hub.js send "<texte>" [cascadeId]');
            process.exit(1);
        }
        const cascadeId = args[1] || null;
        sendToDevin(text, cascadeId)
            .then(res => {
                console.log(JSON.stringify({ status: 'sent', cascadeId: res.cascadeId, text: text }, null, 2));
            })
            .catch(err => {
                console.error(JSON.stringify({ status: 'failed', error: err.message }, null, 2));
                process.exit(1);
            });
    }
}

module.exports = { getActiveCascade, sendToDevin, listAcpSessions, sendToAcpAgent };
