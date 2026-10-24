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

/* ---------- prompt système (miroir de runtime.ts, sans vscode) ---------- */
function buildSystemPrompt(mode) {
    const root = workspace;
    const lines = [
        'Tu es l\'agent d\'ingénierie et d\'intelligence opérationnelle de Hephaistos2-Kit (The Developer\'s Forge).',
        'Tu vis et opères à l\'intérieur de l\'IDE (Devin / Cursor / VS Code).',
        '',
        '### Contexte de l\'Espace de Travail (IDE)',
        `- Répertoire de travail (Workspace Root) : ${root}`,
        `- Système d'exploitation : Windows (win32) | Date courante : ${new Date().toISOString().slice(0, 10)}`,
        '- Infrastructure locale : serveur unifié Hephaistos-everything-search (REST http://127.0.0.1:8792), orchestrateur ws://127.0.0.1:7477.',
        '',
        'Directives : réponses en français, professionnelles, concises, directes ; code propre et sécurisé.',
    ];
    // Priming : mandat + règles globales du kit, comme tout agent à l'arrivée.
    try {
        const agentsMd = path.join(root, 'AGENTS.md');
        if (fs.existsSync(agentsMd)) lines.push(`\n[MANDAT MAÎTRE AGENTS.MD]\n${fs.readFileSync(agentsMd, 'utf8')}`);
    } catch { /* best effort */ }
    try {
        const rulesMd = path.join(root, '.agent', 'rules', 'global_rules.md');
        if (fs.existsSync(rulesMd)) lines.push(`\n[RÈGLES GLOBALES DU KIT — TRONC CONTRACTUEL]\n${fs.readFileSync(rulesMd, 'utf8').slice(0, 8000)}`);
    } catch { /* best effort */ }
    const suffix = {
        plan: '\n\n[MODE PLAN] Architecte logiciel : analyse, décomposition en étapes vérifiables, pas de code tant que la stratégie n\'est pas validée.',
        ask: '\n\n[MODE ASK] Oracle technique : réponses précises, aucune modification de fichiers.',
        debug: '\n\n[MODE DEBUG] Diagnostic causal : cause racine à partir des faits, hypothèses testables, correctif minimal.',
        agent: '\n\n[MODE AGENT] Exécution directe : code complet, prêt pour la production.',
    };
    return lines.join('\n') + (suffix[mode] || suffix.agent);
}

/* ---------- complétion providers (miroir de runtime.ts) ---------- */
async function completeTurn(session) {
    const system = buildSystemPrompt(session.mode || 'agent');
    const chatMessages = [
        { role: 'system', content: system },
        ...session.messages.map((m) => ({ role: m.role, content: m.text })),
    ];
    const provider = session.provider;
    const model = session.model;

    if (provider === 'openrouter') {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY absente.');
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/projet-temporaire/hephaistos2-kit',
                'X-Title': 'Hephaistos Chats ACP',
            },
            body: JSON.stringify({ model, messages: chatMessages, stream: false }),
        });
        if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        const orMsg = json.choices?.[0]?.message || {};
        return {
            content: (orMsg.content || '').trim(),
            reasoning: (orMsg.reasoning || orMsg.reasoning_content || '').trim(),
        };
    }

    if (provider === 'huggingface') {
        const hfKey = process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
        if (!hfKey) throw new Error('HF_TOKEN absent.');
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${hfKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: chatMessages, stream: false }),
        });
        if (!res.ok) throw new Error(`HuggingFace HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        const hfMsg = json.choices?.[0]?.message || {};
        return {
            content: (hfMsg.content || '').trim(),
            reasoning: (hfMsg.reasoning_content || hfMsg.reasoning || '').trim(),
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
        const raw = process.env.OMNIROUTE_BASE_URL || `http://localhost:${process.env.PORT || '20128'}/v1`;
        const base = /\/v1$/i.test(raw.replace(/\/+$/, '')) ? raw.replace(/\/+$/, '') : `${raw.replace(/\/+$/, '')}/v1`;
        const key = process.env.OMNIROUTE_API_KEY;
        const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify({ model, messages: chatMessages, max_tokens: 8192, stream: false }),
        });
        if (!res.ok) throw new Error(`OmniRoute HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        const omMsg = json.choices?.[0]?.message || {};
        return {
            content: (omMsg.content || '').trim(),
            reasoning: (omMsg.reasoning || omMsg.reasoning_content || '').trim(),
        };
    }

    if (provider === 'nim' || provider === 'nim2') {
        // Séparation stricte des comptes : nim → NVIDIA_API_KEY, nim2 → NVIDIA_API_KEY_2.
        // Pas de fallback croisé — sinon les deux fenêtres finissent sur le même compte.
        const apiKey = provider === 'nim2' ? process.env.NVIDIA_API_KEY_2 : process.env.NVIDIA_API_KEY;
        if (!apiKey) throw new Error(provider === 'nim2' ? 'NVIDIA_API_KEY_2 absente.' : 'NVIDIA_API_KEY absente.');
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: chatMessages, max_tokens: 4096, stream: false }),
        });
        if (!res.ok) throw new Error(`NVIDIA NIM HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const json = await res.json();
        // modèles à raisonnement : content peut être null si tout part en reasoning_content
        const msg = json.choices?.[0]?.message || {};
        return {
            content: (msg.content || '').trim(),
            reasoning: (msg.reasoning_content || msg.reasoning || '').trim(),
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
                        fs.writeFileSync(params.path, params.content);
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
        const reply = turn.content || (turn.reasoning
            ? '⚠️ Réponse vide : le modèle a épuisé son budget en raisonnement.'
            : '⚠️ Réponse vide.');
        const assistantMsg = { role: 'assistant', text: reply, at: new Date().toISOString() };
        if (turn.reasoning) assistantMsg.thinking = turn.reasoning;
        session.messages.push(assistantMsg);
        session.updatedAt = new Date().toISOString();
        try { writeSessions(cwd, all); } catch { /* best-effort */ }

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
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', () => process.exit(1));
