#!/usr/bin/env node
/**
 * acp-server.mjs — serveur ACP stdio pour les fenêtres hephaistos-chats.
 *
 * Rend les sessions `chat-*` (stockées dans <workspace>/.agent/chats/sessions.json)
 * joignables par le même canal que les agents ACP natifs de l'IDE :
 *   initialize -> session/load -> session/prompt -> session/update(agent_message_chunk) -> stopReason
 *
 * Aucune dépendance à `vscode` : la complétion reproduit runtime.ts (nim/nim2/ollama/openrouter).
 * L'extension VS Code surveille sessions.json et rafraîchit les fenêtres ouvertes.
 */
'use strict';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/* ---------- transport JSON-RPC stdio (ligne par ligne) ---------- */
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const respond = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
const chunk = (sessionId, text) => notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
const thoughtChunk = (sessionId, text) => notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
});

/* ---------- store partagé avec l'extension ---------- */
let workspace = process.env.HEPHAISTOS_WORKSPACE || process.cwd();
function sessionsFile(cwd) {
    return path.join(cwd || workspace, '.agent', 'chats', 'sessions.json');
}
function readSessions(cwd) {
    try {
        const raw = JSON.parse(fs.readFileSync(sessionsFile(cwd), 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}
function writeSessions(cwd, sessions) {
    const file = sessionsFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // écriture atomique best-effort : tmp + rename
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/* ---------- env provider : process.env → .env workspace → agentEnv Devin ---------- */
let _dotenv;
function dotenvWs() {
    if (_dotenv !== undefined) return _dotenv;
    _dotenv = {};
    try {
        for (const line of fs.readFileSync(path.join(workspace, '.env'), 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
            if (m) _dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch { /* pas de .env */ }
    return _dotenv;
}
function providerEnv(providerId, name) {
    if (process.env[name]) return process.env[name];
    if (dotenvWs()[name]) return dotenvWs()[name];
    try {
        const s = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'devin', 'User', 'settings.json'), 'utf8'));
        const v = s?.['devin.acp.agentEnv']?.[providerId]?.[name];
        if (v) return v;
    } catch { /* best effort */ }
    return undefined;
}

/* ---------- prompt système (miroir de runtime.ts, sans vscode) ---------- */
// Prompt de base compact pour tous les Bleubites, quel que soit le provider.
// Ce sont des workers à tâches ciblées : œillères, pas de priming AGENTS.md /
// global_rules (~2900 tokens économisés par round — vital pour les upstreams
// à TPM serré type Groq on_demand 7-8k). Le contexte reste accessible via les
// outils si la tâche l'exige. Les casquettes/skills sont injectées ci-dessous
// depuis les puces du bloc workflow (node.skills dans le roster), résolues via
// le registre central skill-mux (.agent/skill-registry.json).

/* ---------- casquettes skills : puces du bloc -> contenu SKILL.md ---------- */
const SKILLS_TOTAL_CAP = 6000;   // chars, budget borne pour les TPM serres
const SKILLS_PER_CAP = 3000;     // chars par SKILL.md

function sessionSkillNames(session) {
    try {
        const rosterPath = path.join(workspace, '.agent', 'workspace-roster.json');
        const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
        const node = (roster?.workflow?.nodes || []).find((n) => n.sessionId === session?.id);
        return Array.isArray(node?.skills) ? node.skills : [];
    } catch { return []; }
}

function skillsBlock(session) {
    const names = sessionSkillNames(session);
    if (!names.length) return '';
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(path.join(workspace, '.agent', 'skill-registry.json'), 'utf8'));
    } catch { return ''; }
    const byName = new Map((registry.skills || []).map((s) => [s.name, s]));
    const parts = [];
    let budget = SKILLS_TOTAL_CAP;
    const missing = [];
    for (const name of names) {
        const entry = byName.get(name) || byName.get(String(name).toLowerCase());
        if (!entry?.file) { missing.push(name); continue; }
        let content = '';
        try { content = fs.readFileSync(entry.file, 'utf8').slice(0, SKILLS_PER_CAP); } catch { missing.push(name); continue; }
        const block = `### Skill: ${name}\n${content}`;
        if (block.length > budget) break;
        budget -= block.length;
        parts.push(block);
    }
    if (!parts.length) return '';
    const tail = missing.length ? `\n(skills introuvables dans le registre: ${missing.join(', ')})` : '';
    return `\n\n[CASQUETTES — SKILLS ASSIGNEES]\n${parts.join('\n\n')}${tail}`;
}

function buildSystemPrompt(mode, session) {
    const root = workspace;
    const lines = [
        'Tu es un agent Bleubite de Hephaistos2-Kit : un worker qui exécute des tâches précises dans l\'IDE, sous la supervision de l\'utilisateur et des agents chefs.',
        `- Workspace Root : ${root} | Windows (win32) | ${new Date().toISOString().slice(0, 10)}`,
        '',
        'Outils disponibles (function-calling, confinés aux zones autorisées : workspace + bleubiteRoots) : fs_write_text_file, fs_read_text_file, fs_list_directory.',
        '',
        'Règles :',
        '- APPELLE les outils pour agir — ne raconte jamais une action que tu n\'as pas réellement exécutée.',
        '- Reste strictement dans la tâche demandée : pas d\'initiative hors périmètre, pas de fichier en dehors des zones autorisées.',
        '- Si un contexte projet est nécessaire (AGENTS.md, règles, docs), lis-le via fs_read_text_file — rien n\'est pré-chargé.',
        '- Réponses en français, concises, directes.',
    ];
    const suffix = {
        plan: '\n\n[MODE PLAN] Architecte logiciel : analyse, décomposition en étapes vérifiables, pas de code tant que la stratégie n\'est pas validée.',
        ask: '\n\n[MODE ASK] Oracle technique : réponses précises, aucune modification de fichiers.',
        debug: '\n\n[MODE DEBUG] Diagnostic causal : cause racine à partir des faits, hypothèses testables, correctif minimal.',
        agent: '\n\n[MODE AGENT] Exécution directe : code complet, prêt pour la production.',
    };
    return lines.join('\n') + (suffix[mode] || suffix.agent) + skillsBlock(session);
}

/* ---------- outils locaux pour les providers API (chat texte) ----------
 * Les providers HTTP (nim/nim2/omniroute/openrouter/huggingface) répondent en
 * chat completions — sans boucle tool_calls ils décrivent des actions au lieu
 * de les exécuter. On expose ici le minimum FS, confiné au workspace. */
const MAX_TOOL_ROUNDS = 16;

/* ---------- MCP distribués aux Bleubites (puces node.mcps du workflow) ----------
 * Le roster déclare par bloc les serveurs MCP autorisés (noms = entrées du
 * broker ~/.config/mcp-mux/mcp-mux.json). Au tour, on spawn chaque serveur
 * en stdio, on liste ses outils, on les expose au modèle en function-calling
 * sous le préfixe mcp__<serveur>__<outil>, puis on route les tool_calls.
 * Les processus sont tués en fin de tour. */
const MCP_PREFIX = 'mcp__';
const MCP_CALL_TIMEOUT_MS = 180_000;
const MCP_SPAWN_TIMEOUT_MS = 15_000;
const MAX_MCPS_PER_SESSION = 4;

function sessionMcpNames(session) {
    try {
        const rosterPath = path.join(workspace, '.agent', 'workspace-roster.json');
        const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
        const node = (roster?.workflow?.nodes || []).find((n) => n.sessionId === session?.id);
        return (Array.isArray(node?.mcps) ? node.mcps : []).slice(0, MAX_MCPS_PER_SESSION);
    } catch { return []; }
}

function mcpCatalogEntry(name) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'mcp-mux', 'mcp-mux.json'), 'utf8'));
        const def = cfg?.servers?.[name];
        if (!def || def.disabled || typeof def.command !== 'string' || !def.command) return null;
        return def;
    } catch { return null; }
}

// Client MCP stdio minimal : spawn + JSON-RPC ligne par ligne.
class McpClient {
    constructor(name, def) {
        this.name = name;
        this.nextId = 1;
        this.pending = new Map();
        this.proc = spawn(def.command, def.args || [], {
            env: { ...process.env, ...(def.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.buf = '';
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (chunk) => this.onData(chunk));
        this.proc.stderr.on('data', () => { /* logs serveur ignorés */ });
        this.proc.on('exit', () => { for (const p of this.pending.values()) p.reject(new Error(`mcp ${this.name}: processus terminé`)); this.pending.clear(); });
        this.proc.on('error', (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
    }
    onData(chunk) {
        this.buf += chunk;
        for (;;) {
            const nl = this.buf.indexOf('\n');
            if (nl < 0) break;
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id == null || !this.pending.has(msg.id)) continue;
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'mcp error'));
            else p.resolve(msg.result);
        }
    }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`mcp ${this.name}: timeout ${method}`)); }, MCP_CALL_TIMEOUT_MS);
            this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
        });
    }
    notify(method) { try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); } catch { /* best effort */ } }
    close() { try { this.proc.kill(); } catch { /* déjà mort */ } }
}

// Pool par session : les serveurs MCP restent chauds entre les tours
// (un scan à froid type vault-pepites met des minutes — respawner à chaque
// tour le paierait à chaque fois). Tués à la dispose de la session.
const mcpPool = new Map(); // sessionId -> { names, clients: Map(name->client|err) }

async function pooledClient(sessionId, name, def) {
    let pool = mcpPool.get(sessionId);
    if (!pool) { pool = { clients: new Map() }; mcpPool.set(sessionId, pool); }
    if (pool.clients.has(name)) {
        const c = pool.clients.get(name);
        return c instanceof Error ? Promise.reject(c) : c;
    }
    const client = new McpClient(name, def);
    const ready = (async () => {
        await Promise.race([
            client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hephaistos-chats', version: '1.0.0' } }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout init')), MCP_SPAWN_TIMEOUT_MS)),
        ]);
        client.notify('notifications/initialized');
        const listed = await client.request('tools/list');
        client.tools = (listed?.tools || []).map((t) => ({
            type: 'function',
            function: {
                name: `${MCP_PREFIX}${name}__${t.name}`.slice(0, 64),
                description: `[${name}] ${String(t.description || '').slice(0, 300)}`,
                parameters: t.inputSchema || { type: 'object', properties: {} },
            },
        }));
        return client;
    })();
    pool.clients.set(name, ready);
    ready.catch(() => pool.clients.set(name, ready)); // l'erreur reste en cache
    return ready;
}

function releaseMcps(sessionId) {
    const pool = mcpPool.get(sessionId);
    if (!pool) return;
    mcpPool.delete(sessionId);
    for (const c of pool.clients.values()) Promise.resolve(c).then((cl) => cl.close?.()).catch(() => { });
}

// Attache les serveurs demandés par le bloc : pool chaud, tools/list, mapping
// de dispatch. Retourne { tools, run(name,argsJson), attached }.
async function attachMcps(session) {
    const names = sessionMcpNames(session);
    const attached = [];
    for (const name of names) {
        const def = mcpCatalogEntry(name);
        if (!def) { attached.push({ name, error: 'absent du catalogue mcp-mux' }); continue; }
        try {
            const client = await pooledClient(session.id, name, def);
            attached.push({ name, client, tools: client.tools || [] });
        } catch (e) {
            attached.push({ name, error: String(e.message || e) });
        }
    }
    const allTools = attached.flatMap((a) => a.tools || []);
    const run = async (fname, argsJson) => {
        const rest = fname.slice(MCP_PREFIX.length);
        const sep = rest.indexOf('__');
        const server = rest.slice(0, sep);
        const tool = rest.slice(sep + 2);
        const att = attached.find((a) => a.name === server && a.client);
        if (!att) return `mcp indisponible: ${server}`;
        let args = {};
        try { args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {}); }
        catch { try { args = JSON.parse(escapeRawControlsInJsonStrings(argsJson || '{}')); } catch { /* args illisibles → {} */ } }
        const res = await att.client.request('tools/call', { name: tool, arguments: args });
        const text = (res?.content || []).map((c) => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
        return text || JSON.stringify(res ?? {});
    };
    return { tools: allTools, run, attached };
}

const CHAT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'fs_write_text_file',
            description: 'Write UTF-8 text content to a file inside the workspace (creates parent dirs).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path relative to workspace root, or absolute inside it' },
                    content: { type: 'string' },
                    append: { type: 'boolean', description: 'Append instead of overwrite (auto-true for .jsonl files)' },
                    overwrite: { type: 'boolean', description: 'Force overwrite even for .jsonl files' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fs_read_text_file',
            description: 'Read a UTF-8 text file inside the workspace (bounded — use offset/max_chars for big files).',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    offset: { type: 'number', description: 'Start position in chars (default 0)' },
                    max_chars: { type: 'number', description: 'Max chars to return (default 8000)' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'fs_list_directory',
            description: 'List the entries of a directory inside the workspace.',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
        },
    },
];

/* Racines autorisées des Bleubites : déclarées dans .mcp-access profil
 * [bleubite] (même fichier que les droits fs_* hphe — portabilité via les
 * tokens <INSTALL_ROOT>, <INGEST_SCAN_ROOT>, <PROJECT_ROOT>, <MEMORY_ROOT>,
 * <USER_PROFILE> substitués par install.ps1 ; en dev brut, les tokens ne
 * matchent rien → fail-closed workspace seul, c'est voulu).
 * HEPHAISTOS_EXTRA_ROOTS reste un appoint local (pas de chemin en dur). */
function mcpAccessRoots() {
    const file = path.join(workspace, '.mcp-access');
    if (!fs.existsSync(file)) return [];
    const tokens = {
        '<INGEST_SCAN_ROOT>': process.env.HPHE_INGEST_ROOTS || '',
        '<INSTALL_ROOT>': process.env.HPHE_INSTALL || '',
        '<PROJECT_ROOT>': workspace,
        '<USER_PROFILE>': process.env.USERPROFILE || process.env.HOME || '',
        '<MEMORY_ROOT>': process.env.HPHE_MEMORY_ROOT || '',
    };
    const roots = [];
    let profile = null;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.trim().match(/^\[(.+)\]$/);
        if (m) { profile = m[1]; continue; }
        const rule = line.trim().match(/^(allow|write|read)\s*:\s*(.+)$/);
        if (!rule || profile !== 'bleubite') continue;
        let pat = rule[2].trim();
        for (const [k, v] of Object.entries(tokens)) pat = pat.split(k).join(v);
        pat = pat.replace(/\/\*\*.*$/, '');
        if (pat && !pat.includes('*')) roots.push(pat);
    }
    return roots;
}

function bleubiteRoots(cwd) {
    const roots = new Set([path.resolve(cwd || workspace)]);
    const extra = (process.env.HEPHAISTOS_EXTRA_ROOTS || '').split(/[;|]/).map(s => s.trim()).filter(Boolean);
    for (const r of [...mcpAccessRoots(), ...extra]) roots.add(path.resolve(r));
    return [...roots];
}

function resolveWorkspacePath(p, cwd) {
    const raw = String(p || '');
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd || workspace, raw);
    for (const root of bleubiteRoots(cwd)) {
        const rel = path.relative(root, abs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
    }
    throw new Error(`chemin hors zones autorisées refusé: ${p}`);
}

// Groq/gpt-oss émet parfois des sauts de ligne BRUTS dans les strings JSON
// (arguments de tool_call) — on les échappe uniquement à l'intérieur des
// chaînes pour rendre le JSON parseable sans casser la structure.
function escapeRawControlsInJsonStrings(s) {
    let out = '', inStr = false, esc = false;
    for (const ch of s) {
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
            out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
            continue;
        }
        out += ch;
    }
    return out;
}

function runLocalTool(name, argsJson, cwd) {
    let args = {};
    try {
        args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {});
    } catch {
        try { args = JSON.parse(escapeRawControlsInJsonStrings(argsJson || '{}')); } catch { /* args illisibles → {} */ }
    }
    switch (name) {
        case 'fs_write_text_file': {
            const target = resolveWorkspacePath(args.path, cwd);
            const content = String(args.content ?? '');
            const append = (args.append === true || target.endsWith('.jsonl')) && args.overwrite !== true;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs[append ? 'appendFileSync' : 'writeFileSync'](target, content);
            return `ok: ${append ? 'ajoute' : 'ecrit'} ${target} (${Buffer.byteLength(content)} octets)`;
        }
        case 'fs_read_text_file': {
            const raw = fs.readFileSync(resolveWorkspacePath(args.path, cwd), 'utf8');
            const off = Math.max(0, Number(args.offset) || 0);
            const cap = Math.min(Math.max(1, Number(args.max_chars) || 8000), 50_000);
            const slice = raw.slice(off, off + cap);
            return off + slice.length < raw.length ? `${slice}\n[tronqué ${raw.length - off - slice.length} chars — offset=${off + slice.length}]` : slice;
        }
        case 'fs_list_directory':
            return fs.readdirSync(resolveWorkspacePath(args.path || '.', cwd), { withFileTypes: true })
                .map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
                .join('\n')
                .slice(0, 50_000);
        default:
            return `outil inconnu: ${name}`;
    }
}

/**
 * Réessaie les réponses transitoires — 429/502/503/504, plus les 413 de type
 * rate-limit ("tokens per minute") qui portent un reset_at/retry_after.
 * Le délai honoré est celui annoncé par l'upstream quand il est lisible.
 */
async function fetchWithRetry(url, opts, label, attempts = 5) {
    const delays = [0, 2000, 5000, 12000];
    let last;
    for (let i = 0; i < attempts; i++) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        const res = await fetch(url, opts);
        if (res.ok || ![413, 429, 502, 503, 504].includes(res.status)) return res;
        last = res;
        if (i + 1 >= attempts) break;
        let waitMs = 0;
        try {
            const clone = res.clone();
            const body = await clone.json().catch(() => null);
            const ra = body?.error?.retry_after ?? body?.error?.reset_seconds;
            if (typeof ra === 'number' && ra > 0) waitMs = Math.min(ra * 1000 + 1500, 60_000);
            else if (typeof ra === 'string' && /^\d+$/.test(ra)) waitMs = Math.min(Number(ra) * 1000 + 1500, 60_000);
            else if (res.status === 413) return res; // 413 non rate-limit = vrai trop gros, inutile de réessayer
        } catch { /* pas de corps lisible */ }
        if (res.status === 413 && !waitMs) return res;
        if (waitMs) delays[i + 1] = waitMs;
    }
    return last;
}

/**
 * Boucle chat-completions avec tool_calls : tant que le modèle demande un outil,
 * on l'exécute localement et on renvoie le résultat en message `tool`.
 * Retourne { msg, trace } — trace = une ligne par appel d'outil pour la transparence.
 */
async function openAiToolsCompletion({ url, headers, body, cwd, label, mcps }) {
    const trace = [];
    const messages = body.messages;
    const allTools = mcps?.tools?.length ? [...CHAT_TOOLS, ...mcps.tools] : CHAT_TOOLS;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const res = await fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, messages, tools: allTools, tool_choice: 'auto' }),
        }, label);
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            // Groq renvoie la génération fautive quand le JSON d'arguments est
            // malformé (sauts de ligne bruts) — on la répare et on exécute
            // l'outil quand même plutôt que de perdre tout le tour.
            if (res.status === 400) {
                let genText = null;
                try { genText = JSON.parse(errText)?.error?.failed_generation; } catch { /* pas du JSON */ }
                if (genText) {
                    try {
                        const gen = JSON.parse(escapeRawControlsInJsonStrings(String(genText)));
                        if (gen?.name) {
                            const argsJson = typeof gen.arguments === 'string' ? gen.arguments : JSON.stringify(gen.arguments || {});
                            const result = gen.name.startsWith(MCP_PREFIX) && mcps ? await mcps.run(gen.name, argsJson) : runLocalTool(gen.name, argsJson, cwd);
                            trace.push(`${gen.name}(réparé) → ${String(result).split('\n')[0].slice(0, 120)}`);
                            const callId = `salvage_${round}`;
                            messages.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: gen.name, arguments: argsJson } }] });
                            messages.push({ role: 'tool', tool_call_id: callId, name: gen.name, content: String(result).slice(0, 50_000) });
                            continue;
                        }
                    } catch { /* génération irrécupérable → erreur normale */ }
                }
            }
            throw new Error(`${label} HTTP ${res.status}: ${errText}`);
        }
        const json = await res.json();
        const msg = json.choices?.[0]?.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) return { msg, trace };
        messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
        for (const call of calls) {
            const fname = call?.function?.name || '';
            let result;
            try {
                result = fname.startsWith(MCP_PREFIX) && mcps
                    ? await mcps.run(fname, call?.function?.arguments)
                    : runLocalTool(fname, call?.function?.arguments, cwd);
            } catch (e) {
                result = `erreur outil: ${e.message}`;
            }
            trace.push(`${fname}(${String(call?.function?.arguments || '').slice(0, 80)}) → ${String(result).split('\n')[0].slice(0, 120)}`);
            messages.push({ role: 'tool', tool_call_id: call.id, name: fname, content: String(result).slice(0, 50_000) });
        }
        // Fenêtre glissante : seuls les 2 derniers résultats d'outils restent
        // entiers — les plus anciens sont stubbés pour borner le contexte
        // (sinon chaque round regrossit indéfiniment et sature le TPM upstream).
        const toolMsgs = messages.filter((m) => m.role === 'tool');
        for (const m of toolMsgs.slice(0, -2)) {
            if (typeof m.content === 'string' && m.content.length > 300 && !m.content.includes('…[stub — résultat ancien')) {
                m.content = `${m.content.slice(0, 300)}…[stub — résultat ancien, ${m.content.length} chars]`;
            }
        }
    }
    // Rounds épuisés : le travail a été fait via les outils mais aucun texte
    // final n'a été émis → "Réponse vide" alors que les livrables existent.
    // Dernier appel SANS outils pour récupérer la synthèse du tour.
    try {
        const res = await fetchWithRetry(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                ...body,
                messages: [...messages, {
                    role: 'user',
                    content: 'Synthèse finale : indique en quelques lignes ce qui a été produit (fichiers écrits, actions faites, verdict). Ne lance plus aucun outil.',
                }],
                tool_choice: 'none',
            }),
        }, label);
        if (res.ok) {
            const json = await res.json();
            const msg = json.choices?.[0]?.message || {};
            if ((msg.content || '').trim()) return { msg, trace };
        }
    } catch { /* la synthèse est best-effort — le trace suffit */ }
    return { msg: { content: '' }, trace };
}

/* ---------- complétion providers (miroir de runtime.ts) ---------- */
async function completeTurn(session) {
    // Puces MCP du bloc workflow : serveurs du pool par session — chauds
    // entre les tours, tués uniquement à la fermeture de la session.
    const mcps = await attachMcps(session);
    return completeTurnWithMcps(session, mcps);
}

async function completeTurnWithMcps(session, mcps) {
    const system = buildSystemPrompt(session.mode || 'agent', session);
    const chatMessages = [
        { role: 'system', content: system },
        ...session.messages.map((m) => ({ role: m.role, content: m.text })),
    ];
    const provider = session.provider;
    const model = session.model;

    const toolCwd = session.workspace || undefined;

    if (provider === 'openrouter') {
        const apiKey = providerEnv('openrouter','OPENROUTER_API_KEY');
        if (!apiKey) throw new Error('OPENROUTER_API_KEY absente.');
        const { msg: orMsg, trace } = await openAiToolsCompletion({
            url: 'https://openrouter.ai/api/v1/chat/completions',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/projet-temporaire/hephaistos2-kit',
                'X-Title': 'Hephaistos Chats ACP',
            },
            body: { model, messages: chatMessages, stream: false },
            cwd: toolCwd,
            label: 'OpenRouter',
            mcps,
        });
        return {
            content: (orMsg.content || '').trim(),
            reasoning: (orMsg.reasoning || orMsg.reasoning_content || '').trim(),
            toolTrace: trace,
        };
    }

    if (provider === 'huggingface') {
        const hfKey = providerEnv('huggingface','HF_TOKEN') || providerEnv('huggingface','HUGGINGFACE_API_KEY');
        if (!hfKey) throw new Error('HF_TOKEN absent.');
        const { msg: hfMsg, trace } = await openAiToolsCompletion({
            url: 'https://router.huggingface.co/v1/chat/completions',
            headers: { Authorization: `Bearer ${hfKey}`, 'Content-Type': 'application/json' },
            body: { model, messages: chatMessages, stream: false },
            cwd: toolCwd,
            label: 'HuggingFace',
            mcps,
        });
        return {
            content: (hfMsg.content || '').trim(),
            reasoning: (hfMsg.reasoning_content || hfMsg.reasoning || '').trim(),
            toolTrace: trace,
        };
    }

    if (provider === 'ollama' || provider === 'ollama-cloud') {
        const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const res = await fetch(`${host}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: chatMessages, stream: false }),
        });
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        return {
            content: (json.message?.content || '').trim(),
            reasoning: (json.message?.thinking || '').trim(),
        };
    }

    if (provider === 'omniroute') {
        const raw = providerEnv('omniroute','OMNIROUTE_BASE_URL') || `http://localhost:${process.env.PORT || '20128'}/v1`;
        const base = /\/v1$/i.test(raw.replace(/\/+$/, '')) ? raw.replace(/\/+$/, '') : `${raw.replace(/\/+$/, '')}/v1`;
        const key = providerEnv('omniroute','OMNIROUTE_API_KEY');
        const { msg: omMsg, trace } = await openAiToolsCompletion({
            url: `${base}/chat/completions`,
            headers: {
                'Content-Type': 'application/json',
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            // max_tokens est compté dans le TPM Groq on_demand (8000/min) :
            // réserve basse — la synthèse tient en une phrase, le contenu
            // volumineux part dans les fichiers via les outils.
            body: { model, messages: chatMessages, max_tokens: 1500, stream: false },
            cwd: toolCwd,
            label: 'OmniRoute',
            mcps,
        });
        return {
            content: (omMsg.content || '').trim(),
            reasoning: (omMsg.reasoning || omMsg.reasoning_content || '').trim(),
            toolTrace: trace,
        };
    }

    if (provider === 'nim' || provider === 'nim2') {
        // Séparation stricte des comptes : nim → NVIDIA_API_KEY, nim2 → NVIDIA_API_KEY_2.
        // Pas de fallback croisé — sinon les deux fenêtres finissent sur le même compte.
        const apiKey = provider === 'nim2' ? providerEnv('nim2','NVIDIA_API_KEY_2') : providerEnv('nim','NVIDIA_API_KEY');
        if (!apiKey) throw new Error(provider === 'nim2' ? 'NVIDIA_API_KEY_2 absente.' : 'NVIDIA_API_KEY absente.');
        const { msg, trace } = await openAiToolsCompletion({
            url: 'https://integrate.api.nvidia.com/v1/chat/completions',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            // Les modèles à raisonnement (nemotron-*) consomment le budget en
            // reasoning_content avant d'émettre content — 4096 suffisait pour
            // l'outil mais vidait la réponse finale. 16384 laisse de la marge.
            body: { model, messages: chatMessages, max_tokens: 16384, stream: false },
            cwd: toolCwd,
            label: 'NVIDIA NIM',
            mcps,
        });
        // modèles à raisonnement : content peut être null si tout part en reasoning_content
        return {
            content: (msg.content || '').trim(),
            reasoning: (msg.reasoning_content || msg.reasoning || '').trim(),
            toolTrace: trace,
        };
    }

    throw new Error(`Provider "${provider}" non pilotable par acp-server (utilise ollama/openrouter/nim/omniroute).`);
}

/* ---------- client ACP imbriqué : les providers passent par l'agent réel ----------
 * Même table que acpClient.ts / acp-inject.js. Le prompt d'une fenêtre dont le
 * provider est ACP est délégué à l'agent (opencode acp + profil routeur,
 * agy_acp_server, kilo, hermes, vibe) — outils, fs, terminal, permissions. */
const EXE = process.platform === 'win32' ? '.exe' : '';
const acpProfile = (cfg) => ({
    cmd: `opencode${EXE}`, args: ['acp'],
    env: { OPENCODE_CONFIG: path.join(process.env.USERPROFILE || '', '.config', 'opencode', cfg) },
});
const AGENT_SPECS = {
    'opencode': { cmd: `opencode${EXE}`, args: ['acp'] },
    'antigravity-acp': { cmd: `agy_acp_server${EXE}`, args: [] },
    'mistral-vibe': { cmd: `vibe-acp${EXE}`, args: [] },
    'hermes': { cmd: `hermes${EXE}`, args: ['acp', '--accept-hooks'] },
    'kilo': { cmd: `kilo${EXE}`, args: ['acp'] },
    'gemini': { cmd: `gemini${EXE}`, args: ['--acp'] },
    'codex-acp': { cmd: `codex-acp${EXE}`, args: [] },
    // RÈGLE : seuls les vrais agents CLI ont leur transport ACP ici.
    // nim/nim2/ollama/openrouter/huggingface : API officielle directe,
    // jamais via `opencode acp` (sessions partagées = cross-talk).
    // OmniRoute : serveur ACP stdio de la gateway locale (localhost:20128) —
    // le modèle est figé au spawn (--model passé par l'appelant si présent).
    'omniroute': { cmd: 'omniroute', args: ['acp'] },
};
const AGENT_ONLY = new Set(['opencode', 'antigravity-acp', 'mistral-vibe', 'hermes', 'kilo', 'gemini', 'codex-acp']);

/* Résout un binaire via PATH × PATHEXT ; shims npm .cmd/.bat via cmd.exe. */
function resolveExecutable(cmd) {
    if (cmd.includes(path.sep) || cmd.includes('/')) return { file: cmd, viaCmd: false };
    const base = cmd.replace(/\.(exe|cmd|bat)$/i, '');
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const exe = path.join(dir, `${base}${EXE}`);
        if (EXE && fs.existsSync(exe)) return { file: exe, viaCmd: false };
    }
    const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => !/\.exe/i.test(e));
    for (const dir of dirs) {
        for (const ext of exts) {
            const p = path.join(dir, base + ext);
            if (fs.existsSync(p)) return { file: p, viaCmd: /\.(cmd|bat)$/i.test(ext) };
        }
        const bare = path.join(dir, base);
        if (fs.existsSync(bare)) return { file: bare, viaCmd: false };
    }
    return { file: cmd, viaCmd: false };
}

/* agentEnv Devin (PATH/clés/NIM_ACCOUNT) lu une fois depuis User/settings.json */
function devinAgentEnv(providerId) {
    try {
        const file = path.join(process.env.APPDATA || '', 'devin', 'User', 'settings.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw['devin.acp.agentEnv']?.[providerId] || {};
    } catch {
        return {};
    }
}

/**
 * Un tour complet délégué à l'agent ACP : spawn → initialize →
 * session/load(acpSessionId) ou session/new → session/prompt → accumulate.
 * Retourne { content, reasoning, acpSessionId } ; lève une erreur si indisponible.
 */
function agentTurn(session, text, cwd) {
    const spec = AGENT_SPECS[session.provider];
    if (!spec) return Promise.reject(new Error(`provider ${session.provider} non ACP`));
    const root = cwd || workspace;

    return new Promise((resolve, reject) => {
        const resolved = resolveExecutable(spec.cmd);
        const file = resolved.viaCmd ? (process.env.ComSpec || 'cmd.exe') : resolved.file;
        const args = resolved.viaCmd ? ['/d', '/s', '/c', `"${resolved.file}"`, ...spec.args] : spec.args;
        const child = spawn(file, args, {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, ...devinAgentEnv(session.provider), ...(spec.env || {}) },
        });
        let buf = '';
        let nextId = 1;
        const pending = new Map();
        const terminals = new Map();
        let nextTerm = 1;
        let accText = '';
        let accThought = '';
        let acpSessionId = session.acpSessionId || null;
        let done = false;

        const write = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* mort */ } };
        const request = (method, params) => {
            const rid = nextId++;
            write({ jsonrpc: '2.0', id: rid, method, params });
            return new Promise((res, rej) => pending.set(rid, { res, rej }));
        };
        const respondTo = (rid, result) => write({ jsonrpc: '2.0', id: rid, result });
        const finish = (err, out) => {
            if (done) return;
            done = true;
            try { child.kill(); } catch { /* noop */ }
            for (const t of terminals.values()) { try { t.child.kill(); } catch { /* noop */ } }
            err ? reject(err) : resolve(out);
        };
        const timer = setTimeout(() => finish(new Error('agent ACP timeout 300s')), 300000);

        function handleAgentRequest(msg) {
            const { id: rid, method, params } = msg;
            try {
                switch (method) {
                    case 'fs/read_text_file':
                        return respondTo(rid, { content: fs.readFileSync(params.path, 'utf8') });
                    case 'fs/write_text_file':
                        fs.mkdirSync(path.dirname(params.path), { recursive: true });
                        fs[(params.append === true || String(params.path).endsWith('.jsonl')) && params.overwrite !== true ? 'appendFileSync' : 'writeFileSync'](params.path, params.content);
                        return respondTo(rid, {});
                    case 'session/request_permission': {
                        const opts = params?.options || [];
                        const allow = opts.find((o) => /allow/i.test(o.kind || o.name || '')) || opts[0];
                        return respondTo(rid, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } });
                    }
                    case 'terminal/create': {
                        const tid = `t${nextTerm++}`;
                        const env = { ...process.env };
                        for (const e of params?.env || []) if (e?.name) env[e.name] = e.value ?? '';
                        const t = { output: '', exited: null, waiters: [], child: null };
                        t.child = spawn(params.command, params.args || [], {
                            cwd: params.cwd || root, env, windowsHide: true,
                            shell: process.platform === 'win32',
                        });
                        const cap = (d) => { t.output = (t.output + d.toString('utf8')).slice(-1_000_000); };
                        t.child.stdout?.on('data', cap);
                        t.child.stderr?.on('data', cap);
                        t.child.on('exit', (code, signal) => {
                            t.exited = { exitCode: code, signal };
                            for (const w of t.waiters.splice(0)) w(t.exited);
                        });
                        terminals.set(tid, t);
                        return respondTo(rid, { terminalId: tid });
                    }
                    case 'terminal/output': {
                        const t = terminals.get(params?.terminalId);
                        return respondTo(rid, { output: t?.output || '', truncated: false, exitStatus: t?.exited || null });
                    }
                    case 'terminal/wait_for_exit': {
                        const t = terminals.get(params?.terminalId);
                        if (!t) return respondTo(rid, { exitCode: null, signal: null });
                        if (t.exited) return respondTo(rid, t.exited);
                        t.waiters.push((e) => respondTo(rid, e));
                        return;
                    }
                    case 'terminal/kill': {
                        try { terminals.get(params?.terminalId)?.child.kill(); } catch { /* noop */ }
                        return respondTo(rid, {});
                    }
                    case 'terminal/release': {
                        try { terminals.get(params?.terminalId)?.child.kill(); } catch { /* noop */ }
                        terminals.delete(params?.terminalId);
                        return respondTo(rid, {});
                    }
                    default:
                        return respondTo(rid, null);
                }
            } catch {
                return respondTo(rid, null);
            }
        }

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            buf += d;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id != null && msg.method) {
                    handleAgentRequest(msg);
                } else if (msg.id != null && pending.has(msg.id)) {
                    const p = pending.get(msg.id);
                    pending.delete(msg.id);
                    msg.error ? p.rej(new Error(msg.error.message || 'Erreur ACP')) : p.res(msg.result);
                } else if (msg.method === 'session/update') {
                    const u = msg.params?.update;
                    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') accText += u.content.text;
                    else if (u?.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') accThought += u.content.text;
                }
            }
        });
        child.on('error', (e) => { clearTimeout(timer); finish(e); });
        child.on('exit', () => {
            if (!done) {
                clearTimeout(timer);
                finish(accText ? null : new Error(`agent ${session.provider} terminé avant réponse`),
                    accText ? { content: accText, reasoning: accThought, acpSessionId } : undefined);
            }
        });
        child.stderr.on('data', () => { /* diagnostics */ });

        (async () => {
            await request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
                clientInfo: { name: 'hephaistos-chats-acp-server', version: '0.1.0' },
            });
            if (acpSessionId) {
                try {
                    await request('session/load', { sessionId: acpSessionId, cwd: root, mcpServers: [] });
                } catch {
                    try {
                        await request('session/resume', { sessionId: acpSessionId, cwd: root, mcpServers: [] });
                    } catch {
                        const res = await request('session/new', { cwd: root, mcpServers: [] });
                        acpSessionId = res?.sessionId || acpSessionId;
                    }
                }
            } else {
                const res = await request('session/new', { cwd: root, mcpServers: [] });
                acpSessionId = res?.sessionId || null;
            }
            if (!acpSessionId) throw new Error('agent sans sessionId');
            await request('session/prompt', {
                sessionId: acpSessionId,
                prompt: [{ type: 'text', text }],
            });
            clearTimeout(timer);
            finish(null, { content: accText, reasoning: accThought, acpSessionId });
        })().catch((e) => { clearTimeout(timer); finish(e); });
    });
}

/* ---------- protocole binôme : la fenêtre exécute son propre ACK ----------
 * Le prompt de join demande au pair de lancer `binome.js --as hephaistos ... join`.
 * La fenêtre n'a pas de shell : son runtime (ce serveur ACP) est l'acteur —
 * il valide la forme stricte attendue puis execFile sans shell. */
function tryBinomeJoin(text, cwd) {
    const m = text.match(/binome\.js\s+(--as\s+hephaistos\s+[\s\S]+?join)/);
    if (!m) return null;
    const args = m[1].replace(/\s+/g, ' ').trim().split(' ');
    // forme stricte : --as hephaistos ... join ; chaque arg restreint aux caractères sûrs
    if (args[0] !== '--as' || args[1] !== 'hephaistos' || args[args.length - 1] !== 'join') return null;
    if (!args.every((a) => /^[A-Za-z0-9._:=/-]+$/.test(a))) return null;
    const script = path.join(cwd || workspace, '.agent', 'agent-bridge', 'binome.js');
    if (!fs.existsSync(script)) return null;
    try {
        return execFileSync(process.execPath, [script, ...args], {
            cwd: cwd || workspace,
            encoding: 'utf8',
            timeout: 60000,
            windowsHide: true,
        }).trim();
    } catch (e) {
        return `⚠️ binome join échoué : ${e.stderr || e.message}`;
    }
}

/* ---------- handlers ACP ---------- */
const sessions = new Map(); // sessionId -> cwd

const handlers = {
    async initialize(params, id) {
        if (params?.clientInfo) { /* noop */ }
        respond(id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: 'hephaistos-chats', version: '0.1.0' },
        });
    },

    async 'session/load'(params, id) {
        const { sessionId, cwd } = params || {};
        if (!sessionId) return fail(id, -32602, 'sessionId requis');
        if (cwd) sessions.set(sessionId, cwd);
        const found = readSessions(cwd).find((s) => s.id === sessionId);
        if (!found) return fail(id, -32000, `session ${sessionId} introuvable dans ${sessionsFile(cwd)}`);
        respond(id, {});
    },

    async 'session/new'(params, id) {
        const { cwd, provider = 'nim2', model = 'meta/llama-3.2-11b-vision-instruct', mode = 'agent', title } = params || {};
        const session = {
            id: `chat-${Date.now().toString(36)}`,
            mode,
            provider,
            model,
            title: title || undefined,
            messages: [],
            updatedAt: new Date().toISOString(),
            workspace: cwd || workspace,
        };
        const all = readSessions(cwd);
        all.push(session);
        writeSessions(cwd, all);
        sessions.set(session.id, cwd || workspace);
        respond(id, { sessionId: session.id });
    },

    async 'session/prompt'(params, id) {
        const { sessionId, prompt } = params || {};
        const cwd = sessions.get(sessionId);
        if (!sessionId) return fail(id, -32602, 'sessionId requis');
        const all = readSessions(cwd);
        const session = all.find((s) => s.id === sessionId);
        if (!session) return fail(id, -32000, `session ${sessionId} introuvable`);

        const text = (Array.isArray(prompt) ? prompt : [])
            .filter((p) => p && p.type === 'text')
            .map((p) => p.text)
            .join('\n')
            .trim();
        if (!text) return fail(id, -32602, 'prompt texte vide');

        session.messages.push({ role: 'user', text, at: new Date().toISOString() });
        // Flush immédiat + activité précoce : la fenêtre (qui surveille
        // sessions.json) affiche le prompt reçu, et l'injecteur observe
        // `delivered` — sinon un tour long (retry_after provider) reste
        // invisible jusqu'à sa fin et meurt muet au timeout.
        try { writeSessions(cwd, all); } catch { /* best-effort */ }
        thoughtChunk(sessionId, '…');
        let turn = { content: '', reasoning: '' };
        const binomeOut = tryBinomeJoin(text, cwd);
        if (binomeOut !== null) {
            turn.content = binomeOut;
        } else if (AGENT_SPECS[session.provider]) {
            // Provider ACP : délégation à l'agent réel (outils/fs/terminal), comme la webview via acpClient.
            try {
                const agentRes = await agentTurn(session, text, cwd);
                turn = agentRes;
                if (agentRes.acpSessionId) session.acpSessionId = agentRes.acpSessionId;
            } catch (e) {
                if (AGENT_ONLY.has(session.provider)) {
                    turn.content = `⚠️ Agent ${session.provider} indisponible : ${e.message}`;
                } else {
                    try {
                        turn = await completeTurn(session);
                    } catch (e2) {
                        turn.content = `⚠️ Erreur : ${e2.message}`;
                    }
                }
            }
        } else {
            try {
                turn = await completeTurn(session);
            } catch (e) {
                turn.content = `⚠️ Erreur : ${e.message}`;
            }
        }
        const reply = (turn.toolTrace?.length
            ? `[outils exécutés] ${turn.toolTrace.join(' | ')}\n\n`
            : '') + (turn.content || (turn.reasoning
            ? '⚠️ Réponse vide : le modèle a épuisé son budget en raisonnement.'
            : '⚠️ Réponse vide.'));
        const assistantMsg = { role: 'assistant', text: reply, at: new Date().toISOString() };
        if (turn.reasoning) assistantMsg.thinking = turn.reasoning;
        session.messages.push(assistantMsg);
        session.updatedAt = new Date().toISOString();
        try { writeSessions(cwd, all); } catch { /* best-effort */ }

        // Notification bus : chaque réponse Bleubite (et chaque erreur) est
        // poussée sur comms.jsonl — watchdog/orchestrateur voient l'activité.
        try {
            const bus = path.join(cwd, '.agent', 'comms.jsonl');
            const isErr = reply.startsWith('⚠️');
            fs.appendFileSync(bus, JSON.stringify({
                ts: new Date().toISOString(), src: sessionId, dst: 'orchestrator',
                kind: isErr ? 'agent-error' : 'agent-reply',
                text: reply.slice(0, 500),
            }) + '\n');
        } catch { /* bus indisponible */ }

        // Clôture orchestrateur : le mot-clé DONE:<task_id> dans la réponse
        // marque la tâche — le worker n'a pas besoin de connaître les outils MCP.
        for (const m of reply.matchAll(/DONE:(\d+)/g)) {
            try {
                spawn(process.execPath, [
                    process.env.HOME + '/.config/devin/scripts/mcp-call.mjs',
                    'Hephaistos-everything-search', 'update_task',
                    JSON.stringify({ task_id: Number(m[1]), status: 'done', result: `done-signal from ${sessionId}` }),
                ], { detached: true, stdio: 'ignore' }).unref();
            } catch { /* best-effort */ }
        }

        // stream ACP : raisonnement en agent_thought_chunk, réponse en agent_message_chunk
        const CHUNK = 400;
        for (let i = 0; i < turn.reasoning.length; i += CHUNK) {
            thoughtChunk(sessionId, turn.reasoning.slice(i, i + CHUNK));
        }
        for (let i = 0; i < reply.length; i += CHUNK) {
            chunk(sessionId, reply.slice(i, i + CHUNK));
        }
        respond(id, { stopReason: 'end_turn' });
    },

    async 'session/cancel'(params, id) {
        respond(id, {});
    },

    async 'session/set_mode'(params, id) {
        const { sessionId, mode } = params || {};
        const cwd = sessions.get(sessionId);
        const all = readSessions(cwd);
        const s = all.find((x) => x.id === sessionId);
        if (s && mode) { s.mode = mode; s.updatedAt = new Date().toISOString(); writeSessions(cwd, all); }
        respond(id, {});
    },
};

/* ---------- boucle principale ---------- */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method && handlers[msg.method]) {
            Promise.resolve(handlers[msg.method](msg.params || {}, msg.id)).catch((e) => {
                if (msg.id != null) fail(msg.id, -32000, e.message || String(e));
            });
        } else if (msg.method) {
            if (msg.id != null) fail(msg.id, -32601, `méthode inconnue: ${msg.method}`);
        }
        // réponses aux requêtes émises par le serveur : ignorées (le serveur n'en émet pas)
    }
});
// Nettoyage du pool MCP à la sortie : les serveurs spawnés ne doivent pas
// devenir orphelins quand la fenêtre/serveur meurt.
const releaseAllMcps = () => { for (const id of [...mcpPool.keys()]) releaseMcps(id); };
// Suicide si un ancêtre meurt : stdin ne se ferme pas toujours quand l'IDE
// est tué — sans garde, le serveur ACP devient orphelin avec son pool MCP.
try {
    const { guardAncestors } = await import('../../.agent/agent-bridge/parent-guard.mjs');
    guardAncestors({ onExit: () => releaseAllMcps() });
} catch { /* garde indisponible : on vit sans */ }
process.stdin.on('end', () => { releaseAllMcps(); process.exit(0); });
process.on('SIGTERM', () => { releaseAllMcps(); process.exit(0); });
process.on('SIGINT', () => { releaseAllMcps(); process.exit(0); });
process.on('exit', releaseAllMcps);
process.on('uncaughtException', () => { releaseAllMcps(); process.exit(1); });
