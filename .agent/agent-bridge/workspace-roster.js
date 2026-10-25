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

function emptyWorkflow() {
    return { version: 1, name: 'Flux agents', entrySessionId: null, nodes: [], edges: [] };
}

function validateWorkflow(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
        throw new Error('workflow invalide: version/nodes/edges requis');
    }

    const nodes = new Map();
    for (const raw of input.nodes) {
        const sessionId = String(raw?.sessionId || '');
        if (!sessionId || sessionId.length > 200 || nodes.has(sessionId)) {
            throw new Error(`sessionId de node invalide ou duplique: ${sessionId}`);
        }
        const x = Number(raw.position?.x);
        const y = Number(raw.position?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000) {
            throw new Error(`position invalide pour ${sessionId}`);
        }
        nodes.set(sessionId, {
            sessionId,
            role: String(raw.role || 'Agent').slice(0, 120),
            task: String(raw.task || '').slice(0, 6000),
            position: { x, y },
        });
    }

    const edgeKeys = new Set();
    const edges = input.edges.map((raw) => {
        const source = String(raw?.source || '');
        const target = String(raw?.target || '');
        const key = `${source}\u0000${target}`;
        if (!nodes.has(source) || !nodes.has(target) || source === target || edgeKeys.has(key)) {
            throw new Error(`connexion invalide: ${source} -> ${target}`);
        }
        edgeKeys.add(key);
        return { id: String(raw.id || `edge:${source}->${target}`), source, target };
    });

    const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
    const outgoing = new Map([...nodes.keys()].map((id) => [id, []]));
    for (const edge of edges) {
        indegree.set(edge.target, indegree.get(edge.target) + 1);
        outgoing.get(edge.source).push(edge.target);
    }
    const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
    let visited = 0;
    while (ready.length) {
        const id = ready.shift();
        visited++;
        for (const next of outgoing.get(id)) {
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) ready.push(next);
        }
    }
    if (visited !== nodes.size) throw new Error('connexion cyclique interdite dans un pipeline');

    const entrySessionId = input.entrySessionId == null ? null : String(input.entrySessionId);
    if (entrySessionId && !nodes.has(entrySessionId)) {
        throw new Error(`point d'entree absent du workflow: ${entrySessionId}`);
    }
    return {
        version: 1,
        name: String(input.name || 'Flux agents').slice(0, 120),
        entrySessionId,
        nodes: [...nodes.values()],
        edges,
    };
}

function writeRoster(root, roster) {
    roster.updatedAt = new Date().toISOString();
    fs.writeFileSync(rosterPath(root), JSON.stringify(roster, null, 2) + '\n', 'utf8');
}

function readWorkflow(root) {
    const roster = loadRoster(root);
    return validateWorkflow(roster.workflow || emptyWorkflow());
}

function syncRosterWorkflow(root, sessions) {
    const roster = loadRoster(root);
    const workflow = validateWorkflow(roster.workflow || emptyWorkflow());
    const byId = new Map((Array.isArray(sessions) ? sessions : []).map((session) => [session.id, session]));
    const nodes = new Map(workflow.nodes.map((node) => [node.sessionId, node]));
    let changed = false;

    for (const [index, member] of (roster.core?.bleubites || []).entries()) {
        if (member.providerId !== 'hephaistos') continue;
        const session = byId.get(member.sessionId);
        if (!session) continue;
        const model = String(session.model || member.model || '').slice(0, 200);
        if (model !== member.model) {
            member.model = model;
            changed = true;
        }
        if (!nodes.has(member.sessionId)) {
            const node = {
                sessionId: member.sessionId,
                role: String(member.role || 'Agent').slice(0, 120),
                task: '',
                position: { x: 100 + (index % 3) * 280, y: 120 + Math.floor(index / 3) * 170 },
            };
            workflow.nodes.push(node);
            nodes.set(node.sessionId, node);
            changed = true;
        }
    }

    if (changed || !roster.workflow) {
        roster.workflow = validateWorkflow(workflow);
        writeRoster(root, roster);
    }
    return roster.workflow || workflow;
}

function upsertChatAgent(root, agent) {
    const sessionId = String(agent?.sessionId || '');
    if (!sessionId || !sessionId.startsWith('chat-')) {
        throw new Error('session hephaistos-chat invalide');
    }

    const roster = loadRoster(root);
    roster.core = roster.core || {};
    roster.core.bleubites = roster.core.bleubites || [];
    let member = roster.core.bleubites.find((item) => item.providerId === 'hephaistos' && item.sessionId === sessionId);
    if (!member) {
        member = { providerId: 'hephaistos', sessionId, restore: 'open-or-reveal' };
        roster.core.bleubites.push(member);
    }
    if (agent.model) member.model = String(agent.model).slice(0, 200);
    if (agent.role && !member.role) member.role = String(agent.role).slice(0, 120);

    const workflow = validateWorkflow(roster.workflow || emptyWorkflow());
    if (!workflow.nodes.some((node) => node.sessionId === sessionId)) {
        const index = workflow.nodes.length;
        workflow.nodes.push({
            sessionId,
            role: String(agent.role || 'Agent').slice(0, 120),
            task: '',
            position: { x: 100 + (index % 3) * 280, y: 120 + Math.floor(index / 3) * 170 },
        });
    }
    roster.workflow = validateWorkflow(workflow);
    writeRoster(root, roster);
    return roster.workflow;
}

function saveWorkflow(root, input) {
    const roster = loadRoster(root);
    roster.core = roster.core || {};
    roster.core.bleubites = roster.core.bleubites || [];
    const workflow = validateWorkflow(input);

    for (const node of workflow.nodes) {
        let member = roster.core.bleubites.find((item) =>
            item.providerId === 'hephaistos' && item.sessionId === node.sessionId);
        if (!member) {
            member = { providerId: 'hephaistos', sessionId: node.sessionId, restore: 'open-or-reveal' };
            roster.core.bleubites.push(member);
        }
        member.role = node.role;
    }

    roster.workflow = workflow;
    writeRoster(root, roster);
    return workflow;
}

function removeChatAgent(root, sessionId) {
    const roster = loadRoster(root);
    const id = String(sessionId || '');
    if (roster.core?.bleubites) {
        roster.core.bleubites = roster.core.bleubites.filter((item) =>
            !(item.providerId === 'hephaistos' && item.sessionId === id));
    }
    const workflow = validateWorkflow(roster.workflow || emptyWorkflow());
    workflow.nodes = workflow.nodes.filter((node) => node.sessionId !== id);
    workflow.edges = workflow.edges.filter((edge) => edge.source !== id && edge.target !== id);
    if (workflow.entrySessionId === id) workflow.entrySessionId = null;
    roster.workflow = validateWorkflow(workflow);
    if (roster.verification?.results) delete roster.verification.results[id];
    writeRoster(root, roster);
    return roster.workflow;
}

function connectWorkflowAgents(root, source, target) {
    const workflow = readWorkflow(root);
    workflow.edges.push({ id: `edge:${source}->${target}`, source, target });
    return saveWorkflow(root, workflow);
}

function disconnectWorkflowAgents(root, source, target) {
    const workflow = readWorkflow(root);
    workflow.edges = workflow.edges.filter((edge) => edge.source !== source || edge.target !== target);
    return saveWorkflow(root, workflow);
}

function configureWorkflowNode(root, sessionId, updates) {
    const workflow = readWorkflow(root);
    const node = workflow.nodes.find((item) => item.sessionId === sessionId);
    if (!node) throw new Error(`agent absent du workflow: ${sessionId}`);
    if (updates.role != null) node.role = String(updates.role).slice(0, 120);
    if (updates.task != null) node.task = String(updates.task).slice(0, 6000);
    if (updates.position != null) node.position = updates.position;
    if (updates.entry === true) workflow.entrySessionId = sessionId;
    if (updates.entry === false && workflow.entrySessionId === sessionId) workflow.entrySessionId = null;
    return saveWorkflow(root, workflow);
}

function cmdWorkflow(root, args) {
    const subcommand = args[0] || 'status';
    if (subcommand === 'status') return readWorkflow(root);
    if (subcommand === 'connect') return connectWorkflowAgents(root, args[1], args[2]);
    if (subcommand === 'disconnect') return disconnectWorkflowAgents(root, args[1], args[2]);
    if (subcommand === 'remove') return removeChatAgent(root, args[1]);
    if (subcommand === 'configure') {
        const sessionId = args[1];
        const option = (name) => {
            const index = args.indexOf(name);
            return index >= 0 ? args[index + 1] : undefined;
        };
        return configureWorkflowNode(root, sessionId, {
            role: option('--role'),
            task: option('--task'),
            entry: args.includes('--entry') ? true : (args.includes('--no-entry') ? false : undefined),
        });
    }
    throw new Error('usage: workflow status|connect <source> <target>|disconnect <source> <target>|configure <sessionId> [--role R] [--task T] [--entry]|remove <sessionId>');
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
    if (cmd === 'workflow') {
        console.log(JSON.stringify({ command: 'workflow', workflow: cmdWorkflow(root, args.slice(1)) }, null, 1));
        return;
    }
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

    if (cmd === 'add') {
        // add <group> <providerId> <sessionId> [--model M] [--role R] [--restore mode]
        const [group, providerId, sessionId] = args.slice(1);
        if (!['devin', 'cerberos', 'bleubites'].includes(group) || !providerId || !sessionId) {
            console.error('usage: add <devin|cerberos|bleubites> <providerId> <sessionId> [--model M] [--role R]');
            process.exit(1);
        }
        roster.core[group] = roster.core[group] || [];
        if (roster.core[group].some(e => e.sessionId === sessionId && e.providerId === providerId)) {
            if (group === 'bleubites' && providerId === 'hephaistos') {
                const modelIndex = args.indexOf('--model');
                const roleIndex = args.indexOf('--role');
                upsertChatAgent(root, {
                    sessionId,
                    model: modelIndex >= 0 ? args[modelIndex + 1] : undefined,
                    role: roleIndex >= 0 ? args[roleIndex + 1] : undefined,
                });
            }
            console.log(JSON.stringify({ command: 'add', status: 'duplicate-skip', sessionId }));
            return;
        }
        const entry = { providerId, sessionId, restore: group === 'bleubites' ? 'open-or-reveal' : 'existing-only' };
        const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
        const model = flag('--model'); if (model) entry.model = model;
        const role = flag('--role'); if (role) entry.role = role;
        roster.core[group].push(entry);
        if (group === 'bleubites' && providerId === 'hephaistos') {
            const workflow = validateWorkflow(roster.workflow || emptyWorkflow());
            if (!workflow.nodes.some((node) => node.sessionId === sessionId)) {
                const index = workflow.nodes.length;
                workflow.nodes.push({
                    sessionId,
                    role: role || 'Agent',
                    task: '',
                    position: { x: 100 + (index % 3) * 280, y: 120 + Math.floor(index / 3) * 170 },
                });
            }
            roster.workflow = validateWorkflow(workflow);
        }
        roster.updatedAt = new Date().toISOString();
        fs.writeFileSync(rosterPath(root), JSON.stringify(roster, null, 2) + '\n', 'utf8');
        console.log(JSON.stringify({ command: 'add', status: 'added', group, entry }));
        return;
    }

    if (cmd === 'remove') {
        // remove <sessionId> — retire l'agent du roster (la fenêtre reste ouverte,
        // l'agent n'est simplement plus dans l'équipe).
        const sid = args[1];
        if (!sid) { console.error('usage: remove <sessionId>'); process.exit(1); }
        if ((roster.core?.bleubites || []).some((entry) =>
            entry.providerId === 'hephaistos' && entry.sessionId === sid)) {
            removeChatAgent(root, sid);
            console.log(JSON.stringify({ command: 'remove', status: 'removed', sessionId: sid }));
            return;
        }
        let removed = null;
        for (const group of ['devin', 'cerberos', 'bleubites']) {
            const arr = (roster.core && roster.core[group]) || [];
            const i = arr.findIndex(e => e.sessionId === sid);
            if (i >= 0) { removed = arr.splice(i, 1)[0]; break; }
        }
        if (!removed) { console.log(JSON.stringify({ command: 'remove', status: 'not-found', sessionId: sid })); return; }
        if (roster.verification?.results) delete roster.verification.results[sid];
        roster.updatedAt = new Date().toISOString();
        fs.writeFileSync(rosterPath(root), JSON.stringify(roster, null, 2) + '\n', 'utf8');
        console.log(JSON.stringify({ command: 'remove', status: 'removed', sessionId: sid }));
        return;
    }

    console.error('usage: workspace-roster.js status|restore|ping|add|remove|workflow [--write] [--only id1,id2]');
    process.exit(1);
}

module.exports = {
    configureWorkflowNode,
    connectWorkflowAgents,
    disconnectWorkflowAgents,
    readWorkflow,
    removeChatAgent,
    saveWorkflow,
    syncRosterWorkflow,
    upsertChatAgent,
    validateWorkflow,
};

if (require.main === module) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
