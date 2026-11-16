#!/usr/bin/env node
/**
 * bridge-api.mjs — Passerelle HTTP → ws-bridge :7477 pour n8n / tout client HTTP.
 *
 * n8n ne parle ni ACP ni le protocole WS propriétaire du bridge. Ce serveur
 * expose les opérations agent en REST ordinaire :
 *
 *   GET  /health                       → {ok, bridgeConnected}
 *   GET  /sessions?providerId=<id>     → fenêtres ACP ouvertes (focused flag)
 *   POST /wake    {providerId, sessionId, text, workspaceRoot?, draft?}
 *        → injecte dans la fenêtre → {ok, status, requestId}
 *   POST /ask     {providerId, sessionId, text, workspaceRoot?, timeoutSec?, raw?}
 *        → wake + attente de la réponse corrélée dans comms.jsonl → {ok, reply}
 *   GET  /reply/:convId?timeout=<sec>  → long-poll comms.jsonl
 *   GET  /comms?limit=<n>              → tail du bus (diagnostic)
 *   POST /agent   {prompt, timeoutSec?} → façade canonique de l'agent IA n8n
 *        (workflow sy2KbjC2J9Xy52oj, webhook /webhook/hephaistos-agent) :
 *        catalogue SWAT, statut mission, lancement diagnostic. L'auth n8n
 *        est injectée ici — le client n'a besoin que du token bridge.
 *
 * Auth : même secret que le bridge — Bearer token ou ?token=, lu depuis
 * ORCH_MONITOR_TOKEN puis .agent/ws-bridge.token. Loopback only.
 *
 * Env : BRIDGE_API_PORT (défaut 7478), BRIDGE_API_WS (ws://127.0.0.1:7477),
 *       HEPHAISTOS_WORKSPACE (racine .agent), ORCH_MONITOR_TOKEN.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { collectDiagnostics, saveDiagnosticReport } from './diagnostics.mjs';
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { inject } = require('./acp-inject.js');
const rosterApi = require('./workspace-roster.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_ROOT = process.env.HEPHAISTOS_WORKSPACE || path.resolve(__dirname, '..', '..');
const WS_URL = process.env.BRIDGE_API_WS || 'ws://127.0.0.1:7477';
const PORT = Number(process.env.BRIDGE_API_PORT || 7478);
const COMMS_LOG = process.env.COMMS_LOG || path.join(WS_ROOT, '.agent', 'comms.jsonl');
const N8N_AGENT_URL = process.env.N8N_AGENT_URL || 'http://127.0.0.1:5678/webhook/hephaistos-agent';
const N8N_AGENT_TIMEOUT_MS = Number(process.env.N8N_AGENT_TIMEOUT_MS || 900000);
const N8N_API_URL = process.env.HPHE_N8N_API_URL || 'http://127.0.0.1:5678/api/v1';
/* Workflows n8n invocables via POST /n8n/workflows/:id/invoke — allowlist explicite.
   Le secret webhook (credential « Hephaistos Bridge » = token bridge) reste côté serveur. */
const N8N_CALLABLE_WORKFLOWS = {
    'vyvBFDvUdt1hcFl9': { name: 'missions SWAT dynamiques', webhookPath: 'hephaistos-swat-missions', timeoutSec: 600,
        contract: '{missionId, swatId, objective, inputs?, constraints?, expectedDeliverable?}' },
    'hpheDiagnosticSwat': { name: 'diagnostic architecture', webhookPath: 'hephaistos-diagnostic', timeoutSec: 600,
        contract: '{} (prérequis : schéma actif swat-diagnostic-hephaistos)' },
    'EgenrlEHmNKqN8Sq': { name: 'SWAT - Caverne Hermes', webhookPath: 'swat-caverne', timeoutSec: 300,
        contract: '{prompt|objective|texte}' },
    'W4itU2f4OuOGUQKV': { name: 'SWAT - OCR Histoires Presse', webhookPath: 'swat-ocr-histoires', timeoutSec: 300,
        contract: '{prompt|objective|texte}' },
    'RAp6qBCMGOcauYmK': { name: 'SWAT - Telegram Hub', webhookPath: 'swat-telegram-hub', timeoutSec: 300,
        contract: '{action?|chat?|text|texte|imageUrl|path|messageId|question|options|topic|reply|limit|query|cmd|bot|args}' },
};
const N8N_API_KEY = process.env.N8N_API_KEY?.trim()
    || (() => { try { return fs.readFileSync(path.join(WS_ROOT, '.agent', 'n8n-api.key'), 'utf8').trim(); } catch { return ''; } })();
const MAX_BODY = 64 * 1024;
const DEFAULT_REPLY_TIMEOUT_S = 120;
const REPLY_KINDS = new Set(['reply', 'chat-reply', 'agent-reply', 'agent-error']);

/* ---------- token ---------- */
function resolveToken() {
    if (process.env.ORCH_MONITOR_TOKEN?.trim()) return process.env.ORCH_MONITOR_TOKEN.trim();
    try {
        const t = fs.readFileSync(path.join(WS_ROOT, '.agent', 'ws-bridge.token'), 'utf8').trim();
        if (t) return t;
    } catch { /* absent */ }
    return '';
}
const TOKEN = resolveToken();

function authorized(req) {
    if (!TOKEN) return true; // bridge sans secret -> pas de gate local
    let tok = '';
    try { tok = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch { /* */ }
    if (!tok) {
        const m = /^bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        if (m) tok = m[1].trim();
    }
    return tok.length === TOKEN.length
        && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN));
}

/* ---------- client ws-bridge ---------- */
let ws = null;
let wsReady = false;
const pending = new Map(); // requestId -> {resolve, reject, timer, resultType}

function wsConnect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    const url = TOKEN ? `${WS_URL}?token=${encodeURIComponent(TOKEN)}` : WS_URL;
    ws = new WebSocket(url);
    ws.onopen = () => { wsReady = true; };
    ws.onclose = () => {
        wsReady = false;
        for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error('bridge disconnected')); }
        setTimeout(wsConnect, 3000).unref?.();
    };
    ws.onerror = () => { /* onclose gère */ };
    ws.onmessage = (ev) => {
        let frame;
        try { frame = JSON.parse(ev.data); } catch { return; }
        const p = pending.get(frame?.requestId);
        if (!p || frame.type !== p.resultType) return;
        clearTimeout(p.timer);
        pending.delete(frame.requestId);
        if (frame.error) p.reject(new Error(String(frame.error)));
        else p.resolve(frame);
    };
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) wsConnect();

function bridgeRequest(command, payload, resultType, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        if (!wsReady) return reject(new Error('ws-bridge :7477 injoignable'));
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`timeout ${command}`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer, resultType });
        ws.send(JSON.stringify({ command, requestId, ...payload }));
    });
}

/* ---------- comms.jsonl ---------- */
function commsEntries() {
    try {
        return fs.readFileSync(COMMS_LOG, 'utf8').split('\n')
            .filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch { return []; }
}

function waitCommsReply(convId, timeoutSec) {
    const deadline = Date.now() + Math.min(timeoutSec || DEFAULT_REPLY_TIMEOUT_S, 600) * 1000;
    return new Promise((resolve) => {
        const scan = () => {
            const hit = commsEntries().reverse().find((e) => e.convId === convId && REPLY_KINDS.has(e.kind));
            if (hit) return resolve(hit);
            if (Date.now() >= deadline) return resolve(null);
            setTimeout(scan, 500).unref?.();
        };
        scan();
    });
}

/* ---------- enveloppe contrat bus ---------- */
function buildEnvelope(convId, text) {
    return [
        `[bridge-api] Message relayé par la passerelle HTTP (req ${convId}).`,
        'Traite cette demande, puis publie ta réponse FINALE en une ligne dans .agent/comms.jsonl :',
        `{"src":"<tonAgent>","dst":"n8n","kind":"reply","convId":"${convId}","text":"<ta réponse>"}`,
        '',
        '— Demande —',
        text,
    ].join('\n');
}

/* ---------- http ---------- */
function json(res, code, body) {
    const d = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) });
    res.end(d);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let d = '';
        req.on('data', (c) => { d += c; if (d.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } });
        req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('invalid JSON')); } });
        req.on('error', reject);
    });
}

const swatRuns = new Map();

export function normalizeMission(body) {
    const missionId = body.missionId;
    const schemaId = body.swatId || body.schemaId;
    const objective = body.objective || body.mission;
    if (typeof missionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(missionId)
        || typeof schemaId !== 'string' || !schemaId.trim()
        || typeof objective !== 'string' || !objective.trim() || objective.length > 12000) {
        throw new Error('missionId (1-100 caracteres alphanumeriques, _ ou -), swatId et objective requis.');
    }
    if (body.constraints != null && (!Array.isArray(body.constraints)
        || body.constraints.some((s) => typeof s !== 'string'))) throw new Error('constraints doit etre une liste de textes.');
    return { missionId, schemaId, objective: objective.trim(), inputs: body.inputs ?? {},
        constraints: body.constraints || [], expectedDeliverable: body.expectedDeliverable || 'Synthese avec preuves et limites.' };
}

function missionStatus(run) {
    const outputs = Object.values(run.outputs).filter((o) => o.sessionId);
    return { ok: !run.failed, missionId: run.contract?.missionId, runId: run.runId,
        schemaId: run.graph.activeSchemaId, state: run.failed ? 'failed'
            : outputs.length === run.graph.nodes.length - 1 ? 'completed' : 'in_progress',
        steps: outputs, error: run.failed || null };
}

function recordMission(run) {
    if (!run.contract) return;
    fs.appendFileSync(COMMS_LOG, JSON.stringify({ ts: new Date().toISOString(), src: 'swat-runner',
        dst: 'n8n', kind: 'swat-status', convId: run.contract.missionId,
        text: JSON.stringify({ ...missionStatus(run), fingerprint: run.fingerprint }) }) + '\n');
}

function savedMission(id) {
    const entry = commsEntries().reverse().find((e) => e.src === 'swat-runner' && e.kind === 'swat-status' && e.convId === id);
    return entry ? JSON.parse(entry.text) : null;
}

export function swatGraph(root = WS_ROOT) {
    const roster = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'workspace-roster.json'), 'utf8'));
    const graph = roster.workflow;
    if (!graph?.activeSchemaId || graph.mode === 'council') throw new Error('Schema actif absent ou mode council non pris en charge par ce runner.');
    const ids = graph.nodes.map((n) => n.sessionId);
    if (!ids.length || new Set(ids).size !== ids.length || !ids.includes(graph.entrySessionId)
        || graph.nodes.some((n) => !n.role?.trim() || !n.task?.trim())
        || graph.edges.some((e) => !ids.includes(e.source) || !ids.includes(e.target) || e.target === graph.entrySessionId)) {
        throw new Error('Graphe SWAT invalide : identites, missions ou liens incoherents.');
    }
    const reached = new Set([graph.entrySessionId]);
    const pending = new Set(ids.filter((id) => id !== graph.entrySessionId));
    while (pending.size) {
        const ready = [...pending].filter((id) => {
            const parents = graph.edges.filter((e) => e.target === id);
            return parents.length && parents.every((e) => reached.has(e.source));
        });
        if (!ready.length) throw new Error('Graphe SWAT cyclique ou noeud inaccessible depuis orchestrateur.');
        for (const id of ready) { pending.delete(id); reached.add(id); }
    }
    const members = Object.values(roster.core).flat();
    const sessions = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), 'utf8'));
    const list = Array.isArray(sessions) ? sessions : sessions.sessions;
    if (!Array.isArray(list)) throw new Error('Format sessions hephaistos-chats inconnu.');
    for (const id of ids.filter((id) => id !== graph.entrySessionId)) {
        if (!id.startsWith('chat-')) throw new Error(`Transport worker non pris en charge par ce runner : ${id}. Aucun fallback CLI.`);
        const member = members.find((m) => m.sessionId === id && !m.hidden);
        const session = list.find((s) => s.id === id || s.sessionId === id);
        if (!member || !session) throw new Error(`Session exacte du SWAT absente : ${id}`);
        if (session.provider !== member.providerId || session.model !== member.model) {
            throw new Error(`Provider/modele divergent du roster pour ${id}`);
        }
    }
    const semantic = { name: graph.name, activeSchemaId: graph.activeSchemaId,
        entrySessionId: graph.entrySessionId,
        nodes: graph.nodes.map((n) => ({ sessionId: n.sessionId, role: n.role, task: n.task })),
        edges: graph.edges.map((e) => ({ source: e.source, target: e.target })) };
    return { graph, digest: crypto.createHash('sha256').update(JSON.stringify(semantic)).digest('hex') };
}

async function swatTool(name, args) {
    const binary = process.env.HPHE_MCP_BIN || path.join(process.env.HPHE_INSTALL
        || path.join(process.env.ProgramFiles || 'C:/Program Files', 'servers', 'hephaistos2-kit'),
        'extension', 'server', 'hphe-mcp.exe');
    const { stdout } = await execFileAsync(binary, ['--tool', name, '--args', JSON.stringify(args)], {
        cwd: WS_ROOT, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result;
}

async function swatStep(b) {
    const run = swatRuns.get(b.runId);
    if (!run) throw new Error('Run SWAT inconnu ou service redemarre : ne pas rejouer automatiquement.');
    if (run.failed) throw new Error(`Run arrete : ${run.failed}`);
    try {
        if (run.digest !== swatGraph().digest) throw new Error('Schema modifie pendant le run : arret.');
    } catch (error) {
        run.failed = error.message;
        recordMission(run);
        throw error;
    }
    if (run.outputs[b.sessionId]) return run.outputs[b.sessionId];
    if (run.busy) throw new Error('Une etape est deja en cours pour ce run.');
    const node = run.graph.nodes.find((n) => n.sessionId === b.sessionId);
    if (!node || node.sessionId === run.graph.entrySessionId) throw new Error('Noeud worker absent du schema.');
    const parents = run.graph.edges.filter((e) => e.target === node.sessionId).map((e) => e.source);
    if (parents.some((id) => !run.outputs[id])) throw new Error('Dependances SWAT non terminees.');
    run.busy = true;
    let taskId;
    try {
        const prompt = `Tu es ${node.role}, session exacte ${node.sessionId}.\nMission de role : ${node.task}\n\nDemande n8n :\n${run.mission}\n\nResultats amont :\n${parents.map((id) => run.outputs[id].reply).join('\n\n')}`;
        const task = await swatTool('create_task', {
            title: `[${run.graph.name || run.graph.activeSchemaId}] ${node.role}`, description: prompt,
            dispatcher: run.graph.entrySessionId,
        });
        taskId = task.task_id ?? task.id;
        if (taskId == null) throw new Error('create_task sans identifiant : execution refusee.');
        await swatTool('update_task', { task_id: taskId, status: 'in_progress' });
        const result = await inject({ providerId: 'hephaistos', sessionId: node.sessionId,
            cwd: WS_ROOT, text: prompt, wait: 'turn', timeoutMs: 300000, turnTimeoutMs: 300000 });
        if (result.stopReason !== 'end_turn' || !result.reply?.trim()) throw new Error('Tour ACP incomplet ou sans reponse.');
        await swatTool('update_task', { task_id: taskId, status: 'completed', result: result.reply });
        const output = { ok: true, runId: b.runId, schemaId: run.graph.activeSchemaId,
            sessionId: node.sessionId, role: node.role, taskId, reply: result.reply };
        run.outputs[node.sessionId] = output;
        recordMission(run);
        return { ...output, missionId: run.contract?.missionId, state: missionStatus(run).state };
    } catch (error) {
        run.failed = String(error.message || error);
        if (taskId != null) {
            try { await swatTool('update_task', { task_id: taskId, status: 'failed', result: run.failed }); }
            catch (trackingError) { run.failed += `; suivi orchestrateur: ${trackingError.message}`; }
        }
        recordMission(run);
        throw new Error(run.failed);
    } finally { run.busy = false; }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const seg = url.pathname.split('/').filter(Boolean);
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
        if (req.method === 'GET' && seg[0] === 'health') {
            return json(res, 200, { ok: true, bridgeConnected: wsReady, bridge: WS_URL, workspaceRoot: WS_ROOT });
        }
        if (req.method === 'POST' && url.pathname === '/diagnostics/collect') {
            const evidence = await collectDiagnostics({ root: WS_ROOT, tool: swatTool, bridgeConnected: wsReady,
                requestAcp: () => bridgeRequest('list_acp_sessions', { workspaceRoot: WS_ROOT }, 'acp_sessions_result', 12000) });
            return json(res, 200, { ok: true, ...evidence });
        }
        if (req.method === 'POST' && url.pathname === '/diagnostics/report') {
            const b = await readBody(req);
            const run = [...swatRuns.values()].find((r) => r.contract?.missionId === b.missionId);
            if (!run || run.contract.inputs?.diagnosticId !== b.diagnosticId) {
                return json(res, 400, { ok: false, error: 'Mission et preuves de diagnostic non correlees' });
            }
            const state = missionStatus(run);
            if (state.state !== 'completed') return json(res, 409, { ok: false, error: 'Analyse SWAT non terminee', state: state.state });
            return json(res, 200, saveDiagnosticReport(WS_ROOT, b.diagnosticId, state));
        }
        if (req.method === 'GET' && url.pathname === '/swat') {
            const { graph, digest } = swatGraph();
            return json(res, 200, { ok: true, graph, digest, entryMode: 'n8n-orchestrator' });
        }
        if (req.method === 'GET' && url.pathname === '/swats') {
            const active = rosterApi.readWorkflow(WS_ROOT).activeSchemaId;
            return json(res, 200, { ok: true, activeSchemaId: active,
                swats: rosterApi.listSchemas(WS_ROOT).map((s) => ({ ...s, active: s.id === active,
                    execution: s.mode === 'council' ? 'unsupported-council' : 'requires-active-schema-and-chat-workers' })) });
        }
        if (req.method === 'GET' && seg[0] === 'missions' && seg.length === 2) {
            const run = [...swatRuns.values()].find((r) => r.contract?.missionId === seg[1]);
            if (run) return json(res, 200, missionStatus(run));
            const saved = savedMission(seg[1]);
            if (!saved) return json(res, 404, { ok: false, error: 'Mission inconnue' });
            delete saved.fingerprint;
            if (saved.state === 'in_progress') { saved.state = 'interrupted'; saved.ok = false; saved.error = 'Service redemarre : pas de rejeu automatique.'; }
            return json(res, 200, saved);
        }
        if (req.method === 'POST' && url.pathname === '/swat/bind') {
            const b = await readBody(req).catch(() => ({}));
            const key = b.id || b.name;
            if (typeof key !== 'string' || !key.trim()) {
                return json(res, 400, { ok: false, error: 'name ou id de schema requis' });
            }
            if ([...swatRuns.values()].some((r) => missionStatus(r).state === 'in_progress')) {
                return json(res, 409, { ok: false, error: 'Mission en cours : rebind refuserait le digest du run actif.' });
            }
            try {
                const out = execFileSync(process.execPath,
                    [path.join(WS_ROOT, '.agent', 'scripts', 'swat-bind.mjs'), '--' + (b.id ? 'id' : 'name'), String(key)],
                    { cwd: WS_ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true });
                return json(res, 200, JSON.parse(out));
            } catch (error) {
                return json(res, 409, { ok: false, error: String(error.stderr || error.message) });
            }
        }
        if (req.method === 'POST' && url.pathname === '/llm') {
            const b = await readBody(req).catch(() => ({}));
            const prompt = String(b.prompt || '').trim();
            if (!prompt) return json(res, 400, { ok: false, error: 'prompt requis' });
            const system = String(b.system || 'Tu es un assistant concis.').slice(0, 4000);
            const maxTokens = Math.min(Number(b.max_tokens) || 420, 2000);
            const envVar = (name) => {
                if (process.env[name]?.trim()) return process.env[name].trim();
                try {
                    const line = fs.readFileSync(path.join(WS_ROOT, '.env'), 'utf8')
                        .split(/\r?\n/).find((l) => l.startsWith(name + '='));
                    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
                } catch { /* absent */ }
                return '';
            };
            let chain = [];
            try {
                chain = execFileSync('sqlite3', [path.join('C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db'),
                    'SELECT provider FROM provider_prefs WHERE enabled=1 ORDER BY position;'],
                    { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/).filter(Boolean);
            } catch { /* fallback */ }
            if (!chain.length) chain = ['nim2', 'nim', 'omniroute', 'ollama'];
            const SPECS = {
                nim:  { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: 'NVIDIA_API_KEY',   model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
                'nvidia-nim': { ref: 'nim' },
                nim2: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: 'NVIDIA_API_KEY_2', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
                'nvidia-nim2': { ref: 'nim2' },
                omniroute: { url: 'http://localhost:20128/v1/chat/completions', key: 'OMNIROUTE_API_KEY', model: 'groq/openai/gpt-oss-120b' },
                ollama: { url: 'http://localhost:11434/v1/chat/completions', key: null, model: 'qwen3:8b' },
                'ollama-cloud': { url: 'https://ollama.com/v1/chat/completions', key: 'OLLAMA_API_KEY', model: 'qwen3:32b' },
                openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: 'OPENROUTER_API_KEY', model: 'nvidia/nemotron-3.5-lightning:free' },
                'openrouter-free': { ref: 'openrouter' },
                groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: 'GROQ_API_KEY', model: 'openai/gpt-oss-120b' },
            };
            const errors = [];
            for (const name of chain) {
                const spec = SPECS[name]?.ref ? SPECS[SPECS[name].ref] : SPECS[name];
                if (!spec) { errors.push(name + ': non supporte'); continue; }
                const key = spec.key ? envVar(spec.key) : 'ollama';
                if (spec.key && !key) { errors.push(name + ': cle absente'); continue; }
                try {
                    const r = await fetch(spec.url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', ...(spec.key ? { authorization: `Bearer ${key}` } : {}) },
                        body: JSON.stringify({ model: spec.model, max_tokens: maxTokens, stream: false,
                            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
                        signal: AbortSignal.timeout(Number(b.timeoutMs) || 60000),
                    });
                    const data = await r.json().catch(() => ({}));
                    const text = data?.choices?.[0]?.message?.content?.trim();
                    if (!r.ok || !text) { errors.push(`${name}: HTTP ${r.status}`); continue; }
                    return json(res, 200, { ok: true, text, provider: name, model: spec.model, tried: errors });
                } catch (e) { errors.push(name + ': ' + String(e.message).slice(0, 80)); }
            }
            return json(res, 502, { ok: false, error: 'chaine epuisee: ' + errors.join(' | ') });
        }
        if (req.method === 'POST' && url.pathname === '/swat/start') {
            let contract;
            try { contract = normalizeMission(await readBody(req)); }
            catch (error) { return json(res, 400, { ok: false, error: error.message }); }
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
            const existing = [...swatRuns.values()].find((r) => r.contract?.missionId === contract.missionId);
            if (existing) {
                if (existing.fingerprint !== fingerprint) return json(res, 409, { ok: false, error: 'missionId deja utilise pour une autre demande.' });
                return json(res, 200, { ...missionStatus(existing), replay: true });
            }
            if (savedMission(contract.missionId)) return json(res, 409, { ok: false, error: 'Mission deja enregistree : consulter GET /missions/:id, aucun rejeu apres redemarrage.' });
            if ([...swatRuns.values()].some((r) => missionStatus(r).state === 'in_progress')) {
                return json(res, 409, { ok: false, error: 'Une mission est en cours. Reessayer apres son resultat.' });
            }
            const { graph, digest } = swatGraph();
            if (contract.schemaId !== graph.activeSchemaId) return json(res, 409, { ok: false,
                error: 'SWAT non actif : selectionner explicitement ce schema dans extension avant lancement.', activeSchemaId: graph.activeSchemaId });
            if (swatRuns.size >= 100) return json(res, 409, { ok: false, error: 'Limite de runs atteinte : redemarrer hors execution.' });
            const mission = `${contract.objective}\n\nEntrees : ${JSON.stringify(contract.inputs)}\nContraintes : ${contract.constraints.join('; ')}\nLivrable attendu : ${contract.expectedDeliverable}`;
            const runId = crypto.randomUUID();
            const run = { runId, graph, digest, contract, fingerprint, mission, busy: false,
                outputs: { [graph.entrySessionId]: { reply: mission } } };
            swatRuns.set(runId, run);
            recordMission(run);
            return json(res, 200, { ok: true, runId, missionId: contract.missionId, schemaId: graph.activeSchemaId,
                entrySessionId: graph.entrySessionId, entryMode: 'n8n-orchestrator', state: 'in_progress' });
        }
        if (req.method === 'POST' && url.pathname === '/swat/next') {
            const b = await readBody(req);
            const run = swatRuns.get(b.runId);
            if (!run) return json(res, 404, { ok: false, error: 'Run inconnu' });
            if (run.failed) return json(res, 409, missionStatus(run));
            const next = run.graph.nodes.find((n) => !run.outputs[n.sessionId]
                && run.graph.edges.filter((e) => e.target === n.sessionId).every((e) => run.outputs[e.source]));
            if (!next) return json(res, 200, { ...missionStatus(run), done: true });
            const output = await swatStep({ runId: b.runId, sessionId: next.sessionId });
            return json(res, 200, { ...output, done: missionStatus(run).state === 'completed' });
        }
        if (req.method === 'POST' && url.pathname === '/swat/step') {
            return json(res, 200, await swatStep(await readBody(req)));
        }
        if (req.method === 'GET' && seg[0] === 'sessions') {
            const r = await bridgeRequest('list_acp_sessions', {
                providerId: url.searchParams.get('providerId') || '',
                workspaceRoot: url.searchParams.get('workspaceRoot') || WS_ROOT,
            }, 'acp_sessions_result', 10000);
            return json(res, 200, { ok: true, sessions: r.sessions || [] });
        }
        if (req.method === 'POST' && seg[0] === 'wake') {
            const b = await readBody(req);
            if (!b.providerId || !b.sessionId || !b.text) {
                return json(res, 400, { ok: false, error: 'providerId, sessionId, text requis' });
            }
            const r = await bridgeRequest('wake_acp_agent', {
                text: String(b.text), sessionId: String(b.sessionId), providerId: String(b.providerId),
                workspaceRoot: b.workspaceRoot || WS_ROOT, draft: b.draft === true,
            }, 'acp_wake_result', 20000);
            return json(res, 200, { ok: r.status === 'sent', status: r.status, requestId: r.requestId });
        }
        if (req.method === 'POST' && seg[0] === 'ask') {
            const b = await readBody(req);
            if (!b.providerId || !b.sessionId || !b.text) {
                return json(res, 400, { ok: false, error: 'providerId, sessionId, text requis' });
            }
            const convId = crypto.randomUUID();
            const text = b.raw === true ? String(b.text) : buildEnvelope(convId, String(b.text));
            const r = await bridgeRequest('wake_acp_agent', {
                text, sessionId: String(b.sessionId), providerId: String(b.providerId),
                workspaceRoot: b.workspaceRoot || WS_ROOT,
            }, 'acp_wake_result', 20000);
            if (r.status !== 'sent') return json(res, 502, { ok: false, status: r.status, convId });
            const hit = await waitCommsReply(convId, Number(b.timeoutSec) || DEFAULT_REPLY_TIMEOUT_S);
            return json(res, hit ? 200 : 504, { ok: !!hit, convId, reply: hit || null });
        }
        if (req.method === 'GET' && seg[0] === 'reply' && seg[1]) {
            const hit = await waitCommsReply(seg[1], Number(url.searchParams.get('timeout')) || 30);
            return json(res, hit ? 200 : 404, { ok: !!hit, reply: hit || null });
        }
        if (req.method === 'GET' && seg[0] === 'comms') {
            const n = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
            return json(res, 200, { ok: true, entries: commsEntries().slice(-n) });
        }
        if (req.method === 'GET' && url.pathname === '/n8n/workflows') {
            if (!N8N_API_KEY) return json(res, 503, { ok: false, error: 'N8N_API_KEY absent (env ou .agent/n8n-api.key)' });
            let r;
            try {
                r = await fetch(`${N8N_API_URL}/workflows?active=true&limit=100`, {
                    headers: { 'X-N8N-API-KEY': N8N_API_KEY }, signal: AbortSignal.timeout(10000),
                });
            } catch (err) {
                return json(res, 502, { ok: false, error: `n8n API injoignable: ${err?.message}`,
                    cause: err?.cause ? `${err.cause.code || ''} ${err.cause.message || ''}`.trim() : null });
            }
            const body = await r.json().catch(() => ({}));
            const list = (body.data || []).map((w) => {
                const nodes = Array.isArray(w.nodes) ? w.nodes : [];
                const webhook = nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
                const triggers = [...new Set(nodes
                    .filter((n) => /trigger|webhook/i.test(n.type))
                    .map((n) => n.type.replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, '')))];
                return {
                    id: w.id, name: w.name, active: w.active, updatedAt: w.updatedAt,
                    triggers,
                    webhookPath: webhook?.parameters?.path || null,
                    callable: Boolean(N8N_CALLABLE_WORKFLOWS[w.id]),
                    callableContract: N8N_CALLABLE_WORKFLOWS[w.id]?.contract || null,
                };
            });
            return json(res, r.status, { ok: r.ok, count: list.length, workflows: list });
        }

        if (req.method === 'POST' && url.pathname.startsWith('/n8n/workflows/') && url.pathname.endsWith('/invoke')) {
            const workflowId = decodeURIComponent(url.pathname.split('/')[3] || '');
            const spec = N8N_CALLABLE_WORKFLOWS[workflowId];
            if (!spec) {
                return json(res, 403, { ok: false, error: `workflow ${workflowId} non allowlisté — voir GET /n8n/workflows (callable:true)` });
            }
            const payload = await readBody(req).catch(() => ({}));
            const target = `http://127.0.0.1:5678/webhook/${spec.webhookPath}`;
            let r;
            const t0 = Date.now();
            try {
                r = await fetch(target, {
                    method: spec.method || 'POST',
                    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
                    body: JSON.stringify(payload && Object.keys(payload).length ? payload : {}),
                    signal: AbortSignal.timeout((spec.timeoutSec || 300) * 1000),
                });
            } catch (err) {
                fs.appendFileSync(COMMS_LOG, JSON.stringify({ ts: new Date().toISOString(), src: 'bridge-api',
                    dst: `n8n:${workflowId}`, kind: 'workflow-invoke',
                    text: JSON.stringify({ error: String(err?.message || err) }) }) + '\n');
                return json(res, 502, { ok: false, error: `webhook injoignable: ${err?.message}` });
            }
            const text = await r.text();
            let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 4000); }
            fs.appendFileSync(COMMS_LOG, JSON.stringify({ ts: new Date().toISOString(), src: 'bridge-api',
                dst: `n8n:${workflowId}`, kind: 'workflow-invoke',
                text: JSON.stringify({ name: spec.name, httpStatus: r.status, durationMs: Date.now() - t0,
                    input: JSON.stringify(payload).slice(0, 300) }) }) + '\n');
            return json(res, r.status === 200 ? 200 : r.status, { ok: r.ok, workflowId, name: spec.name, httpStatus: r.status, result: parsed });
        }
        if (req.method === 'POST' && url.pathname === '/agent') {
            const b = await readBody(req);
            if (!b.prompt?.trim()) return json(res, 400, { ok: false, error: 'prompt requis' });
            const convId = crypto.randomUUID();
            const timeoutMs = Math.min(Number(b.timeoutSec) * 1000 || N8N_AGENT_TIMEOUT_MS, 900000);
            const started = Date.now();
            const r = await fetch(N8N_AGENT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
                body: JSON.stringify({ prompt: String(b.prompt) }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const raw = await r.text();
            let body;
            try { body = JSON.parse(raw); } catch { body = { raw }; }
            fs.appendFileSync(COMMS_LOG, JSON.stringify({ ts: new Date().toISOString(), src: 'bridge-api',
                dst: 'n8n-agent-ia', kind: 'agent-call', convId,
                text: JSON.stringify({ prompt: String(b.prompt).slice(0, 300), status: r.status,
                    durationMs: Date.now() - started }) }) + '\n');
            return json(res, r.status, { ok: r.ok, convId, ...body });
        }
        json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
        json(res, 502, { ok: false, error: String(e?.message || e) });
    }
});
if (isMain) server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge-api] http://127.0.0.1:${PORT} -> ${WS_URL} (root=${WS_ROOT})`);
});
