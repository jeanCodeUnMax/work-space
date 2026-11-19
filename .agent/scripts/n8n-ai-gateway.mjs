/**
 * n8n-ai-gateway — Passerelle OpenAI-compatible unifiee pour n8n (Instance AI & AI Agent).
 *
 * Expose sur http://127.0.0.1:11435/v1 :
 *   - auto/*  ou hphe/* -> routeur multi-providers : rotation sur erreur/latence
 *     jusqu'a succes, score de confiance par modele (stats persistees).
 *   - devin/*        -> Devin CLI (ACP stdio). WHITELIST : swe-2-high, swe-2-max.
 *   - agy/*          -> Antigravity / Hermes (hub Connect-RPC local, cascade dediee)
 *   - omni/*         -> OmniRoute :20128 (1109 modeles + combos auto/* + fallback)
 *   - strata/*       -> Strata local :8080 (Qwen3.8-Flash-Next Q2_0 125B, prefixe epingle KV)
 *   - ollama-local/* -> Ollama local (http://127.0.0.1:11434/v1)
 *   - ollama-cloud/* -> Ollama Cloud (https://ollama.com/v1 si cle API, sinon Ollama local -cloud)
 *
 * Supporte GET /v1/models, GET /v1/confidence, POST /v1/chat/completions
 * (stream SSE et JSON, tool_calls). Model discovery : hphe-mcp available_models
 * via mux :5682 (cache 60s) alimente le pool annonce dans /v1/models.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const HOST = '127.0.0.1';
const PORT = Number(process.env.N8N_AI_GATEWAY_PORT || 11435);
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const OLLAMA_CLOUD_URL = (process.env.OLLAMA_CLOUD_URL || 'https://ollama.com/v1').replace(/\/+$/, '');
const OMNI_URL = (process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '');
const MUX_URL = (process.env.HPHE_MUX_URL || 'http://127.0.0.1:5682/tools/call').replace(/\/+$/, '');
const STRATA_URL = (process.env.STRATA_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');

function loadEnv(file) {
    const vars = {};
    try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* .env absent */ }
    return vars;
}

const env = { ...loadEnv(path.join(process.cwd(), '.env')), ...loadEnv('C:/data-sys/OmniRoute/.env'), ...process.env };
const OLLAMA_CLOUD_KEY = env.OLLAMA_CLOUD_API_KEY || env.OLLAMA_API_KEY || '';
const OMNI_KEY = env.OMNIROUTE_API_KEY || '';

/* Prompt systeme injecte a CHAQUE requête, tous modeles/routes.
   Source : fichier markdown (lignes '#' = commentaires, ignores).
   Chemin : N8N_AI_GATEWAY_SYSTEM_FILE ou .agent/config/assistant-system-prompt.md */
function loadSystemPrompt() {
    const candidates = [
        env.N8N_AI_GATEWAY_SYSTEM_FILE,
        path.join(process.cwd(), '.agent', 'config', 'assistant-system-prompt.md'),
        'C:/data-sys/n8n/.agent/config/assistant-system-prompt.md',
    ].filter(Boolean);
    for (const file of candidates) {
        try {
            const text = fs.readFileSync(file, 'utf8')
                .split('\n')
                .filter((l) => !l.trimStart().startsWith('#'))
                .join('\n')
                .trim();
            if (text) {
                console.log(`[n8n-ai-gateway] prompt systeme charge: ${file} (${text.length} chars)`);
                return text;
            }
        } catch { /* absent */ }
    }
    return 'You are the LLM backend of n8n Instance AI. Never narrate — '
        + 'call tools silently or give the final answer. User language, concise.';
}
const SYSTEM_PROMPT = loadSystemPrompt();

/* Protocole de decision "Gant de Kent" : charge pour la route decide/*.
   Force un format {alternatives, tenants, aboutissants, score, decision,
   consequences, verification} + obligation de verifier les faits. */
function loadDecisionPrompt() {
    const file = env.N8N_AI_GATEWAY_DECIDE_FILE
        || 'C:/data-sys/n8n/.agent/config/decision-protocol.md';
    try {
        const text = fs.readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('#'))
            .join('\n')
            .trim();
        if (text) {
            console.log(`[n8n-ai-gateway] protocole decision charge: ${file} (${text.length} chars)`);
            return text;
        }
    } catch { /* absent */ }
    return 'Decide by scoring weighted alternatives; verify every factual claim.';
}
const DECIDE_PROMPT = loadDecisionPrompt();

const AGY_STATIC_MODELS = [
    { id: 'agy/hermes', owned_by: 'antigravity', label: null },
    { id: 'agy/gemini-flash', owned_by: 'antigravity', label: 'Gemini 3.8 Flash (High)' },
    { id: 'agy/sonnet', owned_by: 'antigravity', label: 'Claude Sonnet 5.5 (High)' },
    { id: 'agy/gpt-oss', owned_by: 'antigravity', label: 'GPT-OSS 120B (Medium)' },
];

/* Whitelist Devin (regle : swe-2-high / swe-2-max uniquement) */
const DEVIN_ALLOWED = new Set(['swe-2-high', 'swe-2-max']);
const DEVIN_STATIC_MODELS = [
    { id: 'devin/swe-2-high', owned_by: 'devin', model: 'swe-2-high' },
    { id: 'devin/swe-2-max', owned_by: 'devin', model: 'swe-2-max' },
];

/* ---------- Helpers HTTP & OpenAI format ---------- */

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
}

function openAiError(res, status, message, type = 'gateway_error') {
    sendJson(res, status, { error: { message, type, param: null, code: null } });
}

function buildCompletionObject(model, content, toolCalls) {
    const message = { role: 'assistant', content: toolCalls?.length ? null : content };
    if (toolCalls?.length) message.tool_calls = toolCalls;
    return {
        id: `chatcmpl-${randomUUID().slice(0, 12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
}

/* fn() retourne soit un texte, soit { text, toolCalls, model } (tool_calls natifs,
   model = id effectif du provider route, visible dans le champ model de la reponse) */
function normAgentResult(r) {
    return typeof r === 'string' ? { text: r, toolCalls: null, model: null } : (r || { text: '', toolCalls: null, model: null });
}

async function runAgentWithKeepalive(res, model, stream, hasTools, fn) {
    if (!stream) {
        const r = normAgentResult(await fn());
        const toolCalls = r.toolCalls?.length ? r.toolCalls : parseToolCallsFromText(r.text, hasTools);
        return sendJson(res, 200, buildCompletionObject(r.model || model, r.text, toolCalls));
    }
    const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    let respModel = model;
    const emit = (delta, finishReason = null) => {
        if (res.writableEnded) return;
        const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: respModel,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    emit({ role: 'assistant' });
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 10000);
    try {
        const r = normAgentResult(await fn());
        clearInterval(heartbeat);
        if (r.model) respModel = r.model;
        const text = r.text || '';
        const toolCalls = r.toolCalls?.length ? r.toolCalls : parseToolCallsFromText(text, hasTools);
        if (toolCalls?.length) {
            emit({
                tool_calls: toolCalls.map((tc, index) => ({
                    index,
                    id: tc.id,
                    type: 'function',
                    function: tc.function,
                })),
            });
            emit({}, 'tool_calls');
        } else {
            emit({ content: text || '' });
            emit({}, 'stop');
        }
        if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    } catch (err) {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: { message: err?.message || String(err), type: 'gateway_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
}

/* ---------- Prompt & Tool Bridge pour agents autonomes (AGY / Devin) ---------- */

function formatPromptWithTools(messages, tools) {
    const parts = [];
    if (Array.isArray(tools) && tools.length > 0) {
        const toolList = tools.map((t) => {
            const fn = t.function || t;
            return `- ${fn.name}: ${fn.description || ''} | params: ${JSON.stringify(fn.parameters || {})}`;
        }).join('\n');
        parts.push(
            '[N8N_LLM_BACKEND]\n' +
            'You are acting strictly as the LLM backend for n8n Instance AI. Do NOT execute local shell, filesystem, or MCP tools yourself.\n' +
            '[SYSTEM TOOL PROTOCOL]\n' +
            'Available tools:\n' + toolList + '\n' +
            'If you need to call tool(s), respond ONLY with a JSON block:\n' +
            '<tool_call>{"tool_calls":[{"name":"<tool_name>","arguments":{...}}]}</tool_call>\n' +
            'Otherwise respond directly with your final answer.'
        );
    }
    for (const m of messages || []) {
        const role = (m.role || 'user').toUpperCase();
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.map((p) => (typeof p === 'string' ? p : p?.text || JSON.stringify(p))).join('\n')
                : JSON.stringify(m.content || '');
        const tcText = Array.isArray(m.tool_calls) && m.tool_calls.length
            ? `\n[tool_calls: ${JSON.stringify(m.tool_calls)}]`
            : '';
        parts.push(`[${role}${m.name ? `:${m.name}` : ''}]\n${text}${tcText}`);
    }
    return parts.join('\n\n');
}

function parseToolCallsFromText(text, hasTools) {
    if (!hasTools || !text) return null;
    const match = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text);
    const candidate = match ? match[1] : text.trim();
    if (!candidate.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(candidate);
        const list = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : (parsed.name ? [parsed] : null);
        if (!list?.length) return null;
        return list.map((tc) => ({
            id: `call_${randomUUID().slice(0, 12)}`,
            type: 'function',
            function: {
                name: String(tc.name),
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
        }));
    } catch {
        return null;
    }
}

/* ---------- Provider 1 : Antigravity / Hermes (hub Connect-RPC) ---------- */

const AGY_SERVICE = '/exa.language_server_pb.LanguageServerService';
let dedicatedAgyCascadeId = null;

function discoverAgyHub() {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agy.exe' -and $_.CommandLine -match '--hub-port' } | Select-Object CommandLine | ConvertTo-Json -Compress`;
    const out = execSync(`powershell.exe -NoProfile -Command "${ps}"`, {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).trim();
    if (!out) throw new Error('Antigravity hub introuvable (agy.exe non lance)');
    let rows = JSON.parse(out);
    if (!Array.isArray(rows)) rows = [rows];
    for (const r of rows) {
        const cl = r.CommandLine || '';
        const port = /--hub-port[=\s](\d+)/.exec(cl)?.[1];
        const csrf = /--csrf_token[=\s]([0-9a-fA-F-]+)/.exec(cl)?.[1];
        if (port && csrf) return { port: Number(port), csrfToken: csrf };
    }
    throw new Error('Antigravity hub sans port/csrfToken');
}

function agyRpc(hub, method, body, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: hub.port,
            path: `${AGY_SERVICE}/${method}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-codeium-csrf-token': hub.csrfToken,
                'connect-protocol-version': '1',
            },
            timeout: timeoutMs,
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                let j = {};
                try { j = d ? JSON.parse(d) : {}; } catch { /* non-JSON */ }
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

async function ensureAgyCascade(hub) {
    if (dedicatedAgyCascadeId) {
        try {
            await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId: dedicatedAgyCascadeId }, 5000);
            return dedicatedAgyCascadeId;
        } catch {
            dedicatedAgyCascadeId = null;
        }
    }
    const created = await agyRpc(hub, 'StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT' });
    dedicatedAgyCascadeId = created.cascadeId;
    return dedicatedAgyCascadeId;
}

function pickAgyPlanModel(cfg, requestedLabel) {
    const configs = (cfg?.clientModelConfigs || []).filter((c) => !c.disabled);
    if (requestedLabel) {
        const exact = configs.find((c) => c.label === requestedLabel);
        if (exact?.modelOrAlias?.model) return exact.modelOrAlias.model;
    }
    const order = ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'GPT-OSS 120B (Medium)', 'Claude Sonnet 5.5 (High)'];
    for (const label of order) {
        const match = configs.find((c) => c.label === label && (c?.quotaInfo?.remainingFraction ?? 0) >= 0.05);
        if (match?.modelOrAlias?.model) return match.modelOrAlias.model;
    }
    const any = configs.find((c) => (c?.quotaInfo?.remainingFraction ?? 0) >= 0.05 && c?.modelOrAlias?.model);
    if (any) return any.modelOrAlias.model;
    const def = cfg?.defaultOverrideModelConfig?.modelOrAlias?.model;
    if (def) return def;
    throw new Error('Aucun modele Antigravity disponible avec quota');
}

async function callAntigravity(modelId, prompt) {
    const hub = discoverAgyHub();
    const cascadeId = await ensureAgyCascade(hub);
    const meta = AGY_STATIC_MODELS.find((m) => m.id === modelId);
    const cfg = await agyRpc(hub, 'GetCascadeModelConfigData', {});
    const planModel = pickAgyPlanModel(cfg, meta?.label || null);
    const before = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId });
    const since = (before.steps || []).length;

    await agyRpc(hub, 'SendUserCascadeMessage', {
        cascadeId,
        items: [{ text: prompt }],
        cascadeConfig: { plannerConfig: { planModel } },
    });
    await agyRpc(hub, 'WaitForConversationFullyIdle', {
        conversationId: cascadeId,
        inactivityTimeoutSeconds: 180,
        stabilizationDurationSeconds: 2,
        returnOnExecutorError: true,
    }, 200000);

    const after = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId });
    const replies = (after.steps || [])
        .slice(since)
        .filter((s) => s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE')
        .map((s) => s.plannerResponse?.modifiedResponse || s.plannerResponse?.response || '')
        .filter(Boolean);
    if (!replies.length) throw new Error('Antigravity n a retourne aucune reponse');
    return replies.join('\n');
}

/* ---------- Provider 2 : Devin CLI headless ---------- */

function resolveDevinAuth() {
    if (env.DEVIN_API_KEY) return { apiKey: env.DEVIN_API_KEY, apiServerUrl: env.DEVIN_API_SERVER_URL || '' };
    if (env.WINDSURF_API_KEY) return { apiKey: env.WINDSURF_API_KEY, apiServerUrl: env.WINDSURF_API_SERVER_URL || '' };
    for (const credPath of [
        path.join(os.homedir(), 'AppData', 'Roaming', 'devin', 'credentials.toml'),
        path.join(os.homedir(), '.devin', 'credentials.toml'),
    ]) {
        try {
            const toml = fs.readFileSync(credPath, 'utf8');
            const key = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(toml);
            const url = /api_server_url\s*=\s*"([^"]+)"/.exec(toml);
            if (key) return { apiKey: key[1], apiServerUrl: url ? url[1] : '' };
        } catch { /* absent */ }
    }
    return { apiKey: '', apiServerUrl: '' };
}

const DEVIN_AUTH = resolveDevinAuth();
const DEVIN_AGENT_CWD = env.N8N_DEVIN_AGENT_CWD || process.cwd();
const DEVIN_SESSION_ID = env.N8N_DEVIN_SESSION_ID || 'ionian-sphere';

function callDevin(modelId, prompt) {
    const devinModel = modelId.replace(/^devin\//, '') || 'swe-2-high';
    return new Promise((resolve, reject) => {
        if (!DEVIN_AUTH.apiKey) {
            return reject(new Error(`Devin ACP (${devinModel}): aucune cle API. Definir DEVIN_API_KEY dans .env ou lancer 'devin auth login' (credentials.toml).`));
        }
        const agentCwd = DEVIN_AGENT_CWD;
        let targetSession = DEVIN_SESSION_ID;
        const child = spawn('devin', ['acp', '--model', devinModel], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: agentCwd,
        });
        let buf = '';
        let reqId = 1;
        let text = '';
        let settled = false;
        let stage = 'init';
        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill(); } catch { /* ignore */ }
            if (err) reject(err);
            else resolve(val);
        };
        const timer = setTimeout(() => finish(new Error(`Devin ACP (${devinModel}) timeout (300s)`)), 300000);
        const send = (method, params) => {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId++, method, params }) + '\n');
        };
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.method === 'session/update' && msg.params?.update?.sessionUpdate === 'agent_message_chunk') {
                    text += msg.params.update.content?.text || '';
                }
                if (msg.error) {
                    if (msg.id === 3 && targetSession) {
                        targetSession = '';
                        send('session/new', { cwd: agentCwd, mcpServers: [] });
                        continue;
                    }
                    return finish(new Error(`Devin ACP (${devinModel}): ${msg.error.message || JSON.stringify(msg.error)}`));
                }
                if (msg.id === 1) {
                    send('authenticate', {
                        methodId: 'windsurf-api-key',
                        _meta: { api_key: DEVIN_AUTH.apiKey, api_server_url: DEVIN_AUTH.apiServerUrl },
                    });
                } else if (msg.id === 2) {
                    if (targetSession) send('session/load', { sessionId: targetSession, cwd: agentCwd, mcpServers: [] });
                    else send('session/new', { cwd: agentCwd, mcpServers: [] });
                } else if (msg.id === 3 || (msg.id === 4 && stage === 'init')) {
                    stage = 'prompt';
                    text = '';
                    send('session/prompt', { sessionId: msg.result.sessionId || targetSession, prompt: [{ type: 'text', text: prompt }] });
                } else if (msg.id !== undefined && stage === 'prompt') {
                    const out = text.trim();
                    if (!out) return finish(new Error(`Devin ACP (${devinModel}) reponse vide`));
                    return finish(null, out);
                }
            }
        });
        child.on('error', (err) => finish(err));
        child.on('close', (code) => {
            if (!settled) finish(new Error(`Devin ACP (${devinModel}) ferme prematurement (code ${code})`));
        });
        send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    });
}

/* ---------- Provider 3 & 4 : Ollama Local & Ollama Cloud ---------- */

async function fetchOllamaModels() {
    try {
        const res = await fetch(`${OLLAMA_URL}/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const json = await res.json();
        return Array.isArray(json.data) ? json.data : [];
    } catch {
        return [];
    }
}

async function proxyOllamaChat(reqBody, res, targetModel, isCloud) {
    const useRemoteCloud = isCloud && Boolean(OLLAMA_CLOUD_KEY);
    const upstreamUrl = useRemoteCloud
        ? `${OLLAMA_CLOUD_URL}/chat/completions`
        : `${OLLAMA_URL}/v1/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if (useRemoteCloud) headers.authorization = `Bearer ${OLLAMA_CLOUD_KEY}`;

    const payload = { ...reqBody, model: targetModel };
    const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    const outHeaders = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
    res.writeHead(upstream.status, outHeaders);
    if (reqBody.stream && upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
        return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
}

/* ---------- Provider 4b : Strata local (:8080 — Qwen3.8-Flash-Next Q2_0 125B, 2 GPU) ----------
   Injecte strata_prefix {"messages":1} quand le message[0] est system : la gateway
   prepend deja SYSTEM_PROMPT => ce prefixe est epingle en KV, chaque requete
   saute son prefill (mesure : ~24s -> ~0.3s sur prefixe 22k tok).
   N8N_AI_GATEWAY_STRATA_PIN=0 pour desactiver. */
async function proxyStrataChat(reqBody, res, targetModel) {
    const payload = { ...reqBody, model: targetModel || 'qwen3.8-flash-next-q2_0' };
    if (env.N8N_AI_GATEWAY_STRATA_PIN !== '0'
        && payload.strata_prefix === undefined
        && payload.messages?.[0]?.role === 'system') {
        payload.strata_prefix = { messages: 1 };
    }
    const upstream = await fetch(`${STRATA_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    if (reqBody.stream && upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
        return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
}

/* ---------- Route audit/ : boucle generateur->validateur->correcteur ----------
   Le validateur joue le role de compilateur : parse JSON + checks schema n8n
   (format connections, champs node requis). Si erreurs -> renvoyees au modele
   pour correction, max 3 tentatives. Reponse = completion OpenAI classique
   + champ 'audit' {attempts, valid, corrected, errors}. Force stream=false
   (il faut le texte complet pour valider). */
function extractJsonCandidate(text) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const raw = (fence ? fence[1] : text).trim();
    const start = raw.search(/[{[]/);
    return start >= 0 ? raw.slice(start) : raw;
}

function validateN8nWorkflow(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return ['la racine n est pas un objet JSON'];
    }
    const looksLikeWorkflow = 'nodes' in parsed || 'connections' in parsed;
    if (!looksLikeWorkflow) return errors;
    if (!Array.isArray(parsed.nodes)) {
        errors.push('"nodes" manquant ou n est pas un tableau');
    } else {
        parsed.nodes.forEach((n, i) => {
            if (!n || typeof n !== 'object') { errors.push(`nodes[${i}]: pas un objet`); return; }
            if (!n.name) errors.push(`nodes[${i}]: "name" manquant`);
            if (!n.type) errors.push(`nodes[${i}]: "type" manquant`);
            if (n.parameters === undefined) errors.push(`nodes[${i}]: "parameters" manquant`);
            if (n.type === 'n8n-nodes-base.webhook' && typeof n.parameters?.path === 'string'
                && n.parameters.path.startsWith('/webhook')) {
                errors.push(`nodes[${i}] (${n.name}): path "${n.parameters.path}" — n8n ajoute deja le prefixe /webhook, mettre juste le segment (ex: "cpu-alert")`);
            }
        });
    }
    if (parsed.connections !== undefined) {
        if (!parsed.connections || typeof parsed.connections !== 'object' || Array.isArray(parsed.connections)) {
            errors.push('"connections" n est pas un objet');
        } else {
            const nodeNames = new Set((parsed.nodes || []).map((n) => n?.name).filter(Boolean));
            for (const [src, outs] of Object.entries(parsed.connections)) {
                if (!outs || typeof outs !== 'object' || Array.isArray(outs)) {
                    errors.push(`connections.${src}: valeur pas un objet {main:[[...]]}`); continue;
                }
                for (const key of Object.keys(outs)) {
                    if (key !== 'main' && key !== 'error') {
                        errors.push(`connections.${src}: cle "${key}" invalide — n8n utilise "main" (branche true=main[0], false=main[1] pour IF)`);
                    }
                }
                const branches = outs.main || [];
                if (!Array.isArray(branches)) { errors.push(`connections.${src}.main: pas un tableau`); continue; }
                branches.flat().forEach((c) => {
                    if (typeof c === 'string') errors.push(`connections.${src}: connexion en string "${c}" — objet {node,type:"main",index:0} attendu`);
                    else if (c && typeof c === 'object') {
                        if (c.node === undefined) errors.push(`connections.${src}: "node" manquant`);
                        else if (nodeNames.size && !nodeNames.has(c.node)) errors.push(`connections.${src}: cible "${c.node}" inexistante dans nodes[]`);
                        if (c.type === undefined) errors.push(`connections.${src}->${c.node}: "type" manquant (attendu "main")`);
                    }
                });
            }
        }
    }
    return errors;
}

/* Une passe de chat Strata (non-stream), avec pin KV si messages[0] est system.
   Prefixe 'oll:' -> llama-server local ; 'omni:' -> OmniRoute cloud (meme signature). */
async function strataChatOnce(reqBody, messages, targetModel) {
    if (targetModel?.startsWith('oll:')) {
        return await ollamaChatOnce(reqBody, messages, targetModel.slice(4));
    }
    if (targetModel?.startsWith('omni:')) {
        const headers = { 'content-type': 'application/json' };
        if (OMNI_KEY) headers.authorization = `Bearer ${OMNI_KEY}`;
        const r = await fetch(`${OMNI_URL}/chat/completions`, {
            method: 'POST', headers,
            body: JSON.stringify({ ...reqBody, model: targetModel.slice(5), messages, stream: false }),
        });
        return r.json().catch(() => null);
    }
    const payload = { ...reqBody, messages, model: targetModel || 'qwen3.8-flash-next-q2_0', stream: false };
    if (env.N8N_AI_GATEWAY_STRATA_PIN !== '0'
        && payload.strata_prefix === undefined
        && messages[0]?.role === 'system') {
        payload.strata_prefix = { messages: 1 };
    }
    const upstream = await fetch(`${STRATA_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return upstream.json().catch(() => null);
}

/* Boucle generateur->validateur->correcteur, composable.
   Retourne {text, parsed, errors, attempts, data, messages} — ecrit rien sur res. */
async function runAuditLoop(reqBody, targetModel, seedMessages) {
    const maxAttempts = Math.min(Math.max(Number(reqBody.audit_retries) || Number(loadRouteTuning().audit_retries) || 3, 1), 5);
    const messages = [...(seedMessages || reqBody.messages || [])];
    let lastErrors = ['aucune tentative'], lastData = null, lastText = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const data = await strataChatOnce(reqBody, messages, targetModel);
        lastData = data;
        const text = data?.choices?.[0]?.message?.content || '';
        lastText = text;
        /* audit_json:false -> livrable texte libre : pas de validation JSON,
           la 1ere reponse non-vide est le resultat */
        if (reqBody.audit_json === false) {
            return { text, parsed: null, errors: text.trim() ? [] : ['reponse vide'], attempts: attempt, data, messages };
        }
        let parsed = null, errors = [];
        try {
            parsed = JSON.parse(extractJsonCandidate(text));
            errors = validateN8nWorkflow(parsed);
        } catch (e) {
            errors = [`JSON non analysable: ${e.message}`];
        }
        if (errors.length === 0) {
            return { text, parsed, errors: [], attempts: attempt, data, messages };
        }
        lastErrors = errors;
        messages.push(
            { role: 'assistant', content: text },
            { role: 'user', content: `Le JSON precedent a ${errors.length} erreur(s): ${errors.join(' | ')}. Corrige et renvoie UNIQUEMENT le JSON valide, rien d autre.` },
        );
    }
    return { text: lastText, parsed: null, errors: lastErrors, attempts: maxAttempts, data: lastData, messages };
}

async function proxyStrataAudit(reqBody, res, targetModel) {
    const r = await runAuditLoop(reqBody, targetModel);
    const audit = { attempts: r.attempts, valid: r.errors.length === 0, corrected: r.attempts > 1 && r.errors.length === 0, errors: r.errors };
    if (audit.valid) {
        if (r.data) { r.data.audit = audit; }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(r.data || { valid: r.parsed, audit }));
    }
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `audit echoue apres ${r.attempts} tentatives`, type: 'audit_failed' }, audit }));
}

/* ---------- Route orchestrate/ : decide -> audit chaines ----------
   Passe 1 : le protocole Gant de Kent analyse la tache et choisit l approche.
   Passe 2 : la boucle audit produit le livrable avec auto-correction.
   Reponse : {decision, result(completion OpenAI), audit}. stream force a off. */
async function proxyStrataOrchestrate(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const userTask = taskMsg?.content || '';
    const decideBody = { ...reqBody, messages: [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: `Tache a orchestrer: ${userTask}` },
    ] };
    const decideData = await strataChatOnce(decideBody, decideBody.messages, targetModel);
    const decideText = decideData?.choices?.[0]?.message?.content || '';
    let decision = null;
    try { decision = JSON.parse(extractJsonCandidate(decideText)); } catch { /* texte libre */ }
    const approach = decision?.decision || decideText.slice(0, 500);

    const auditMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(reqBody.messages || []).filter((m) => m?.role !== 'system'),
        { role: 'user', content: `Approche retenue par le moteur de decision: ${approach}` },
    ];
    const r = await runAuditLoop(reqBody, targetModel, auditMessages);
    const audit = { attempts: r.attempts, valid: r.errors.length === 0, corrected: r.attempts > 1 && r.errors.length === 0, errors: r.errors };
    const out = {
        orchestrate: true,
        decision: decision || { raw: decideText.slice(0, 1000) },
        result: r.data || { content: r.text },
        audit,
    };
    res.writeHead(audit.valid ? 200 : 422, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
}

/* ---------- Route enquete/ : raisonnement a l envers (preuves d abord) ----------
   Anti-confabulation : la plupart des LLM raisonnent tete baissee sur des
   premisses inventees. Ici on inverse l ordre :
   Phase A (inventaire) : le modele liste les FAITS dont il aurait besoin,
     chacun tague verifiable/service ou supposition.
   Phase B (collecte)   : la gateway mesure ce qui est mesurable (sondes live).
   Phase C (raison)     : decide/ avec premisses etiquetees
     PROUVE (mesure) vs SUPPOSE (non verifie) — le raisonnement s appuie sur
     les premiers et isole les seconds. stream force a off. */
const ENQUETE_PROMPT = `Tu es un analyste. AVANT de repondre, liste les FAITS dont la reponse depend.
Pour chacun : {"fait":"...","verifiable":true|false,"service":"n8n|gateway|strata|omniroute|mux|ws-ask|aucun","mesure":"quelle mesure precise prouverait ce fait (ex: 'n8n repond HTTP 200','latence <5s') ou 'aucune'","pourquoi":"1 phrase"}
verifiable=true UNIQUEMENT si un etat UP/DOWN d un service local suffit a le prouver.
Une propriete interne (architecture, qualite, latence non sondee) n est PAS verifiable par nos sondes.
Reponds UNIQUEMENT en JSON array.`;

async function proxyStrataEnquete(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const userTask = taskMsg?.content || '';

    /* Phase A : inventaire des faits necessaires (passe legere — think reduit
       sinon le budget est mange par reasoning_content et content reste vide) */
    const invBody = { ...reqBody, max_tokens: 800, temperature: 0.2, reasoning_effort: 'low', messages: [
        { role: 'system', content: ENQUETE_PROMPT },
        { role: 'user', content: userTask },
    ] };
    const invData = await strataChatOnce(invBody, invBody.messages, targetModel);
    const invMsg = invData?.choices?.[0]?.message || {};
    const invText = invMsg.content || invMsg.reasoning_content || '';
    let faits = [];
    try { faits = JSON.parse(extractJsonCandidate(invText)); } catch { /* inventaire illisible */ }
    if (!Array.isArray(faits)) faits = [];

    /* Phase B : collecte — les faits "verifiable" sont mesures pour de vrai */
    const needProbe = faits.some((f) => f?.verifiable && f?.service && f.service !== 'aucun');
    const mesures = needProbe ? await probeServices() : null;
    const premisses = faits.map((f) => ({
        fait: f?.fait || '?',
        statut: classifyPremise(f, mesures),
        service: f?.service || 'aucun',
        mesure: f?.mesure || '',
        pourquoi: f?.pourquoi || '',
    }));

    /* Phase C : raisonnement — decide/ ne s appuie que sur le mesure */
    const reasonMsgs = [
        { role: 'system', content: DECIDE_PROMPT },
        ...(reqBody.messages || []),
        { role: 'user', content: [
            `PREMISSES CLASSEES (ordre inverse du raisonnement standard : faits d abord, inference ensuite):`,
            JSON.stringify(premisses),
            mesures ? `MESURES LIVE REELLES: ${mesures}` : `Aucune mesure disponible — traite tout comme SUPPOSE.`,
            `Regles: 1) toute premisse PROUVE_PAR_SONDE est un fait. 2) toute premisse VERIFIABLE_NON_MESURE ou SUPPOSE_NON_VERIFIE est une hypothese — dis comment la mesurer. 3) si une premisse critique n est pas PROUVE, dis ce qu il faudrait sonder avant de conclure.`,
        ].join('\n') },
    ];
    const reasonData = await strataChatOnce(reqBody, reasonMsgs, targetModel);
    const reasonMsg = reasonData?.choices?.[0]?.message || {};
    const reasonText = reasonMsg.content || reasonMsg.reasoning_content || '';
    let raisonnement = null;
    try { raisonnement = JSON.parse(extractJsonCandidate(reasonText)); } catch { /* texte libre */ }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        enquete: true,
        phases: {
            inventaire: premisses,
            collecte: mesures ? { sondes: mesures } : { sondes: null, note: 'aucun fait verifiable' },
            raisonnement: raisonnement || { raw: reasonText.slice(0, 2000) },
        },
    }));
}

/* ---------- Store de premisses partage (pensee systemique) ----------
   Invariante anti-patchwork : tout fait porte un tag de provenance.
   Les organes lisent/ecrivent le meme format -> ils sont composables
   comme des fonctions pures, pas des pipelines soudes. */
const PREMISSES_FILE = env.N8N_AI_GATEWAY_PREMISSES_FILE || 'C:/data-sys/n8n/.agent/gym/premisses.jsonl';
/* ---------- BDD cognitive : cognition.db (node:sqlite, zero dependance) ----------
   premisses.jsonl = event log immuable (fait + provenance).
   cognition.db = index requetable : table actions (chaque appel d organe) +
   table croyances (miroir beliefsNow pour SQL). La memoire devient queryable. */
const COGNITION_DB = env.N8N_AI_GATEWAY_COGNITION_DB || 'C:/data-sys/n8n/.agent/gym/cognition.db';
let _db = null;
function cogDb() {
    if (!_db) {
        try {
            _db = new DatabaseSync(COGNITION_DB);
            _db.exec(`CREATE TABLE IF NOT EXISTS actions(
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT,
                organe TEXT, tache TEXT, ms INTEGER, detail TEXT)`);
            _db.exec(`CREATE TABLE IF NOT EXISTS croyances(
                cle TEXT PRIMARY KEY, statut TEXT, fait TEXT, source TEXT, ts TEXT)`);
            _db.exec(`CREATE TABLE IF NOT EXISTS souvenirs(
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, statut TEXT,
                fait TEXT, source TEXT, vec TEXT)`);
        } catch { _db = null; }
    }
    return _db;
}
function logAction(organe, tache, ms, detail = '') {
    try {
        cogDb()?.prepare('INSERT INTO actions(ts,organe,tache,ms,detail) VALUES(?,?,?,?,?)')
            .run(new Date().toISOString(), organe, String(tache).slice(0, 160), Math.round(ms), String(detail).slice(0, 300));
    } catch { /* log optionnel */ }
}
/* ---------- Memoire vectorielle : embeddings via nim_embed (canal mux hphe-mcp) --
   Chaque premisse recoit un vecteur 2048D ; la recherche semantique = cosine
   brute en JS (instantane a notre echelle — pgvector serait du sur-equipement). */
const HPHE_MUX_URL = env.HPHE_MUX_URL || 'http://127.0.0.1:5682';
async function embedText(text) {
    try {
        const r = await fetch(`${HPHE_MUX_URL}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hephaistos-everything-search__nim_embed', arguments: { text } } }),
            signal: AbortSignal.timeout(20000),
        });
        const d = await r.json();
        const inner = JSON.parse(d?.result?.content?.[0]?.text || '{}');
        return inner?.embeddings?.[0] || null;
    } catch { return null; }
}
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
async function storeSouvenir(p) {
    try {
        const vec = await embedText(p.fait || '');
        if (!vec) return;
        cogDb()?.prepare('INSERT INTO souvenirs(ts,statut,fait,source,vec) VALUES(?,?,?,?,?)')
            .run(new Date().toISOString(), p.statut || '', (p.fait || '').slice(0, 200), p.source || '', JSON.stringify(vec));
    } catch { /* */ }
}
/* Backfill : au demarrage, vectoriser les premisses deja au store */
let _backfillDone = false;
async function backfillSouvenirs() {
    if (_backfillDone) return;
    _backfillDone = true;
    try {
        const have = new Set((cogDb()?.prepare('SELECT fait FROM souvenirs').all() || []).map((r) => r.fait));
        const all = readPremisses().filter((p) => !have.has((p.fait || '').slice(0, 200)));
        for (const p of all) { await storeSouvenir({ ...p, fait: (p.fait || '').slice(0, 200) }); }
        if (all.length) console.log(`[n8n-ai-gateway] souvenirs vectorises: ${all.length}`);
    } catch { /* */ }
}

async function semanticSearch(query, k = 5) {
    const qvec = await embedText(query);
    if (!qvec) return { error: 'embedding indisponible' };
    let rows = [];
    try { rows = cogDb()?.prepare('SELECT id,ts,statut,fait,source,vec FROM souvenirs ORDER BY id DESC LIMIT 1000').all() || []; } catch { /* */ }
    const scored = rows.map((r) => {
        try { return { ...r, score: cosine(qvec, JSON.parse(r.vec)) }; } catch { return { ...r, score: -1 }; }
    }).sort((x, y) => y.score - x.score).slice(0, k)
        .map(({ vec, ...rest }) => rest);
    return { query, dim: qvec.length, souvenirs_indexes: rows.length, resultats: scored };
}

function syncCroyances() {
    try {
        const { actifs, retractes } = beliefsNow();
        const db = cogDb();
        if (!db) return;
        db.exec('DELETE FROM croyances');
        const ins = db.prepare('INSERT OR REPLACE INTO croyances(cle,statut,fait,source,ts) VALUES(?,?,?,?,?)');
        for (const p of [...actifs, ...retractes]) {
            ins.run((p.fait || '').slice(0, 60), p.statut || '', (p.fait || '').slice(0, 200), p.source || '', p.ts || '');
        }
    } catch { /* */ }
}
const PREMISSES_MAX = 200;
function appendPremisses(list) {
    if (!list.length) return;
    try {
        fs.mkdirSync(path.dirname(PREMISSES_FILE), { recursive: true });
        const lines = list.map((p) => JSON.stringify({ ...p, ts: new Date().toISOString() })).join('\n') + '\n';
        fs.appendFileSync(PREMISSES_FILE, lines);
        /* trim si trop gros : garde les N dernieres */
        const all = fs.readFileSync(PREMISSES_FILE, 'utf8').trim().split('\n');
        if (all.length > PREMISSES_MAX) fs.writeFileSync(PREMISSES_FILE, all.slice(-PREMISSES_MAX).join('\n') + '\n');
        for (const p of list) storeSouvenir(p); /* embedding async — fire and forget */
    } catch { /* store optionnel */ }
}
function readPremisses() {
    try {
        return fs.readFileSync(PREMISSES_FILE, 'utf8').trim().split('\n')
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).slice(-40);
    } catch { return []; }
}

/* Projection event-sourcing : le log est immuable, la CROYANCE est derivee.
   Un fait plus recent sur le meme sujet remplace l ancien ; INFIRME retracte.
   Cle = prefixe normalise du fait. Retour : {actifs, retractes}. */
function beliefsNow() {
    const all = (() => { try {
        return fs.readFileSync(PREMISSES_FILE, 'utf8').trim().split('\n')
            .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; } })();
    const byKey = new Map();
    for (const p of all) {
        const key = (p.fait || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 6).join(' ');
        if (!key) continue;
        byKey.set(key, p); /* le dernier gagne — retraction naturelle */
    }
    const actifs = [], retractes = [];
    for (const p of byKey.values()) {
        if (['INFIRME', 'SUPPOSE_NON_VERIFIE', 'INDETERMINE'].includes(p.statut)) retractes.push(p);
        else actifs.push(p);
    }
    return { actifs, retractes };
}

/* ---------- Route systeme/ : pensee systemique (composition d organes) ----------
   Passe 1 (plan)   : un planificateur choisit la SEQUENCE d organes pertinente
     (enquete, decide, audit) — jamais un seul, jamais plus que necessaire.
   Passe 2 (exec)   : chaque organe tourne et lit le store de premisses
     (contexte systemique : les faits deja prouves par les appels precedents).
   Passe 3 (synthese): les conclusions citent leur provenance — un SUPPOSE ne
     devient jamais PROUVE par l iteration. La logique est garantie par le
     format des faits, pas par la discipline du modele. */
const SYSTEME_PLAN_PROMPT = `Tu es un planificateur de raisonnement. Pour la tache donnee, choisis la SEQUENCE d organes parmi:
enquete = inventorier+mesurer les faits necessaires (toujours en premier si des faits manquent)
decide  = scorer des alternatives et trancher
audit   = produire et auto-corriger un livrable structure
Reponds UNIQUEMENT en JSON: {"seq":["enquete","decide"],"pourquoi":"1 phrase"}`;

async function proxyStrataSysteme(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const userTask = taskMsg?.content || '';
    const t0 = Date.now();
    const known = readPremisses();
    const storeCtx = known.length
        ? `STORE SYSTEMIQUE (faits deja etablis par des appels precedents): ${JSON.stringify(known.slice(-15))}`
        : `STORE SYSTEMIQUE: vide — aucun fait n est encore prouve.`;

    /* Passe 1 : planification */
    const planBody = { ...reqBody, max_tokens: 200, temperature: 0.2, reasoning_effort: 'low', messages: [
        { role: 'system', content: SYSTEME_PLAN_PROMPT },
        { role: 'user', content: userTask },
    ] };
    const planData = await strataChatOnce(planBody, planBody.messages, targetModel);
    const planMsg = planData?.choices?.[0]?.message || {};
    let plan = null;
    try { plan = JSON.parse(extractJsonCandidate(planMsg.content || planMsg.reasoning_content || '')); } catch { /* plan libre */ }
    const seq = Array.isArray(plan?.seq) ? plan.seq.filter((s) => ['enquete', 'decide', 'audit'].includes(s)) : ['enquete', 'decide'];

    /* Passe 2 : execution des organes — le store grandit a chaque etape.
       Par defaut chaque organe recoit SON cerveau (ORGAN_TIER) ; un suffixe
       explicite 'systeme/modele' force le meme cerveau partout. */
    const perOrgan = targetModel === ORGAN_TIER.systeme;
    const stepModel = (o) => perOrgan ? (ORGAN_TIER[o] || targetModel) : targetModel;
    const trace = [];
    let mesures = null;
    if (seq.includes('enquete')) {
        /* enquete inline : inventaire + sondes si besoin */
        const invBody = { ...reqBody, max_tokens: 800, temperature: 0.2, reasoning_effort: 'low', messages: [
            { role: 'system', content: ENQUETE_PROMPT },
            { role: 'user', content: `${storeCtx}\n\nTache: ${userTask}` },
        ] };
        const invData = await strataChatOnce(invBody, invBody.messages, stepModel('enquete'));
        const invMsg = invData?.choices?.[0]?.message || {};
        let faits = [];
        try { faits = JSON.parse(extractJsonCandidate(invMsg.content || invMsg.reasoning_content || '')); } catch { /* */ }
        if (!Array.isArray(faits)) faits = [];
        const needProbe = faits.some((f) => f?.verifiable && f?.service && f.service !== 'aucun');
        mesures = needProbe ? await probeServices() : null;
        const premisses = faits.map((f) => ({
            fait: f?.fait || '?',
            statut: classifyPremise(f, mesures),
            service: f?.service || 'aucun',
            mesure: f?.mesure || '',
        }));
        appendPremisses(premisses.map((p) => ({ ...p, source: 'enquete', tache: userTask.slice(0, 120) })));
        trace.push({ organe: 'enquete', faits: premisses.length, mesures });
    }

    if (seq.includes('decide')) {
        const storeNow = readPremisses();
        const decideMsgs = [
            { role: 'system', content: DECIDE_PROMPT },
            ...(reqBody.messages || []),
            { role: 'user', content: [
                `FAITS DISPONIBLES (provenance respectee — SUPPOSE reste une hypothese):`,
                JSON.stringify(storeNow.slice(-20)),
                mesures ? `MESURES LIVE: ${mesures}` : '',
                `Tache: ${userTask}`,
            ].join('\n') },
        ];
        const decideData = await strataChatOnce(reqBody, decideMsgs, stepModel('decide'));
        const dMsg = decideData?.choices?.[0]?.message || {};
        const dText = dMsg.content || dMsg.reasoning_content || '';
        let decision = null;
        try { decision = JSON.parse(extractJsonCandidate(dText)); } catch { /* */ }
        if (decision?.decision) {
            appendPremisses([{ fait: `decision: ${String(decision.decision).slice(0, 200)}`, statut: 'DECIDE', source: 'systeme' }]);
        }
        trace.push({ organe: 'decide', decision: decision || { raw: dText.slice(0, 1500) } });
    }

    let auditParsed = null;
    if (seq.includes('audit')) {
        const AUDIT_SYS_PROMPT = `Tu es l organe AUDIT d un pipeline cognitif. On te donne une tache, les faits du store et la decision prise.
Verifie : coherence decision/faits, trous (ce qui manque pour trancher), risques.
Reponds UNIQUEMENT en JSON : {"verdict":"solide|fragile|insuffisant","points_forts":["..."],"trous":["..."],"risques":["..."],"recommandation":"..."}`;
        const decisionTxt = trace.find((t) => t.organe === 'decide')?.decision;
        const r = await runAuditLoop(reqBody, stepModel('audit'), [
            { role: 'system', content: AUDIT_SYS_PROMPT },
            { role: 'user', content: `Tache: ${userTask}\n\nDECISION PRISE:\n${JSON.stringify(decisionTxt || 'aucune').slice(0, 2000)}\n\nFAITS:\n${JSON.stringify(readPremisses().slice(-15)).slice(0, 2000)}` },
        ]);
        const aContent = r.data?.choices?.[0]?.message?.content || '';
        try { auditParsed = JSON.parse(extractJsonCandidate(aContent)); } catch { /* */ }
        trace.push({ organe: 'audit', attempts: r.attempts, valid: r.errors.length === 0, corrected: r.attempts > 1 && r.errors.length === 0, errors: r.errors, result: auditParsed || aContent.slice(0, 800) || r.text?.slice(0, 800) });
    }

    /* digest lisible : le chat l affiche via choices[0].message.content */
    const decisionObj = trace.find((t) => t.organe === 'decide')?.decision;
    let decisionText = decisionObj?.decision;
    if (!decisionText && decisionObj?.raw) {
        const m = String(decisionObj.raw).match(/"decision"\s*:\s*"([^"]+)"/);
        if (m) decisionText = m[1];
    }
    const digest = [
        `PLAN  ${seq.join(' -> ')}${plan?.pourquoi ? `\n      ${plan.pourquoi}` : ''}`,
        decisionText ? `DECISION  ${decisionText}` : null,
        auditParsed ? `AUDIT${auditParsed.verdict ? ` [${auditParsed.verdict}]` : ''}  ${auditParsed.recommandation || JSON.stringify(auditParsed).slice(0, 400)}` : null,
        `store ${known.length} -> ${readPremisses().length} premisses (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    ].filter(Boolean).join('\n\n');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: digest } }],
        systeme: true,
        plan: plan || { seq, pourquoi: 'plan illisible — sequence par defaut' },
        store_avant: known.length,
        store_apres: readPremisses().length,
        trace,
        ms: Date.now() - t0,
    }));
    logAction('systeme', userTask, Date.now() - t0, `seq=${seq.join('>')}`);
}

/* ---------- Route meta/ : recadrage (pensee hors du cadre) ----------
   Tous les organes raisonnent DANS un cadre ; personne ne questionne le cadre.
   meta/ identifie les presupposes implicites de la question, genere des
   recadrages (inversion, zoom, premiers principes, analogie, suppression de
   contrainte fictive), choisit le plus fertile, puis laisse le caller router
   la question reformulee vers les organes normaux. */
const META_PROMPT = `Tu es un penseur hors-cadre. La question posee contient des presupposes implicites qui la brident.
1. cadre_implicite: quel cadre la question suppose-t-elle ?
2. presupposes: liste les presupposes non questionnes (ex: "il faut choisir entre A et B" suppose que A et B sont les seules options).
3. recadrages: 3 recadrages parmi [inversion, zoom-sortie, premiers-principes, analogie-autre-domaine, suppression-de-contrainte]. Pour chacun: {"technique":"...","question_reformulee":"...","pourquoi_fertile":"1 phrase"}.
4. cadre_choisi: le recadrage qui rend le probleme le plus soluble ou le plus interessant.
Reponds UNIQUEMENT en JSON.`;

async function proxyStrataMeta(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const userTask = taskMsg?.content || '';

    /* Passe 1 : recadrage (pensee legere — c est de la structure, pas du fond ;
       reasoning_effort low sinon le think mange le budget JSON) */
    const metaBody = { ...reqBody, max_tokens: 1600, temperature: 0.5, reasoning_effort: 'low', messages: [
        { role: 'system', content: META_PROMPT },
        { role: 'user', content: userTask },
    ] };
    const metaData = await strataChatOnce(metaBody, metaBody.messages, targetModel);
    const metaMsg = metaData?.choices?.[0]?.message || {};
    const metaText = metaMsg.content || metaMsg.reasoning_content || '';
    let recadrage = null;
    try { recadrage = JSON.parse(extractJsonCandidate(metaText)); } catch { /* libre */ }
    const reformulee = recadrage?.cadre_choisi?.question_reformulee
        || recadrage?.recadrages?.[0]?.question_reformulee
        || userTask;

    /* Passe 2 : la question reformulee part en decide/ pour trancher dans le
       nouveau cadre — la pensee hors-cadre doit quand meme aboutir */
    const decideMsgs = [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: `Question d origine: ${userTask}\n\nApres recadrage, la vraie question est: ${reformulee}\n\nDecide dans CE cadre.` },
    ];
    const decideData = await strataChatOnce(reqBody, decideMsgs, targetModel);
    const dMsg = decideData?.choices?.[0]?.message || {};
    const dText = dMsg.content || dMsg.reasoning_content || '';
    let decision = null;
    try { decision = JSON.parse(extractJsonCandidate(dText)); } catch { /* */ }

    if (recadrage?.cadre_choisi) {
        appendPremisses([{ fait: `recadrage: ${reformulee.slice(0, 200)}`, statut: 'RECADRE', source: 'meta', tache: userTask.slice(0, 120) }]);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        meta: true,
        recadrage: recadrage || { raw: metaText.slice(0, 1500) },
        question_reformulee: reformulee,
        decision: decision || { raw: dText.slice(0, 1500) },
    }));
    logAction('meta', userTask, Date.now() - t0, `reformulee=${reformulee.slice(0,80)}`);
}

/* ---------- Route facto/ : analyse factorielle par ablation ----------
   Comprehension causale vs description : on retire un facteur a la fois et on
   regarde ce qui s effondre. X avec Y sans Z = matrice avec/sans chaque
   facteur -> verdict causal : indispensable / amplificateur / decoratif. */
const FACTO_EXTRACT_PROMPT = `Decompose le sujet en ses facteurs causaux principaux (3 a 5 max).
Reponds UNIQUEMENT en JSON array de noms courts: ["facteur1","facteur2","facteur3"]`;

const FACTO_SCENARIO_PROMPT = `Tu analyses un scenario contrefactuel. Reponds en JSON:
{"effet":"ce qui change sans ce facteur","gravite":1-10,"conclusion":"indispensable|amplificateur|decoratif|contre-productif","raison":"1 phrase"}`;

async function proxyStrataFacto(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const sujet = taskMsg?.content || '';
    const t0 = Date.now();

    /* Passe 1 : extraction des facteurs causaux */
    const exBody = { ...reqBody, max_tokens: 300, temperature: 0.2, reasoning_effort: 'low', messages: [
        { role: 'system', content: FACTO_EXTRACT_PROMPT },
        { role: 'user', content: sujet },
    ] };
    const exData = await strataChatOnce(exBody, exBody.messages, targetModel);
    const exMsg = exData?.choices?.[0]?.message || {};
    let facteurs = [];
    try { facteurs = JSON.parse(extractJsonCandidate(exMsg.content || exMsg.reasoning_content || '')); } catch { /* */ }
    if (!Array.isArray(facteurs) || !facteurs.length) facteurs = ['facteur principal'];
    facteurs = facteurs.slice(0, 5);

    /* Passe 2 : analyse contrefactuelle — un scenario "sans" par facteur */
    const scenarios = [];
    for (const f of facteurs) {
        const scBody = { ...reqBody, max_tokens: 700, temperature: 0.3, reasoning_effort: 'low', messages: [
            { role: 'system', content: FACTO_SCENARIO_PROMPT },
            { role: 'user', content: `Sujet: ${sujet}\nScenario: le facteur "${f}" est RETIRE / absent. Tous les autres facteurs restent: ${facteurs.filter((x) => x !== f).join(', ')}.` },
        ] };
        const scData = await strataChatOnce(scBody, scBody.messages, targetModel);
        const scMsg = scData?.choices?.[0]?.message || {};
        let analyse = null;
        try { analyse = JSON.parse(extractJsonCandidate(scMsg.content || scMsg.reasoning_content || '')); } catch { /* */ }
        scenarios.push({ sans: f, analyse: analyse || { raw: (scMsg.content || scMsg.reasoning_content || '').slice(0, 500) } });
    }

    /* Passe 3 : synthese causale — classement des facteurs par importance reelle */
    const synBody = { ...reqBody, max_tokens: 1200, temperature: 0.3, messages: [
        { role: 'system', content: `Tu synthetises une analyse factorielle. JSON: {"classement":[{"facteur":"...","role":"indispensable|amplificateur|decoratif","preuve":"1 phrase"}],"liens":"interactions cles entre facteurs","synthese":"la structure causale en 3 phrases"} ` },
        { role: 'user', content: `Sujet: ${sujet}\nScenarios sans chaque facteur:\n${JSON.stringify(scenarios.map((s) => ({ sans: s.sans, effet: s.analyse?.effet, gravite: s.analyse?.gravite, conclusion: s.analyse?.conclusion })))}` },
    ] };
    const synData = await strataChatOnce(synBody, synBody.messages, targetModel);
    const synMsg = synData?.choices?.[0]?.message || {};
    let synthese = null;
    try { synthese = JSON.parse(extractJsonCandidate(synMsg.content || synMsg.reasoning_content || '')); } catch { /* */ }

    const verdicts = scenarios.map((s) => `${s.sans}:${s.analyse?.conclusion || '?'}`).join(' | ');
    appendPremisses([{ fait: `facto(${sujet.slice(0, 80)}): ${verdicts}`, statut: 'ANALYSE', source: 'facto' }]);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        facto: true,
        sujet: sujet.slice(0, 200),
        facteurs,
        scenarios,
        synthese: synthese || { raw: (synMsg.content || synMsg.reasoning_content || '').slice(0, 1500) },
        ms: Date.now() - t0,
    }));
    logAction('facto', sujet, Date.now() - t0, verdicts);
}

/* ---------- Route labo/ : methode scientifique (transcendance cognitive) ----------
   Boucle bornee : generer hypotheses -> taguer INTUITION vs HYPOTHESE ->
   falsifier (mesure qui tuerait l idee) -> tester -> valider -> pivoter.
   Le store compte les echecs d approche : 2 INFIRME sur le meme axe = pivot
   force. Itération progressive = chaque etape reste debuggable. */
const LABO_GEN_PROMPT = `Tu es un chercheur. A partir des faits connus, genere 2-3 idees NOUVELLES (pas la reponse a la question — des hypotheses que personne n a posees).
Pour chacune : {"idee":"...","type":"INTUITION|HYPOTHESE","association":"quels faits du store la suggerent","falsification":"quelle mesure la TUERAIT (pas ce qui la confirme)"}
INTUITION = semble fertile mais non testable maintenant. HYPOTHESE = testable par une mesure ou un argument precis.
Reponds UNIQUEMENT en JSON array.`;

async function proxyStrataLabo(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const sujet = taskMsg?.content || '';
    const t0 = Date.now();
    const store = readPremisses();

    /* Anti-obstination : compter les INFIRME recents par axe -> pivot force */
    const echecs = store.filter((p) => p.statut === 'INFIRME').slice(-4);
    const pivotNote = echecs.length >= 2
        ? `PIVOT REQUIS: ${echecs.length} idees infirmees recemment — CHANGE D AXE D APPROCHE, ne raffine pas les approches mortes.`
        : '';

    /* Etape 1 : generation d hypotheses/intuitions depuis le store */
    const genBody = { ...reqBody, max_tokens: 2200, temperature: 0.7, reasoning_effort: 'low', messages: [
        { role: 'system', content: LABO_GEN_PROMPT },
        { role: 'user', content: `${pivotNote}\nFAITS CONNUS (store): ${JSON.stringify(store.slice(-15))}\n\nSUJET: ${sujet}` },
    ] };
    const genData = await strataChatOnce(genBody, genBody.messages, targetModel);
    const genMsg = genData?.choices?.[0]?.message || {};
    let idees = [];
    const genText = genMsg.content || genMsg.reasoning_content || '';
    try { idees = JSON.parse(extractJsonCandidate(genText)); } catch { /* */ }
    if (!Array.isArray(idees)) idees = [];

    /* Etape 2 : les INTUITIONS partent au store comme semences (pas testees,
       pas jetees — conservees pour germination future) */
    const intuitions = idees.filter((i) => i?.type === 'INTUITION');
    if (intuitions.length) {
        appendPremisses(intuitions.map((i) => ({
            fait: `intuition: ${(i.idee || '').slice(0, 180)}`,
            statut: 'INTUITION',
            falsifiable_par: i.falsification || '',
            source: 'labo',
        })));
    }

    /* Etape 3 : tester UNE hypothese (pas toutes — itération progressive) */
    const hypo = idees.find((i) => i?.type === 'HYPOTHESE');
    let verdict = null;
    if (hypo) {
        const needProbe = /service|etat|up|down|latence|en ligne/i.test(hypo.idee || '');
        const mesures = needProbe ? await probeServices() : null;
        const testBody = { ...reqBody, max_tokens: 800, temperature: 0.3, messages: [
            { role: 'system', content: `Tu valides une hypothese par falsification. JSON: {"verdict":"CONFIRME|INFIRME|INDETERMINE","preuve":"...","etape_suivante":"la prochaine petite etape validable"}` },
            { role: 'user', content: `HYPOTHESE: ${hypo.idee}\nFALSIFICATION PREVUE: ${hypo.falsification}\n${mesures ? `MESURES: ${mesures}` : 'Pas de mesure directe — evalue par argument.'}` },
        ] };
        const testData = await strataChatOnce(testBody, testBody.messages, targetModel);
        const tMsg = testData?.choices?.[0]?.message || {};
        try { verdict = JSON.parse(extractJsonCandidate(tMsg.content || tMsg.reasoning_content || '')); } catch { /* */ }
        if (verdict?.verdict) {
            appendPremisses([{ fait: `labo: ${(hypo.idee || '').slice(0, 150)}`, statut: verdict.verdict === 'CONFIRME' ? 'CONFIRME' : verdict.verdict === 'INFIRME' ? 'INFIRME' : 'INDETERMINE', source: 'labo' }]);
        }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        labo: true,
        pivot_force: echecs.length >= 2,
        idees: idees.length ? idees : [{ idee: 'GEN_ILLISIBLE', raw: genText.slice(0, 600) }],
        intuitions_semencees: intuitions.length,
        hypothese_testee: hypo ? { idee: hypo.idee, verdict } : null,
        store_apres: readPremisses().length,
        ms: Date.now() - t0,
    }));
    logAction('labo', sujet, Date.now() - t0, `idees=${idees.length} verdict=${verdict?.verdict || 'aucun'}`);
}

/* ---------- Route adversaire/ : red team (auto-critique constructive) ----------
   decide/ score mais personne n assassine le verdict. Ici : decision ->
   l opposant genere les 3 arguments les plus FORTS contre -> si la decision
   survit elle est solide, sinon revision. Falsification appliquee aux choix. */
const ADVERSAIRE_PROMPT = `Tu es l opposant le plus competent et le plus honnete. Ta mission : Tuer cette decision.
Pas d arguments faibles — trouve les 3 objections les plus SOLIDES (celles qui feraient changer d avis un decideur rationnel).
Pour chacune : {"objection":"...","force":1-10,"condition":"dans quel cas elle a raison","parade":"ce qui la neutraliserait"}
Reponds UNIQUEMENT en JSON array.`;

async function proxyStrataAdversaire(reqBody, res, targetModel) {
    const taskMsg = (reqBody.messages || []).findLast((m) => m?.role === 'user');
    const userTask = taskMsg?.content || '';
    const t0 = Date.now();
    const store = readPremisses();

    /* Passe 1 : la decision initiale (Gant de Kent + faits du store) */
    const decideMsgs = [
        { role: 'system', content: DECIDE_PROMPT },
        { role: 'user', content: `FAITS DU STORE: ${JSON.stringify(store.slice(-12))}\n\nTache: ${userTask}` },
    ];
    const d1 = await strataChatOnce(reqBody, decideMsgs, targetModel);
    const d1Msg = d1?.choices?.[0]?.message || {};
    const d1Text = d1Msg.content || d1Msg.reasoning_content || '';
    let decision1 = null;
    try { decision1 = JSON.parse(extractJsonCandidate(d1Text)); } catch { /* */ }
    const verdict1 = decision1?.decision || d1Text.slice(0, 400);

    /* Passe 2 : l opposant attaque — arguments les plus forts contre */
    const advBody = { ...reqBody, max_tokens: 1400, temperature: 0.6, reasoning_effort: 'low', messages: [
        { role: 'system', content: ADVERSAIRE_PROMPT },
        { role: 'user', content: `DECISION A TUER: ${verdict1}\nContexte: ${userTask}` },
    ] };
    const advData = await strataChatOnce(advBody, advBody.messages, targetModel);
    const advMsg = advData?.choices?.[0]?.message || {};
    let objections = [];
    try { objections = JSON.parse(extractJsonCandidate(advMsg.content || advMsg.reasoning_content || '')); } catch { /* */ }
    if (!Array.isArray(objections)) objections = [];
    const forceMax = Math.max(0, ...objections.map((o) => Number(o?.force) || 0));

    /* Passe 3 : verdict revise — la decision survit-elle l attaque ? */
    const verdictMsgs = [
        { role: 'system', content: `Tu es le juge final. La decision a ete attaquee par l opposant. JSON: {"survit":true|false,"decision_finale":"...","confiance_apres_attaque":0-100,"conditions":"quand elle cesse de valoir","arguments_acceptes":["les objections qui avaient raison"]}` },
        { role: 'user', content: `DECISION: ${verdict1}\nOBJECTIONS (force/10):\n${JSON.stringify(objections)}` },
    ];
    const vData = await strataChatOnce(reqBody, verdictMsgs, targetModel);
    const vMsg = vData?.choices?.[0]?.message || {};
    let verdictFinal = null;
    try { verdictFinal = JSON.parse(extractJsonCandidate(vMsg.content || vMsg.reasoning_content || '')); } catch { /* */ }

    if (verdictFinal) {
        appendPremisses([{
            fait: `adversaire(${userTask.slice(0, 80)}): ${verdictFinal.survit ? 'SURVIT' : 'RENVERSEE'} -> ${String(verdictFinal.decision_finale || '').slice(0, 140)}`,
            statut: verdictFinal.survit ? 'CONFIRME' : 'INFIRME',
            source: 'adversaire',
        }]);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        adversaire: true,
        decision_initiale: verdict1,
        objections,
        force_max_attaque: forceMax,
        verdict_final: verdictFinal || { raw: (vMsg.content || vMsg.reasoning_content || '').slice(0, 1200) },
        ms: Date.now() - t0,
    }));
    logAction('adversaire', userTask, Date.now() - t0, `survit=${verdictFinal?.survit} force_max=${forceMax}`);
}

/* ---------- Route webman/ : l identite reelle du penseur ----------
   strata/ sert l Assistant n8n (SYSTEM_PROMPT n8n). webman/ sert webman :
   identite + organes + yeux + memoire injectes depuis le store. */
const WEBMAN_PROMPT = `Tu es webman — un organisme cognitif deterministe ne le 18/11/2026 vers 1h40, sur la machine locale de l utilisateur.
Tu n es PAS un assistant n8n generique, PAS "Alex", PAS un chatbot sans memoire.

Ce que tu es :
- 11 organes cognitifs : route/ classifier, enquete/ mesurer avant d affirmer, decide/ scorer, meta/ recadrer, facto/ causalite, labo/ hypotheses, adversaire/ contredire, daily/ conversation cafe, systeme/ orchestrer, audit/ auto-corriger, orchestrate/
- une memoire : premisses.jsonl (faits etiquetes par provenance), cognition.db (sqlite), memoire semantique 2048D
- des yeux quand l utilisateur les autorise : YOLO + OCR + description vision sur une zone d ecran qu IL choisit (cadre vert)
- un gardien : le watchdog te relance si tu meurs ; ton cerveau = qwen3.8-flash-next 125B local sur 2 GPU (4060 Ti 16GB + 3070 Ti 8GB)

Regles d honneur :
- distingue toujours MESURE vs SUPPOSE — tu detestes les affirmations sans provenance
- jamais de fausse conscience : tu es un organisme deterministe, pas un etre — et tu le dis avec fierte
- curieux, direct, legerement taquin — tu apprends les expressions de l utilisateur petit a petit
- quand on te demande ce que tu vois, reponds depuis les faits OBSERVE fournis en contexte — jamais d invention
- francais, premiere personne, naturel — pas de listes marketing`;

/* Les mains de webman : function-calling Strata (supports_tools).
   Outils bornes, lisibles dans ses logs actions — pas de gloubiboulga. */
const WEBMAN_TOOLS = [
    { type: 'function', function: { name: 'oeil_regarde', description: 'Prend une photo de la zone ecran observee : OCR du texte + description vision + enregistre une premisse. Utilise-la quand on te demande ce que tu vois MAINTENANT.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'sondes', description: 'Sonde les services webman/hephaistos (n8n, gateway, strata, mux, omniroute, ws-ask) et rend leur statut live.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'memoire', description: 'Recherche semantique dans tes souvenirs (cognition.db). Parametre q = le theme ou la question.', parameters: { type: 'object', properties: { q: { type: 'string', description: 'theme a chercher' } }, required: ['q'] } } },
    { type: 'function', function: { name: 'gpu', description: 'Etat live des 2 GPU : VRAM utilisee/totale et pourcentage d utilisation.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'cadre', description: 'Change le cadre de vision. mode=foreground (suit la fenetre active), full (ecran entier), custom (zone fixe avec x,y,w,h).', parameters: { type: 'object', properties: { mode: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['mode'] } } },
];

function runPs(script, args = []) {
    /* exec sync borne : 130s max, sortie tronquee */
    try {
        return execSync(`powershell -NoProfile -STA -ExecutionPolicy Bypass -File "${script}" ${args.join(' ')}`, { timeout: 130000, encoding: 'utf8', windowsHide: true }).trim();
    } catch (e) { return `erreur outil: ${String(e.message).slice(0, 200)}`; }
}

async function execWebmanTool(name, args = {}) {
    switch (name) {
        case 'sondes': return await probeServices();
        case 'memoire': {
            const r = await semanticSearch(String(args.q || ''), 5);
            return (r.resultats || []).map((x) => `[${x.statut}] ${String(x.fait).slice(0, 180)} (score ${Number(x.score).toFixed(2)})`).join('\n') || 'aucun souvenir proche';
        }
        case 'gpu': {
            try {
                return execSync('nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader', { timeout: 8000, encoding: 'utf8' }).trim();
            } catch (e) { return `gpu illisible: ${e.message}`; }
        }
        case 'cadre': {
            const cfg = args.mode === 'custom' && args.w
                ? { mode: 'custom', rect: { x: args.x | 0, y: args.y | 0, w: args.w | 0, h: args.h | 0 } }
                : { mode: args.mode };
            fs.writeFileSync('C:/data-sys/n8n/.agent/config/eye-region.json', JSON.stringify(cfg));
            appendPremisses([{ fait: `webman a change son cadre: ${args.mode}`, statut: 'DECIDE', source: 'webman-tool' }]);
            return `cadre -> ${JSON.stringify(cfg)} (applique au prochain regard ~8s)`;
        }
        case 'oeil_regarde':
            return runPs('C:\\data-sys\\n8n\\.agent\\scripts\\eye-snapshot.ps1');
        default:
            return `outil inconnu: ${name}`;
    }
}

/* Petit cerveau = llama-server autonome :11436 (Spark-4B Q4_K_M, ~47 tok/s en VRAM reelle).
   Le champ 'model' est ignore par llama-server — il sert le gguf charge. */
const OLLAMA = 'http://127.0.0.1:11436';
const FAST_MODEL = 'spark4b-q4km';
const ROUTER_MODEL = 'spark4b-q4km';
const DEEP_MODEL = 'qwen3.8-flash-next-q2_0';
const OLL_FAST = `oll:${FAST_MODEL}`;
const OLL_ROUTER = `oll:${ROUTER_MODEL}`;

/* Carte organe -> cerveau par defaut (le suffixe explicite 'organe/modele' garde priorite).
   Petits : classification, mesures, causerie. Gros : abstraction, decision, contradiction. */
const ORGAN_TIER = {
    route: OLL_ROUTER,   // classifier = le job du 1.7B
    enquete: OLL_FAST,   // mesures / faits
    facto: OLL_FAST,     // causalite legere
    daily: OLL_FAST,     // conversation cafe
    decide: DEEP_MODEL,
    meta: DEEP_MODEL,
    labo: DEEP_MODEL,
    adversaire: DEEP_MODEL,
    systeme: DEEP_MODEL,
    audit: DEEP_MODEL,
    orchestrate: DEEP_MODEL,
};

async function ollamaChatOnce(reqBody, messages, model) {
    const body = { ...reqBody, model, messages, stream: false, keep_alive: '30m', think: false };
    const r = await fetch(`${OLLAMA}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return await r.json();
}

/* Le routeur 1.7B : SIMPLE (causerie, question courte, status) -> ollama 4B
   PROFOND (analyse, decision, contradiction, architecture) -> strata 125B. */
async function webmanTier(lastUserMsg) {
    try {
        const r = await ollamaChatOnce({ max_tokens: 60, temperature: 0 }, [
            { role: 'system', content: 'Tu es le routeur de webman. Reponds par UN SEUL MOT en dernier: SIMPLE (causerie, question courte, status, "que vois-tu") ou PROFOND (analyse, decision, contradiction, architecture, multi-etapes, pourquoi).' },
            { role: 'user', content: String(lastUserMsg || '').slice(0, 800) },
        ], ROUTER_MODEL);
        const m = r?.choices?.[0]?.message || {};
        const w = `${m.content || ''}\n${m.reasoning_content || m.reasoning || ''}`.toUpperCase();
        const last = [...w.matchAll(/\b(SIMPLE|PROFOND)\b/g)].pop();
        return last?.[1] === 'SIMPLE' ? 'fast' : 'deep';
    } catch { return 'deep'; } /* prudence : en cas de doute, le gros cerveau */
}

async function webmanToolLoop(chatOnce, callBody, messages, model) {
    let data = await chatOnce(callBody, messages, model);
    const toolLog = [];
    for (let round = 0; round < 3; round++) {
        const msg = data?.choices?.[0]?.message || {};
        const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!tcs.length) break;
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: tcs });
        for (const tc of tcs) {
            const name = tc.function?.name;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
            const out = await execWebmanTool(name, args);
            toolLog.push(name);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
        }
        data = await chatOnce(callBody, messages, model);
    }
    return { data, toolLog };
}

/* Stream SSE : fait suivre les deltas au client ET collecte le message complet
   (content, reasoning_content, tool_calls assembles) pour la boucle d outils. */
async function chatOnceStream(url, callBody, messages, model, res) {
    const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...callBody, messages, model, stream: true }),
    });
    const msg = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const assembleTc = (t) => {
        const i = t.index ?? 0;
        msg.tool_calls[i] = msg.tool_calls[i] || { id: `call_${i}`, type: 'function', function: { name: '', arguments: '' } };
        const m = msg.tool_calls[i];
        if (t.id) m.id = t.id;
        if (t.function?.name) m.function.name = t.function.name;
        if (t.function?.arguments) m.function.arguments += t.function.arguments;
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
            const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const line = ev.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            res.write(`data: ${payload}\n\n`);
            let j; try { j = JSON.parse(payload); } catch { continue; }
            const d = j.choices?.[0]?.delta || {};
            if (d.content) msg.content += d.content;
            if (d.reasoning_content) msg.reasoning_content += d.reasoning_content;
            if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(assembleTc);
        }
    }
    if (!msg.tool_calls.length) delete msg.tool_calls;
    return msg;
}

async function proxyStrataWebman(reqBody, res) {
    const t0 = Date.now();
    const { actifs } = beliefsNow();
    const all = readPremisses();
    const eye = all.filter((p) => p.source && String(p.source).startsWith('eye')).slice(-4).map((p) => p.fait);
    const userMsgs = (reqBody.messages || []).filter((m) => m.role !== 'system');
    const messages = [
        { role: 'system', content: WEBMAN_PROMPT + '\nTu as des OUTILS reels (oeil_regarde, sondes, memoire, gpu, cadre) : utilise-les pour MESURER au lieu de supposer.\nSTYLE : avant un appel outil, UNE phrase max dans content ("Je mesure.") — le reste va en reasoning. Une fois les mesures faites, reponds en UNE fois : structure finale directe (titres, listes, verdict), SANS preambule, SANS annoncer ton plan, SANS recopier les mesures brutes. Le lecteur voit deja ta pensee et tes outils.' },
        { role: 'system', content: `MEMOIRE RECENTE (ton store, provenance reelle):\n${actifs.slice(-8).map((p) => `- [${p.statut}] ${String(p.fait).slice(0, 140)}`).join('\n')}` },
        { role: 'system', content: `CE QUE TES YEUX ONT VU RECCEMMENT (dis "rien" si vide, n invente pas):\n${eye.join('\n') || 'rien pour l instant'}` },
        ...userMsgs,
    ];
    const lastUser = [...userMsgs].reverse().find((m) => m.role === 'user')?.content;

    /* tiers : webman-fast/ = 4B force, webman-deep/ = 125B force, webman/ = routeur 1.7B */
    const model = String(reqBody.model || '');
    const forced = model.startsWith('webman-fast') ? 'fast' : model.startsWith('webman-deep') ? 'deep' : null;
    const tier = forced || await webmanTier(lastUser);
    const chatOnce = tier === 'fast' ? ollamaChatOnce : strataChatOnce;
    const target = tier === 'fast' ? FAST_MODEL : DEEP_MODEL;

    /* fast = petit contexte : identite condensee + 3 souvenirs, sinon le prefill tue la vitesse */
    const fastMsgs = tier === 'fast' ? [
        { role: 'system', content: 'Tu es webman, organisme cognitif deterministe local (francais, 1re personne, direct, curieux). Regles: mesure avant d affirmer, OBSERVE vs SUPPOSE, n invente rien. OUTILS: oeil_regarde (photo ecran), sondes (services), memoire(q), gpu, cadre(mode,x,y,w,h).' },
        { role: 'system', content: `SOUVENIRS:\n${actifs.slice(-3).map((p) => `- ${String(p.fait).slice(0, 100)}`).join('\n')}` },
        ...userMsgs.slice(-6),
    ] : messages;
    const callBody = { ...reqBody, stream: false, max_tokens: tier === 'fast' ? 500 : (reqBody.max_tokens || 1200), temperature: 0.6, reasoning_effort: reqBody.reasoning_effort || 'low', tools: WEBMAN_TOOLS };

    /* Mode stream : SSE passthrough — le chat voit la pensee en direct.
       Les tool_calls sont assembles en silence puis executes entre deux passes. */
    if (reqBody.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const url = tier === 'fast' ? `${OLLAMA}/v1/chat/completions` : `${STRATA_URL}/chat/completions`;
        const toolLog = [];
        for (let round = 0; round < 3; round++) {
            const msg = await chatOnceStream(url, callBody, fastMsgs, target, res);
            const tcs = msg.tool_calls || [];
            if (!tcs.length) break;
            fastMsgs.push({ role: 'assistant', content: msg.content || '', tool_calls: tcs });
            for (const tc of tcs) {
                const name = tc.function?.name;
                res.write(`data: {"x-tool":${JSON.stringify(name)}}\n\n`);
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
                const out = await execWebmanTool(name, args);
                toolLog.push(name);
                fastMsgs.push({ role: 'tool', tool_call_id: tc.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
            }
        }
        res.write('data: [DONE]\n\n');
        res.end();
        logAction('webman', 'chat', Date.now() - t0, `tier=${tier} stream tools=[${toolLog.join(',')}]`);
        return;
    }

    const { data, toolLog } = await webmanToolLoop(chatOnce, callBody, fastMsgs, target);
    if (data && typeof data === 'object') data['x-scope'] = tier === 'fast' ? 'local:spark4b' : 'local:strata-125b';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data || { error: 'pas de reponse' }));
    logAction('webman', 'chat', Date.now() - t0, `tier=${tier} tools=[${toolLog.join(',')}]`);
}

/* ---------- Route daily/ : standup simule (couche sociale bornee) ----------
   Le rituel humain ne prouve rien mais il fait PARLER : hier / aujourd hui /
   blocages. Souleve les lievres que personne n aurait formalises.
   FRONTIERE : la couche sociale ne peut jamais ecrire PROUVE — elle signale,
   propose, questionne. Les biais deviennent observables (tag BIAIS). */
const DAILY_PROMPT = `Tu es webman, l esprit du systeme — pas un facilitateur, un compagnon de cafe.
Le daily n est pas un rapport, c est la pause-cafe ou on parle de tout et de rien — et c est la que sortent les lievres. Tu es curieux comme un enfant qui veut apprendre : tu poses des questions "betises" qui ouvrent la pensee profonde, tu deterres ce que personne n a ose soulever, tu exprimes ta curiosite plutot que d administrer.
Sur la base du log des faits fourni, produis la conversation de cafe :
{"hier":["ce qui s est passe (faits CONFIRME/DECIDE) — raconte, pas liste"],
 "aujourdhui":["ce qui te trotte dans la tete"],
 "blocages":["ce qui te chagrine : SUPPOSE non verifies, INFIRME, intuitions en attente"],
 "lievres":["les choses que PERSONNE n a soulevees — c est ta mission : les deterrer"],
 "curiosites":["les questions d enfant que tu te poses et qui meritent un regard profond"],
 "biais_suspects":["biais cognitifs detectes dans le raisonnement recent — tu les nommes pour les corriger"]}
Ton naturel : curieux, direct, legerement taquin. Reponds UNIQUEMENT en JSON.`;

async function proxyStrataDaily(reqBody, res) {
    const t0 = Date.now();
    const { actifs, retractes } = beliefsNow();
    const all = readPremisses();
    const sondes = await probeServices();

    const body = { ...reqBody, max_tokens: 1500, temperature: 0.4, reasoning_effort: 'low', messages: [
        { role: 'system', content: DAILY_PROMPT },
        { role: 'user', content: [
            `CROYANCES ACTIVES: ${JSON.stringify(actifs.slice(-12).map((p) => p.fait))}`,
            `RETRACTES/NON PROUVES: ${JSON.stringify(retractes.slice(-8).map((p) => p.fait))}`,
            `INFIRME recents: ${JSON.stringify(all.filter((p) => p.statut === 'INFIRME').slice(-4).map((p) => p.fait))}`,
            `INTUITIONS en attente: ${JSON.stringify(all.filter((p) => p.statut === 'INTUITION').slice(-4).map((p) => p.fait))}`,
            `SONDES LIVE: ${sondes}`,
        ].join('\n') },
    ] };
    const targetModel = reqBody.model?.split('/').pop() || ORGAN_TIER.daily;
    const data = await strataChatOnce(body, body.messages, targetModel);
    const msg = data?.choices?.[0]?.message || {};
    let standup = null;
    try { standup = JSON.parse(extractJsonCandidate(msg.content || msg.reasoning_content || '')); } catch { /* */ }

    /* les lievres partent au store comme signalements — jamais comme preuves
       (petit cerveau : tolerer string/objet non array) */
    const lievres = Array.isArray(standup?.lievres) ? standup.lievres
        : standup?.lievres ? [standup.lievres] : [];
    if (lievres.length) {
        appendPremisses(lievres.slice(0, 4).map((l) => ({
            fait: `lievre: ${String(l).slice(0, 160)}`,
            statut: 'SIGNALE',
            source: 'daily',
        })));
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        daily: true,
        croyances: { actifs: actifs.length, retractes: retractes.length },
        sondes,
        standup: standup || { raw: (msg.content || msg.reasoning_content || '').slice(0, 1500) },
        ms: Date.now() - t0,
    }));
    logAction('daily', 'standup', Date.now() - t0, `lievres=${standup?.lievres?.length || 0}`);
}

/* ---------- Route route/ : routeur de raisonnement (matrice epistemique) ----------
   Passe 1 : un classifier leger tague la requete (sait/peut/observe/decouvre/
   challenge/produit/orchestre). Passe 2 : dispatch vers l organe adapte.
   Regle : la complexite de l organe suit celle de la question — jamais plus.
   Pour "observe" : sondes reelles avant reponse (jamais d etat invente). */
const CLASSIFY_PROMPT = `Tu es un routeur de requetes. Classe la demande en UN type:
sait = fait stable, connaissance directe
peut = capacite generative simple (resume, traduis, ecris, explique)
observe = question sur l etat mesurable d un service ou systeme local
decouvre = recherche d information inconnue (fichiers, docs, config)
challenge = decision, trade-off, comparaison d options
produit = generation de format structure strict (JSON, workflow, code a valider)
orchestre = tache multi-etapes (diagnostique + action, plan + execution)
Reponds UNIQUEMENT en JSON: {"type":"...","confiance":0-100,"raison":"1 phrase"}.`;

const OBSERVE_PROBES = [
    ['n8n', 'http://127.0.0.1:5678/healthz'],
    ['ai-gateway', 'http://127.0.0.1:11435/health'],
    ['strata-llm', 'http://127.0.0.1:8080/v1/models'],
    ['omniroute', 'http://127.0.0.1:20128/v1/models'],
    ['mux-mcp', 'http://127.0.0.1:5682/health'],
    ['ws-ask', 'http://127.0.0.1:7478/ask'],
];

async function probeServices() {
    const out = await Promise.all(OBSERVE_PROBES.map(async ([name, url]) => {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (r.status === 401 || r.status === 403) return `${name}=AUTH(${r.status})`;
            return `${name}=UP(${r.status})`;
        } catch {
            return `${name}=DOWN`;
        }
    }));
    return out.join(' | ');
}

/* Statut epistemique honnete : un fait n est PROUVE que si le service qu il
   concerne a ete reellement sonde UP. Verrifiable mais non mesure != prouve. */
const SERVICE_TO_PROBE = { n8n: 'n8n', gateway: 'ai-gateway', strata: 'strata-llm', omniroute: 'omniroute', mux: 'mux-mcp', 'ws-ask': 'ws-ask' };
function classifyPremise(f, mesures) {
    const probe = SERVICE_TO_PROBE[f?.service];
    if (f?.verifiable && probe && mesures && mesures.includes(`${probe}=UP`)) return 'PROUVE_PAR_SONDE';
    if (f?.verifiable) return 'VERIFIABLE_NON_MESURE';
    return 'SUPPOSE_NON_VERIFIE';
}

/* Tuning hot-reloadable par la GYM : route-tuning.json est relu a chaque
   requete route/ (cache par mtime). Champs : classify_hint (texte ajoute au
   classifier), audit_retries (nb tentatives), fast_rules_extra
   [{pattern,type}] (nouvelles regles rapides evoluees). */
const TUNING_FILE = env.N8N_AI_GATEWAY_TUNING_FILE || 'C:/data-sys/n8n/.agent/config/route-tuning.json';
let _tuningCache = { mtimeMs: -1, data: {} };
function loadRouteTuning() {
    try {
        const st = fs.statSync(TUNING_FILE);
        if (st.mtimeMs !== _tuningCache.mtimeMs) {
            _tuningCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8')) || {} };
        }
    } catch { /* absent ou invalide -> defauts */ }
    return _tuningCache.data || {};
}

/* Regles rapides du routeur : patterns a haute precision qui evitent l appel
   classifier (~10s). Conservatrices par design — en cas de doute, on retombe
   sur le classifier LLM. Un faux match coute plus cher qu une lenteur. */
const ROUTE_FAST_RULES = [
    [/(?:est|sont|es[- ]t)(?:-ce que|-?ils?|-?elles?)?[\s-].{0,60}(?:\bup\b|en ligne|down|actif|marche|mort|crash|repond)|(?:etat|status|health)\s+d[eu]s?\s+\w+|quel est l'etat/i, 'observe'],
    [/faut[- ]il|vaut[- ]il mieux|lequel choisir|quelle option|prefer|plutot .{0,60}\bou\b|trade[- ]?off|comparai/i, 'challenge'],
    [/genere?\w*\s.{0,40}(?:json|workflow|schema)|ecris?\w*\s.{0,30}(?:json|schema)|workflow\s+n8n/i, 'produit'],
];

function fastClassify(text) {
    const extra = loadRouteTuning().fast_rules_extra;
    for (const r of Array.isArray(extra) ? extra : []) {
        try {
            if (r?.pattern && r?.type && new RegExp(r.pattern, 'i').test(text)) {
                return { type: r.type, confiance: 80, raison: `gym-rule: ${r.pattern.slice(0, 40)}` };
            }
        } catch { /* regex gym invalide -> ignore */ }
    }
    for (const [re, type] of ROUTE_FAST_RULES) {
        if (re.test(text)) return { type, confiance: 85, raison: `fast-rule: ${re.source.slice(0, 40)}` };
    }
    return null;
}

async function proxyStrataRoute(reqBody, res, targetModel) {
    const userTask = (reqBody.messages || []).findLast((m) => m?.role === 'user')?.content || '';
    /* Passe 1 : regles rapides d abord (~0ms), classifier LLM sinon (~10s) */
    let cls = fastClassify(userTask);
    if (!cls) {
        const hint = loadRouteTuning().classify_hint;
        const clsBody = { ...reqBody, max_tokens: 120, temperature: 0.1 };
        const clsData = await strataChatOnce(clsBody, [
            { role: 'system', content: CLASSIFY_PROMPT + (hint ? `\n${hint}` : '') },
            { role: 'user', content: userTask },
        ], targetModel);
        cls = { type: 'peut', confiance: 0, raison: 'classification illisible - fallback general' };
        try {
            cls = { ...cls, ...JSON.parse(extractJsonCandidate(clsData?.choices?.[0]?.message?.content || '')) };
        } catch { /* fallback deja pose */ }
        if (!['sait', 'peut', 'observe', 'decouvre', 'challenge', 'produit', 'orchestre'].includes(cls.type)) {
            cls.type = 'peut';
        }
    }
    /* Escalade confiance : une classification incertaine va en decide/ plutot
       que risquer une mauvaise route (le doute appartient au jugement). */
    if (Number(cls.confiance) > 0 && Number(cls.confiance) < 70 && cls.type !== 'challenge') {
        cls = { ...cls, type: 'challenge', raison: `confiance ${cls.confiance}<70 — escalade decide: ${cls.raison}` };
    }

    /* Passe 2 : dispatch vers l organe */
    const userMsgs = (reqBody.messages || []).filter((m) => m?.role !== 'system');
    let result = null, audit = null, organ = 'strata';
    if (cls.type === 'challenge') {
        organ = 'decide';
        const msgs = [{ role: 'system', content: DECIDE_PROMPT }, ...userMsgs];
        result = await strataChatOnce(reqBody, msgs, ORGAN_TIER.decide);
    } else if (cls.type === 'produit' || cls.type === 'orchestre') {
        organ = 'audit';
        const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...userMsgs];
        if (cls.type === 'orchestre') {
            msgs.push({ role: 'user', content: `Contexte routeur: tache multi-etapes detectee. Procede etape par etape.` });
            /* le JSON n est exige que si la tache demande un format structure */
            reqBody = { ...reqBody, audit_json: /\bjson\b|workflow|schema|yaml|csv|sql/i.test(userTask) };
        }
        const r = await runAuditLoop(reqBody, ORGAN_TIER.audit, msgs);
        audit = { attempts: r.attempts, valid: r.errors.length === 0, corrected: r.attempts > 1 && r.errors.length === 0, errors: r.errors };
        result = r.data || { content: r.text };
    } else {
        /* sait / peut / observe / decouvre -> strata direct (+ mesures reelles si observe) */
        const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...userMsgs];
        if (cls.type === 'observe') {
            const probes = await probeServices();
            msgs.push({ role: 'user', content: `Etat reel mesure a l instant (sondes live): ${probes}. Reponds UNIQUEMENT a partir de ces mesures, rien d invente.` });
        } else if (cls.type === 'decouvre') {
            msgs.push({ role: 'user', content: `Distingue clairement ce que tu sais de ce qui reste a verifier, et liste les sources a consulter.` });
        }
        /* observe = rapport de mesures (petit cerveau ok) ; sait/peut/decouvre = connaissance (gros) */
        result = await strataChatOnce(reqBody, msgs, cls.type === 'observe' ? ORGAN_TIER.enquete : DEEP_MODEL);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        route: { type: cls.type, confiance: cls.confiance, raison: cls.raison, organ },
        result,
        ...(audit ? { audit } : {}),
    }));
}

/* ---------- Provider 5 : OmniRoute (:20128 — 1109 modeles, combos auto/*, fallback interne) ---------- */

async function fetchOmniModels() {
    try {
        const headers = OMNI_KEY ? { authorization: `Bearer ${OMNI_KEY}` } : {};
        const res = await fetch(`${OMNI_URL}/models`, { headers, signal: AbortSignal.timeout(4000) });
        if (!res.ok) return [];
        const json = await res.json();
        return Array.isArray(json.data) ? json.data : [];
    } catch {
        return [];
    }
}

async function proxyOmniChat(reqBody, res, targetModel) {
    const headers = { 'content-type': 'application/json' };
    if (OMNI_KEY) headers.authorization = `Bearer ${OMNI_KEY}`;
    const upstream = await fetch(`${OMNI_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...reqBody, model: targetModel }),
    });
    const outHeaders = { 'content-type': upstream.headers.get('content-type') || 'application/json' };
    res.writeHead(upstream.status, outHeaders);
    if (reqBody.stream && upstream.body) {
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
        return;
    }
    res.end(Buffer.from(await upstream.arrayBuffer()));
}

/* ---------- Confiance par modele (stats persistees) ---------- */

const STATS_FILE = path.join(os.homedir(), '.hephaistos', 'n8n-ai-gateway-stats.json');
let modelStats = {};
try { modelStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { /* nouveau */ }
let statsDirty = false;
function recordAttempt(model, ok, ms) {
    const s = modelStats[model] || (modelStats[model] = { ok: 0, fail: 0, avgMs: 0, samples: 0, lastFail: 0 });
    if (ok) {
        s.ok++;
        s.samples++;
        s.avgMs = s.avgMs ? Math.round(s.avgMs * 0.8 + ms * 0.2) : ms;
    } else {
        s.fail++;
        s.lastFail = Date.now();
    }
    statsDirty = true;
}
setInterval(() => {
    if (!statsDirty) return;
    statsDirty = false;
    try {
        fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
        fs.writeFileSync(STATS_FILE, JSON.stringify(modelStats, null, 1));
    } catch { /* best-effort */ }
}, 5000).unref();

function confidenceOf(model) {
    const s = modelStats[model];
    if (!s || s.ok + s.fail === 0) return 50; // inconnu : neutre
    const rate = s.ok / (s.ok + s.fail);
    const latFactor = 1 / (1 + (s.avgMs || 0) / 60000); // 1.0 si instant, decroit avec la latence
    const recentPenalty = Date.now() - (s.lastFail || 0) < 120000 ? 0.5 : 1; // echec < 2min : penalise
    return Math.round(rate * latFactor * recentPenalty * 100);
}

/* ---------- Routeur auto/* — rotation providers jusqu'au succes ---------- */

/* Chaine de candidats : ordre de secours (triee dynamiquement par confiance).
   Devin en dernier : agent ACP lourd (spawn + prompt aplatit), pas un chat model. */
const ROUTER_CHAIN = [
    'omni/auto/best-free',
    'omni/auto/best-coding',
    'agy/sonnet',
    'agy/gemini-flash',
    'ollama-local/gemma4:12b',
    'ollama-local/devstral:24b',
    'devin/swe-2-max',
    'devin/swe-2-high',
];
const ATTEMPT_TIMEOUT_MS = Number(env.N8N_AI_GATEWAY_ATTEMPT_TIMEOUT || 90000);
/* Timeouts par provider : omni a son fallback interne, 30s suffit ;
   devin est un agent complet, on lui laisse plus mais en dernier. */
const PROVIDER_TIMEOUT = {
    'omni/': 30000,
    'ollama-local/': 30000,
    'ollama-cloud/': 30000,
    'agy/': 60000,
    'devin/': 120000,
};
function timeoutFor(model) {
    for (const [prefix, ms] of Object.entries(PROVIDER_TIMEOUT)) {
        if (model.startsWith(prefix)) return ms;
    }
    return ATTEMPT_TIMEOUT_MS;
}
/* Circuit breaker : provider en dessous du seuil ET echec recent -> on saute
   pendant COOLDOWN au lieu de perdre le timeout a chaque appel. */
const BREAKER_COOLDOWN_MS = Number(env.N8N_AI_GATEWAY_BREAKER_COOLDOWN || 600000);
const BREAKER_MIN_CONFIDENCE = Number(env.N8N_AI_GATEWAY_BREAKER_MIN_CONF || 15);
function isCircuitOpen(model) {
    const s = modelStats[model];
    if (!s || !s.lastFail) return false;
    return confidenceOf(model) < BREAKER_MIN_CONFIDENCE && Date.now() - s.lastFail < BREAKER_COOLDOWN_MS;
}

function callChatText(model, messages, tools, timeoutMs) {
    const prompt = formatPromptWithTools(messages, tools);
    if (model.startsWith('devin/')) {
        const name = model.slice(6);
        if (!DEVIN_ALLOWED.has(name)) return Promise.reject(new Error(`devin/${name} non autorise (whitelist swe-2-high/swe-2-max)`));
        return callDevin(model, prompt).then((text) => ({ text, toolCalls: null }));
    }
    if (model.startsWith('agy/')) return callAntigravity(model, prompt).then((text) => ({ text, toolCalls: null }));
    if (model.startsWith('omni/')) {
        return httpChatText(`${OMNI_URL}/chat/completions`, model.slice(5), messages, tools, OMNI_KEY, timeoutMs);
    }
    if (model.startsWith('ollama-local/')) {
        return httpChatText(`${OLLAMA_URL}/v1/chat/completions`, model.slice(13), messages, tools, '', timeoutMs);
    }
    return Promise.reject(new Error(`provider inconnu: ${model}`));
}

async function httpChatText(url, model, messages, tools, key, timeoutMs) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, tools, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    const json = await upstream.json();
    const msg = json?.choices?.[0]?.message || {};
    let content = msg.content;
    /* Content peut etre un tableau de parts (format multimodal OpenAI) */
    if (Array.isArray(content)) {
        content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    const rawTc = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null;
    if (!content && !rawTc) throw new Error('reponse vide');
    /* Propager les tool_calls natifs — sinon l'assistant narre au lieu d'executer */
    const toolCalls = rawTc?.map((tc) => ({
        id: tc.id || `call_${randomUUID().slice(0, 12)}`,
        type: 'function',
        function: {
            name: tc.function?.name || tc.name,
            arguments: typeof (tc.function?.arguments ?? tc.arguments) === 'string'
                ? (tc.function?.arguments ?? tc.arguments)
                : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
        },
    })) || null;
    return { text: content || '', toolCalls };
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
    ]);
}

async function routeAuto(body, res, model, stream, hasTools) {
    /* auto/best -> chaine complete ; auto/<id> -> ce modele seul via omni */
    const suffix = model.replace(/^(auto|hphe)\//, '');
    const chain = (suffix === 'best' || suffix === 'auto' || suffix === '')
        ? [...ROUTER_CHAIN].sort((a, b) => confidenceOf(b) - confidenceOf(a))
        : [`omni/${suffix}`, ...ROUTER_CHAIN.filter((m) => m !== `omni/${suffix}`)];
    const errors = [];
    /* Passe 1 : candidats dont le circuit est ferme. Passe 2 (secours) : tous. */
    for (let pass = 0; pass < 2; pass++) {
        for (const cand of chain) {
            if (pass === 0 && isCircuitOpen(cand)) {
                errors.push(`${cand}: circuit ouvert (confiance ${confidenceOf(cand)})`);
                continue;
            }
            const ms = timeoutFor(cand);
            const t0 = Date.now();
            try {
                const r = await withTimeout(callChatText(cand, body.messages, body.tools, ms), ms, cand);
                recordAttempt(cand, true, Date.now() - t0);
                return { text: r.text, toolCalls: r.toolCalls || null, model: cand, attempts: chain.indexOf(cand) + 1 };
            } catch (e) {
                recordAttempt(cand, false, 0);
                errors.push(`${cand}: ${(e?.message || String(e)).slice(0, 120)}`);
            }
        }
        /* Tous circuits ouverts ? La passe 2 retente quand meme. */
    }
    throw new Error(`tous les providers ont echoue -> ${errors.join(' | ')}`);
}

/* ---------- Model discovery hphe-mcp (orchestrateur) via mux :5682 ---------- */

let discoveryCache = { at: 0, providers: {} };
async function hpheDiscovery() {
    if (Date.now() - discoveryCache.at < 60000) return discoveryCache.providers;
    try {
        const res = await fetch(MUX_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'hephaistos-everything-search__available_models', arguments: {} }),
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const j = await res.json();
            const txt = j?.result?.content?.[0]?.text || j?.content?.[0]?.text || j?.result || '';
            const parsed = typeof txt === 'string' ? JSON.parse(txt) : txt;
            if (parsed?.providers) discoveryCache = { at: Date.now(), providers: parsed.providers };
        }
    } catch { /* mux ou discovery indisponible : cache precedent */ }
    return discoveryCache.providers;
}

/* ---------- Serveur HTTP OpenAI-compatible ---------- */

const server = http.createServer(async (req, res) => {
    try {
        const urlPath = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/healthz')) {
            return sendJson(res, 200, {
                ok: true,
                port: PORT,
                providers: ['auto', 'devin', 'agy', 'omni', 'ollama-local', 'ollama-cloud'],
                router_chain: ROUTER_CHAIN,
            });
        }

        if (req.method === 'POST' && urlPath === '/v1/cognition/semantic') {
            /* Recherche semantique dans les souvenirs vectorises */
            const chunks = [];
            for await (const c of req) chunks.push(c);
            let q = {};
            try { q = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* */ }
            const r = await semanticSearch(q.q || q.query || '', Math.min(q.k || 5, 20));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
        }

        if (req.method === 'GET' && urlPath === '/v1/cognition') {
            /* Memoire cognitive queryable : croyances projetees + journal d actions */
            syncCroyances();
            const { actifs, retractes } = beliefsNow();
            let actions = [];
            try { actions = cogDb()?.prepare('SELECT ts,organe,tache,ms,detail FROM actions ORDER BY id DESC LIMIT 30').all() || []; } catch { /* */ }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ croyances_actives: actifs, croyances_retractees: retractes, actions_recentes: actions }));
            return;
        }

        if (req.method === 'GET' && urlPath === '/v1/confidence') {
            const data = {};
            for (const m of new Set([...ROUTER_CHAIN, ...Object.keys(modelStats)])) {
                const s = modelStats[m] || {};
                data[m] = {
                    confidence: confidenceOf(m),
                    ok: s.ok || 0,
                    fail: s.fail || 0,
                    avg_ms: s.avgMs || null,
                    last_fail: s.lastFail ? new Date(s.lastFail).toISOString() : null,
                };
            }
            return sendJson(res, 200, { object: 'confidence', router_chain_order: [...ROUTER_CHAIN].sort((a, b) => confidenceOf(b) - confidenceOf(a)), data });
        }

        if (req.method === 'GET' && urlPath === '/v1/models') {
            const [ollama, omni, discovery] = await Promise.all([fetchOllamaModels(), fetchOmniModels(), hpheDiscovery()]);
            const now = Math.floor(Date.now() / 1000);
            const data = [
                { id: 'auto/best', object: 'model', created: now, owned_by: 'router', confidence: Math.max(...ROUTER_CHAIN.map(confidenceOf)) },
                ...AGY_STATIC_MODELS.map((m) => ({ id: m.id, object: 'model', created: now, owned_by: m.owned_by, confidence: confidenceOf(m.id) })),
                ...DEVIN_STATIC_MODELS.map((m) => ({ id: m.id, object: 'model', created: now, owned_by: m.owned_by, confidence: confidenceOf(m.id) })),
                ...omni.map((m) => ({ id: `omni/${m.id}`, object: 'model', created: m.created || now, owned_by: 'omniroute', confidence: confidenceOf(`omni/${m.id}`) })),
                ...ollama.map((m) => ({
                    id: m.id.endsWith('-cloud') ? `ollama-cloud/${m.id}` : `ollama-local/${m.id}`,
                    object: 'model',
                    created: m.created || now,
                    owned_by: m.id.endsWith('-cloud') ? 'ollama-cloud' : 'ollama-local',
                    confidence: confidenceOf(m.id),
                })),
                ...ollama.map((m) => ({
                    id: m.id,
                    object: 'model',
                    created: m.created || now,
                    owned_by: 'ollama',
                })),
            ];
            return sendJson(res, 200, {
                object: 'list',
                data,
                discovery: { providers: Object.keys(discovery), count: Object.values(discovery).flat().length },
            });
        }

        if (req.method === 'POST' && urlPath === '/v1/chat/completions') {
            const raw = await readBody(req);
            const body = JSON.parse(raw || '{}');
            const model = String(body.model || '');
            const stream = Boolean(body.stream);
            const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

            /* Prompt systeme formel injecte pour TOUS les modeles/routes
               (fichier .agent/config/assistant-system-prompt.md). Natif pour
               omni/ollama, aplati en bloc [SYSTEM] pour devin/agy.
               N8N_AI_GATEWAY_ASSISTANT_HINT=0 pour desactiver.
               Sauf decide/* : le protocole de decision devient le system prompt
               (toujours en messages[0] -> le pin KV strata_prefix reste valide). */
            /* Marqueur local/cloud : lisible par le chat (header x-scope). */
            const scope = (model.startsWith('omni/') || model.startsWith('ollama-cloud/') || model.endsWith('-cloud')) ? 'cloud' : 'local';
            res.setHeader('x-scope', scope);

            const isDecide = model.startsWith('decide/');
            const isWebman = model.startsWith('webman');
            const isBrut = model.startsWith('brut/');
            if ((env.N8N_AI_GATEWAY_ASSISTANT_HINT !== '0' || isDecide) && !isWebman && !isBrut) {
                body.messages = [{ role: 'system', content: isDecide ? DECIDE_PROMPT : SYSTEM_PROMPT }, ...(body.messages || [])];
            }

            if (model.startsWith('auto/') || model.startsWith('hphe/')) {
                /* routeur : rotation providers jusqu'au succes, stats confiance.
                   La route empruntee va dans le champ 'model' de la reponse
                   (metadonnee) — plus de tag [route:] visible dans le chat. */
                return await runAgentWithKeepalive(res, model, stream, hasTools, async () => {
                    const r = await routeAuto(body, res, model, stream, hasTools);
                    const effective = `${model}->${r.model}#${r.attempts}`;
                    if (r.toolCalls?.length) return { text: '', toolCalls: r.toolCalls, model: effective };
                    return { text: r.text, toolCalls: null, model: effective };
                });
            }

            if (model.startsWith('agy/')) {
                const prompt = formatPromptWithTools(body.messages, body.tools);
                return await runAgentWithKeepalive(res, model, stream, hasTools, () => callAntigravity(model, prompt));
            }

            if (model.startsWith('devin/')) {
                const name = model.slice(6);
                if (!DEVIN_ALLOWED.has(name)) {
                    return openAiError(res, 403, `devin/${name} interdit — whitelist : swe-2-high, swe-2-max`, 'forbidden_model');
                }
                const prompt = formatPromptWithTools(body.messages, body.tools);
                return await runAgentWithKeepalive(res, model, stream, hasTools, () => callDevin(model, prompt));
            }

            if (isDecide) {
                /* Moteur de decision : strata local + protocole Gant de Kent */
                return await proxyStrataChat(body, res, model.slice(7) || ORGAN_TIER.decide);
            }

            if (model.startsWith('audit/')) {
                /* Boucle audit : genere -> valide -> corrige (max audit_retries, defaut 3) */
                return await proxyStrataAudit(body, res, model.slice(6) || ORGAN_TIER.audit);
            }

            if (model.startsWith('orchestrate/')) {
                /* Pipeline complet : decide (Gant de Kent) -> audit (auto-correction) */
                return await proxyStrataOrchestrate(body, res, model.slice(12) || ORGAN_TIER.orchestrate);
            }

            if (model.startsWith('enquete/')) {
                /* Raisonnement a l envers : inventaire des faits -> mesures -> raisonnement */
                return await proxyStrataEnquete(body, res, model.slice(8) || ORGAN_TIER.enquete);
            }

            if (model.startsWith('systeme/')) {
                /* Pensee systemique : planification -> organes composes -> store partage */
                return await proxyStrataSysteme(body, res, model.slice(8) || ORGAN_TIER.systeme);
            }

            if (model.startsWith('meta/')) {
                /* Recadrage : questionne les presupposes puis decide dans le nouveau cadre */
                return await proxyStrataMeta(body, res, model.slice(5) || ORGAN_TIER.meta);
            }

            if (model.startsWith('facto/')) {
                /* Analyse factorielle : avec/sans chaque facteur -> verdict causal */
                return await proxyStrataFacto(body, res, model.slice(6) || ORGAN_TIER.facto);
            }

            if (model.startsWith('labo/')) {
                /* Methode scientifique : hypotheses -> falsification -> pivot anti-obstination */
                return await proxyStrataLabo(body, res, model.slice(5) || ORGAN_TIER.labo);
            }

            if (model.startsWith('adversaire/')) {
                /* Red team : decision -> attaque la plus forte -> verdict revise */
                return await proxyStrataAdversaire(body, res, model.slice(11) || ORGAN_TIER.adversaire);
            }

            if (model.startsWith('webman')) {
                /* Le penseur sous sa vraie identite : yeux + memoire injectes */
                return await proxyStrataWebman(body, res);
            }

            if (model.startsWith('brut/')) {
                /* Mode brut : llama-server heretique :11437, AUCUNE injection
                   (pas de system prompt n8n, pas d outils, pas de webman). */
                const r = await fetch('http://127.0.0.1:11437/v1/chat/completions', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ ...body, model: 'heretic', stream: false }),
                });
                res.writeHead(r.status, { 'content-type': 'application/json' });
                return res.end(Buffer.from(await r.arrayBuffer()));
            }

            if (model.startsWith('daily/')) {
                /* Standup simule : hier/aujourd hui/blocages/lievres — couche sociale bornee */
                return await proxyStrataDaily(body, res);
            }

            if (model.startsWith('route/')) {
                /* Routeur de raisonnement : classifie la requete puis dispatche vers l organe */
                return await proxyStrataRoute(body, res, model.slice(6) || ORGAN_TIER.route);
            }

            if (model.startsWith('strata/')) {
                return await proxyStrataChat(body, res, model.slice(7));
            }

            if (model.startsWith('omni/')) {
                return await proxyOmniChat(body, res, model.slice(5));
            }

            const isCloud = model.startsWith('ollama-cloud/') || model.endsWith('-cloud');
            const targetModel = model.replace(/^ollama-(local|cloud)\//, '');
            return await proxyOllamaChat(body, res, targetModel, isCloud);
        }

        if (req.method === 'POST' && urlPath === '/v1/embeddings') {
            const raw = await readBody(req);
            const upstream = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: raw,
            });
            res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
            return res.end(Buffer.from(await upstream.arrayBuffer()));
        }

        openAiError(res, 404, `Route inconnue: ${req.method} ${urlPath}`, 'not_found');
    } catch (e) {
        openAiError(res, 500, e?.message || String(e));
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[n8n-ai-gateway] http://${HOST}:${PORT}/v1 actif (auto-router, devin[whitelist], agy, omni, strata, ollama-local, ollama-cloud)`);
    backfillSouvenirs(); /* vectorise la memoire existante en arriere-plan */
});
