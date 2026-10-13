#!/usr/bin/env node
/**
 * agy-hub.js — Client HTTP pour le hub local de l'extension Antigravity.
 *
 * L'extension google.google-antigravity (VSIX dans Devin) lance
 *   agy.exe --hub --hub-port=<P> --csrf_token=<T> --add-dir=<workspace>
 * Le panneau chat et le CLI agy sont deux clients du MEME hub : les
 * conversations (cascade_id) sont partagees entre les deux.
 *
 * Protocole : Connect-RPC (JSON) —
 *   POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
 *   headers: content-type: application/json
 *            x-codeium-csrf-token: <token>
 *            connect-protocol-version: 1
 *
 * Usage CLI :
 *   node agy-hub.js discover                      → {port, csrfToken, pid, addDir}
 *   node agy-hub.js current                       → cascadeId active (la plus récemment active)
 *   node agy-hub.js list                          → conversations (cascade_id, title)
 *   node agy-hub.js models                        → modeles autorises + defaut
 *   node agy-hub.js send [cascadeId] <texte>      → injecte un message user (discussion active par defaut)
 *   node agy-hub.js ask [cascadeId] <texte> [sec] → send + attente + reponse(s)
 *   node agy-hub.js read [cascadeId] [offset]     → planner responses depuis offset
 *   node agy-hub.js wait [conversationId] [sec]   → WaitForConversationFullyIdle
 */
'use strict';

const http = require('http');
const { execSync } = require('child_process');
let comms;
try { comms = require('./comms'); } catch { comms = null; }

const SERVICE = '/exa.language_server_pb.LanguageServerService';
const WAIT_TIMEOUT_MS = 10 * 60 * 1000; // waitIdle peut bloquer longtemps

/* ---------- Découverte du hub (cmdline agy.exe) ---------- */

function discoverHub(preferDir) {
    // Pas de guillemets doubles à l'intérieur : la commande est wrappée par -Command "..."
    const ps = `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.Name -eq 'agy.exe' -and $_.CommandLine -match '--hub-port' } | ` +
        `Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    let rows;
    try {
        const out = execSync(`powershell.exe -NoProfile -Command "${ps}"`, {
            encoding: 'utf8', timeout: 15000
        }).trim();
        rows = out ? JSON.parse(out) : [];
    } catch (e) {
        throw new Error(`hub discovery failed: ${e.message}`);
    }
    if (!Array.isArray(rows)) rows = [rows];
    const hubs = [];
    for (const r of rows) {
        const cl = r.CommandLine || '';
        const port = /--hub-port[=\s](\d+)/.exec(cl)?.[1];
        const csrf = /--csrf_token[=\s]([0-9a-fA-F-]+)/.exec(cl)?.[1];
        const addDir = /--add-dir[=\s]([^\s"]+)/.exec(cl)?.[1];
        if (port && csrf) {
            const exe = /^\s*"([^"]+)"|^(\S+)/.exec(cl)?.[1] || /^\s*"([^"]+)"|^(\S+)/.exec(cl)?.[2] || '';
            hubs.push({ pid: r.ProcessId, port: Number(port), csrfToken: csrf, addDir, exe });
        }
    }
    if (!hubs.length) throw new Error('aucun hub agy trouvé (extension Antigravity non active ?)');
    // Plusieurs hubs possibles (extension Devin `AppData/Local/agy` vs desktop
    // Antigravity `.gemini/bin`). L'extension partage les conversations avec le
    // panneau → on la préfère ; le hub desktop est ignoré si les deux tournent.
    const ext = hubs.find((h) => /appdata[\/\\]+local[\/\\]+agy/i.test(h.exe || ''));
    const pool = ext ? [ext] : hubs;
    if (preferDir) {
        const norm = (s) => (s || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        const hit = pool.find((h) => norm(h.addDir) === norm(preferDir));
        if (hit) return hit;
    }
    return pool[0];
}

/* ---------- RPC Connect ---------- */

function rpc(hub, method, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: hub.port,
            path: `${SERVICE}/${method}`, method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-codeium-csrf-token': hub.csrfToken,
                'connect-protocol-version': '1'
            },
            timeout: timeoutMs || 30000
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                let j = {};
                try { j = d ? JSON.parse(d) : {}; } catch { /* corps non-JSON */ }
                if (res.statusCode !== 200 || j.code) {
                    return reject(new Error(`${method}: ${res.statusCode} ${d.slice(0, 300)}`));
                }
                resolve(j);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${method}: timeout`)); });
        req.end(JSON.stringify(body || {}));
    });
}

/* ---------- API haut niveau ---------- */

async function listConversations(hub) {
    const r = await rpc(hub, 'GetAllCascadeTrajectories', {});
    // trajectorySummaries : map cascade_id → {summary, stepCount, status, ...}
    return Object.entries(r.trajectorySummaries || {}).map(([id, m]) => ({
        cascadeId: id,
        summary: m.summary || m.annotations?.title || '',
        stepCount: m.stepCount,
        status: m.status,
        updated: m.lastModifiedTime || m.createdTime || ''
    }));
}

async function getActiveCascade(hub) {
    const list = await listConversations(hub);
    if (!list.length) return null;
    list.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
    return list[0].cascadeId;
}

async function defaultModel(hub) {
    const d = await rpc(hub, 'GetCascadeModelConfigData', {});
    const moa = d.defaultOverrideModelConfig?.modelOrAlias;
    if (moa?.model) return moa.model;
    if (moa?.alias) return { alias: moa.alias };
    const first = (d.clientModelConfigs || []).find((c) => !c.disabled);
    return first?.modelOrAlias?.model || null;
}

/** Injecte un message user dans la conversation <cascadeId>. */
async function sendMessage(hub, cascadeId, text, planModel) {
    const model = planModel === undefined ? await defaultModel(hub) : planModel;
    const body = { cascadeId, items: [{ text }] };
    if (model) {
        body.cascadeConfig = { plannerConfig: typeof model === 'string'
            ? { planModel: model } : { requestedModel: model } };
    }
    // Focus côté hub (équiv. openCascadeIdInChatPanel) — best effort
    try {
        await rpc(hub, 'SetBrowserOpenConversation', {
            cascadeId, expiresAt: new Date(Date.now() + 3600e3).toISOString()
        });
    } catch { /* non bloquant */ }
    const r = await rpc(hub, 'SendUserCascadeMessage', body);
    comms?.log({ src: 'devin', dst: 'agy', kind: 'prompt', text, convId: cascadeId });
    return r;
}

/** Bloque jusqu'à ce que la conversation soit idle. → {timedOut} */
async function waitIdle(hub, conversationId, timeoutSec) {
    return rpc(hub, 'WaitForConversationFullyIdle', {
        conversationId,
        inactivityTimeoutSeconds: timeoutSec || 300,
        stabilizationDurationSeconds: 2,
        returnOnExecutorError: true
    }, WAIT_TIMEOUT_MS);
}

/** Nombre de steps actuels (pour repérer les nouveaux après un envoi). */
async function stepCount(hub, cascadeId) {
    const r = await rpc(hub, 'GetCascadeTrajectorySteps', { cascadeId });
    return (r.steps || []).length;
}

/**
 * Réponses planner après l'index `since` (ou après le dernier USER_INPUT si
 * since non fourni). Retourne [{index, text, type}] pour les steps pertinents.
 */
async function readReplies(hub, cascadeId, since) {
    const r = await rpc(hub, 'GetCascadeTrajectorySteps', { cascadeId });
    const steps = r.steps || [];
    let start = since;
    if (start === undefined || start === null) {
        start = -1;
        for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].type === 'CORTEX_STEP_TYPE_USER_INPUT') { start = i; break; }
        }
    }
    const out = [];
    for (let i = Math.max(0, start); i < steps.length; i++) {
        const s = steps[i];
        if (s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const p = s.plannerResponse || {};
            out.push({ index: i, type: 'planner', text: p.modifiedResponse || p.response || '' });
        } else if (s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
            out.push({ index: i, type: 'error', text: s.errorMessage?.error?.shortError || 'error' });
        }
    }
    return { stepCount: steps.length, replies: out };
}

/**
 * Cycle complet : envoie <text> dans <cascadeId>, attend l'idle,
 * renvoie les réponses planner nouvelles.
 */
async function ask(hub, cascadeId, text, timeoutSec, planModel) {
    const before = await stepCount(hub, cascadeId).catch(() => 0);
    await sendMessage(hub, cascadeId, text, planModel);
    const w = await waitIdle(hub, conversationOf(cascadeId), timeoutSec);
    const { replies } = await readReplies(hub, cascadeId, before);
    for (const rep of replies) {
        comms?.log({ src: 'agy', dst: 'devin', kind: rep.type === 'error' ? 'error' : 'reply', text: rep.text, convId: cascadeId });
    }
    return { timedOut: !!w.timed_out || !!w.timedOut, replies };
}

/** conversation_id == cascade_id pour les conversations racines. */
function conversationOf(cascadeId) { return cascadeId; }

/* ---------- CLI ---------- */

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const hub = discoverHub(process.env.AGY_WORKSPACE || process.cwd());
    const j = (x) => console.log(JSON.stringify(x, null, 1));

    switch (cmd) {
        case 'discover': return j(hub);
        case 'list': return j(await listConversations(hub));
        case 'models': return j(await rpc(hub, 'GetCascadeModelConfigData', {}));
        case 'current':
            return console.log(await getActiveCascade(hub) || '');
        case 'send': {
            let cascadeId = args[0];
            let text;
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cascadeId)) {
                text = args.slice(1).join(' ');
            } else {
                cascadeId = await getActiveCascade(hub);
                text = args.join(' ');
            }
            if (!cascadeId) throw new Error('Aucune conversation Antigravity active');
            return j(await sendMessage(hub, cascadeId, text));
        }
        case 'read': {
            let cascadeId = args[0];
            let off;
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cascadeId)) {
                off = args[1] !== undefined ? Number(args[1]) : undefined;
            } else {
                cascadeId = await getActiveCascade(hub);
                off = args[0] !== undefined ? Number(args[0]) : undefined;
            }
            if (!cascadeId) throw new Error('Aucune conversation Antigravity active');
            return j(await readReplies(hub, cascadeId, off));
        }
        case 'wait': {
            let cascadeId = args[0];
            let timeoutSec = 300;
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cascadeId)) {
                if (args[1]) timeoutSec = Number(args[1]);
            } else {
                cascadeId = await getActiveCascade(hub);
                if (args[0]) timeoutSec = Number(args[0]);
            }
            if (!cascadeId) throw new Error('Aucune conversation Antigravity active');
            return j(await waitIdle(hub, cascadeId, timeoutSec));
        }
        case 'ask': {
            let cascadeId = args[0];
            let rest = args.slice(1);
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cascadeId)) {
                cascadeId = await getActiveCascade(hub);
                rest = args;
            }
            if (!cascadeId) throw new Error('Aucune conversation Antigravity active');
            const timeoutSec = /^\d+$/.test(rest[rest.length - 1] || '') ? Number(rest.pop()) : 300;
            const r = await ask(hub, cascadeId, rest.join(' '), timeoutSec);
            for (const rep of r.replies) console.log(rep.text);
            if (!r.replies.length) console.log('(pas de réponse — timedOut=' + r.timedOut + ')');
            return;
        }
        default:
            console.error('cmds: discover|current|list|models|send|read|wait|ask');
            process.exit(2);
    }
}

if (require.main === module) {
    main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
}

module.exports = { discoverHub, rpc, listConversations, defaultModel, sendMessage, waitIdle, stepCount, readReplies, ask };
