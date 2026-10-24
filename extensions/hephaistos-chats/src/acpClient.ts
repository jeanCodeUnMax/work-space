import { execFile, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { devinAgentEnv } from './devinConfig';
import { ChatTool } from './types';
import { logRuntime } from './runtime';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Tue le processus ET tout son arbre — un shim .cmd tué seul laisse l'agent orphelin. */
function killTree(child: ChildProcess | null | undefined): void {
    if (!child || child.killed) return;
    try {
        if (process.platform === 'win32' && child.pid) {
            execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => { /* noop */ });
        } else {
            child.kill();
        }
    } catch { /* noop */ }
}

interface ProviderSpec {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    /** Le serveur fige son modèle au spawn (--model) : on le passe en argv et on respawne au changement. */
    modelArg?: boolean;
}

/** Serveur ACP stdio de la gateway OmniRoute locale (localhost:20128). */
// omniroute.cmd (.local/bin) délègue 'acp' au harness C:\Program Files\servers\omni-routeur

function opencodeProfile(cfg: string): ProviderSpec {
    return {
        cmd: `opencode${EXE}`,
        args: ['acp'],
        env: { OPENCODE_CONFIG: path.join(process.env.USERPROFILE || '', '.config', 'opencode', cfg) },
    };
}

/** Résout un binaire via PATH × PATHEXT (.exe d'abord, puis shim .cmd/.bat). */
function resolveExecutable(cmd: string): { file: string; viaCmd: boolean } {
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

/** Modèle configuré dans le profil OPENCODE_CONFIG du provider (routeur). */
export function acpProfileModel(providerId: string): string | null {
    const spec = PROVIDERS[providerId];
    const cfg = spec?.env?.OPENCODE_CONFIG
        || path.join(process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json');
    try {
        const raw = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        return raw.model || raw.agent?.model || null;
    } catch {
        return null;
    }
}

/* Même table que .agent/agent-bridge/acp-inject.js : les providers "modèles"
 * (nim, ollama, openrouter…) passent par `opencode acp` + OPENCODE_CONFIG —
 * c'est le routeur, exactement comme les onglets agents natifs de l'IDE. */
const PROVIDERS: Record<string, ProviderSpec> = {
    'opencode': { cmd: `opencode${EXE}`, args: ['acp'] },
    'antigravity-acp': { cmd: `agy_acp_server${EXE}`, args: [] },
    'mistral-vibe': { cmd: `vibe-acp${EXE}`, args: [] },
    'hermes': { cmd: `hermes${EXE}`, args: ['acp', '--accept-hooks'] },
    'kilo': { cmd: `kilo${EXE}`, args: ['acp'] },
    'gemini': { cmd: `gemini${EXE}`, args: ['--acp'] },
    'codex-acp': { cmd: `codex-acp${EXE}`, args: [] },
    'ollama': opencodeProfile('opencode-ollama.json'),
    'nim': opencodeProfile('opencode-nim.json'),
    'nim2': opencodeProfile('opencode-nim2.json'),
    'openrouter': opencodeProfile('opencode-openrouter.json'),
    'huggingface': opencodeProfile('opencode-hf.json'),
    'omniroute': { cmd: 'omniroute', args: ['acp'], modelArg: true },
};

/** Providers Devin connus mais sans transport ACP local (CLI TUI / API cloud). */
export const ACP_UNSUPPORTED = new Set(['cline', 'vtcode', 'devin-cloud', 'devin-cli']);

/** Providers servis uniquement par ACP (pas de fallback HTTP direct). */
const ACP_ONLY = new Set(['opencode', 'antigravity-acp', 'mistral-vibe', 'hermes', 'kilo', 'gemini', 'codex-acp']);

export function isAcpProvider(providerId: string): boolean {
    return providerId in PROVIDERS;
}

export function isAcpOnlyProvider(providerId: string): boolean {
    return ACP_ONLY.has(providerId);
}

interface PendingRequest {
    res: (v: any) => void;
    rej: (e: any) => void;
}

interface TurnCallbacks {
    onChunk?: (accumulated: string) => void;
    onThought?: (accumulated: string) => void;
    onTools?: (tools: ChatTool[]) => void;
}

interface TerminalHandle {
    child: ChildProcess;
    output: string;
    exited: { exitCode: number | null; signal: string | null } | null;
    waiters: ((e: { exitCode: number | null; signal: string | null }) => void)[];
    limit: number;
}

class AcpConnection {
    private child: ChildProcess | null = null;
    private buf = '';
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private terminals = new Map<string, TerminalHandle>();
    private nextTermId = 1;
    acpSessionId: string | null = null;
    private attached = false;
    private alive = false;
    private turnCbs: TurnCallbacks | null = null;
    private tools = new Map<string, ChatTool>();
    private accText = '';
    private accThought = '';
    readonly providerId: string;
    private cwd: string;
    /** Modèle passé au spawn (spec.modelArg) — comparé au modèle voulu pour respawn. */
    spawnedModel: string | undefined;
    private spawnModel: string | undefined;

    constructor(providerId: string, cwd: string, model?: string) {
        this.providerId = providerId;
        this.cwd = cwd;
        this.spawnModel = model;
    }

    isAlive(): boolean {
        return this.alive && !!this.child && !this.child.killed;
    }

    private write(obj: unknown): void {
        try {
            this.child?.stdin?.write(JSON.stringify(obj) + '\n');
        } catch {
            /* mort */
        }
    }

    private request(method: string, params: unknown): Promise<any> {
        const id = this.nextId++;
        this.write({ jsonrpc: '2.0', id, method, params });
        return new Promise((res, rej) => this.pending.set(id, { res, rej }));
    }

    private respond(id: number, result: unknown): void {
        this.write({ jsonrpc: '2.0', id, result });
    }

    /* ---------- requêtes agent → client (fs, terminal, permissions) ---------- */

    private handleAgentRequest(msg: { id: number; method: string; params: any }): void {
        const { id, method, params } = msg;
        try {
            switch (method) {
                case 'fs/read_text_file': {
                    const content = fs.readFileSync(params.path, 'utf8');
                    return this.respond(id, { content });
                }
                case 'fs/write_text_file': {
                    fs.mkdirSync(path.dirname(params.path), { recursive: true });
                    fs.writeFileSync(params.path, params.content);
                    return this.respond(id, {});
                }
                case 'session/request_permission': {
                    const options = params?.options || [];
                    const allow = options.find((o: any) => /allow/i.test(o.kind || o.name || '')) || options[0];
                    return this.respond(id, {
                        outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
                    });
                }
                case 'terminal/create':
                    return this.respond(id, this.terminalCreate(params));
                case 'terminal/output':
                    return this.respond(id, this.terminalOutput(params));
                case 'terminal/wait_for_exit':
                    return this.terminalWaitExit(id, params);
                case 'terminal/kill': {
                    const t = this.terminals.get(params?.terminalId);
                    killTree(t?.child);
                    return this.respond(id, {});
                }
                case 'terminal/release': {
                    const t = this.terminals.get(params?.terminalId);
                    killTree(t?.child);
                    this.terminals.delete(params?.terminalId);
                    return this.respond(id, {});
                }
                default:
                    return this.respond(id, null);
            }
        } catch (e: any) {
            return this.respond(id, null);
        }
    }

    private terminalCreate(params: any): { terminalId: string } {
        const id = `term-${this.nextTermId++}`;
        const limit = typeof params?.outputByteLimit === 'number' ? params.outputByteLimit : 1_000_000;
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        for (const e of params?.env || []) {
            if (e?.name) env[e.name] = e.value ?? '';
        }
        const term: TerminalHandle = {
            child: null as any,
            output: '',
            exited: null,
            waiters: [],
            limit,
        };
        const child = spawn(params.command, params.args || [], {
            cwd: params.cwd || this.cwd,
            env,
            windowsHide: true,
            shell: process.platform === 'win32',
        });
        term.child = child;
        const cap = (d: Buffer) => {
            term.output += d.toString('utf8');
            if (term.output.length > term.limit) {
                term.output = term.output.slice(-term.limit);
            }
        };
        child.stdout?.on('data', cap);
        child.stderr?.on('data', cap);
        child.on('exit', (code, signal) => {
            term.exited = { exitCode: code, signal };
            for (const w of term.waiters.splice(0)) w(term.exited);
        });
        this.terminals.set(id, term);
        return { terminalId: id };
    }

    private terminalOutput(params: any): any {
        const t = this.terminals.get(params?.terminalId);
        if (!t) return { output: '', truncated: false, exitStatus: null };
        return {
            output: t.output,
            truncated: t.output.length >= t.limit,
            exitStatus: t.exited,
        };
    }

    private terminalWaitExit(id: number, params: any): void {
        const t = this.terminals.get(params?.terminalId);
        if (!t) {
            this.respond(id, { exitCode: null, signal: null });
            return;
        }
        if (t.exited) {
            this.respond(id, t.exited);
            return;
        }
        t.waiters.push((e) => this.respond(id, e));
    }

    /* ---------- notifications session/update ---------- */

    private handleNotification(msg: { method: string; params: any }): void {
        if (msg.method !== 'session/update') return;
        if (msg.params?.sessionId && this.acpSessionId && msg.params.sessionId !== this.acpSessionId) return;
        const u = msg.params?.update;
        if (!u) return;
        const cbs = this.turnCbs;
        switch (u.sessionUpdate) {
            case 'agent_message_chunk':
                if (u.content?.type === 'text' && typeof u.content.text === 'string') {
                    this.accText += u.content.text;
                    cbs?.onChunk?.(this.accText);
                }
                break;
            case 'agent_thought_chunk':
                if (u.content?.type === 'text' && typeof u.content.text === 'string') {
                    this.accThought += u.content.text;
                    cbs?.onThought?.(this.accThought);
                }
                break;
            case 'tool_call':
                this.tools.set(u.toolCallId, {
                    id: u.toolCallId,
                    title: u.title || u.kind || 'outil',
                    kind: u.kind,
                    status: u.status,
                });
                cbs?.onTools?.([...this.tools.values()]);
                break;
            case 'tool_call_update': {
                const t = this.tools.get(u.toolCallId);
                if (t) {
                    if (u.status) t.status = u.status;
                    if (u.title) t.title = u.title;
                    cbs?.onTools?.([...this.tools.values()]);
                }
                break;
            }
            case 'plan': {
                const entries = Array.isArray(u.entries) ? u.entries : [];
                this.tools.set('__plan__', {
                    id: '__plan__',
                    title: `Plan — ${entries.length} étape${entries.length > 1 ? 's' : ''}`,
                    kind: 'plan',
                    status: 'pending',
                });
                cbs?.onTools?.([...this.tools.values()]);
                break;
            }
            default:
                break;
        }
    }

    /* ---------- cycle de vie ---------- */

    async connect(): Promise<void> {
        const spec = PROVIDERS[this.providerId];
        if (!spec) throw new Error(`provider ACP inconnu: ${this.providerId}`);
        // Env de l'agent telle que configurée dans Devin (PATH install, clés, NIM_ACCOUNT…)
        const devinEnv = devinAgentEnv(this.providerId);
        const resolved = resolveExecutable(spec.cmd);
        // Les shims npm (.cmd/.bat) exigent cmd.exe ; argv explicite, quoting contrôlé.
        const file = resolved.viaCmd ? (process.env.ComSpec || 'cmd.exe') : resolved.file;
        const specArgs = spec.modelArg && this.spawnModel ? [...spec.args, '--model', this.spawnModel] : spec.args;
        const args = resolved.viaCmd ? ['/d', '/s', '/c', `"${resolved.file}"`, ...specArgs] : specArgs;
        this.spawnedModel = spec.modelArg ? this.spawnModel : undefined;
        this.child = spawn(file, args, {
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, ...devinEnv, ...(spec.env || {}) },
        });
        this.child.stdout?.setEncoding('utf8');
        this.child.stdout?.on('data', (d: string) => {
            this.buf += d;
            let idx;
            while ((idx = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, idx).trim();
                this.buf = this.buf.slice(idx + 1);
                if (!line) continue;
                let msg: any;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id != null && msg.method) {
                    this.handleAgentRequest(msg);
                } else if (msg.id != null && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    msg.error
                        ? p.rej(new Error(msg.error.message || 'Erreur ACP'))
                        : p.res(msg.result);
                } else if (msg.method) {
                    this.handleNotification(msg);
                }
            }
        });
        this.child.on('error', (e) => {
            this.alive = false;
            for (const p of this.pending.values()) p.rej(e);
            this.pending.clear();
        });
        this.child.on('exit', () => {
            this.alive = false;
            this.attached = false;
            for (const p of this.pending.values()) p.rej(new Error(`agent ${this.providerId} terminé`));
            this.pending.clear();
        });
        this.child.stderr?.on('data', () => { /* diagnostics */ });
        this.alive = true;

        await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
            },
            clientInfo: { name: 'hephaistos-chats', version: '0.1.0' },
        });
        logRuntime(`acp connect provider=${this.providerId} pid=${this.child.pid}`);
    }

    /** Extrait les modèles disponibles : res.models OU res.configOptions (variante AGY). */
    private extractModels(res: any): { id: string; name?: string }[] {
        const avail = res?.models?.availableModels;
        if (Array.isArray(avail) && avail.length) {
            return avail.map((m: any) => ({ id: m.modelId || m.id || String(m), name: m.name }));
        }
        const cfg = Array.isArray(res?.configOptions) ? res.configOptions : [];
        const modelOpt = cfg.find((o: any) => /model/i.test(o.id || '') || /model/i.test(o.name || '')) || cfg[0];
        const opts = Array.isArray(modelOpt?.options) ? modelOpt.options : [];
        return opts.map((o: any) => ({ id: o.value || o.id || String(o), name: o.name }));
    }

    /** Applique le modèle demandé via session/set_config_option si la valeur existe (AGY). */
    private async applyWantedModel(res: any, wanted?: string): Promise<void> {
        if (!wanted || !this.acpSessionId) return;
        const cfg = Array.isArray(res?.configOptions) ? res.configOptions : [];
        for (const opt of cfg) {
            const opts = Array.isArray(opt?.options) ? opt.options : [];
            if (opts.some((o: any) => o.value === wanted || o.id === wanted)) {
                try {
                    await this.request('session/set_config_option', {
                        sessionId: this.acpSessionId,
                        configId: opt.id || opt.name,
                        value: wanted,
                    });
                } catch { /* best-effort */ }
                return;
            }
        }
        if (res?.models?.availableModels?.some((m: any) => (m.modelId || m.id) === wanted)) {
            try {
                await this.request('session/set_model', { sessionId: this.acpSessionId, modelId: wanted });
            } catch { /* best-effort */ }
        }
    }

    /** Attache la session ACP : session/new la première fois, session/load après respawn. */
    async ensureSession(storedAcpSessionId: string | undefined, mode: string, wantedModel?: string): Promise<{ sessionId: string; models?: any }> {
        if (this.attached && this.acpSessionId) {
            return { sessionId: this.acpSessionId };
        }
        if (storedAcpSessionId) {
            try {
                await this.request('session/load', {
                    sessionId: storedAcpSessionId,
                    cwd: this.cwd,
                    mcpServers: [],
                });
                this.acpSessionId = storedAcpSessionId;
                this.attached = true;
                logRuntime(`acp session/load ok ${storedAcpSessionId}`);
                return { sessionId: storedAcpSessionId };
            } catch (e: any) {
                logRuntime(`acp session/load échec (${e.message}) → session/resume`);
            }
            try {
                await this.request('session/resume', {
                    sessionId: storedAcpSessionId,
                    cwd: this.cwd,
                });
                this.acpSessionId = storedAcpSessionId;
                this.attached = true;
                logRuntime(`acp session/resume ok ${storedAcpSessionId}`);
                return { sessionId: storedAcpSessionId };
            } catch (e: any) {
                logRuntime(`acp session/resume échec (${e.message}) → session/new`);
            }
        }
        const res = await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
        this.acpSessionId = res?.sessionId || null;
        if (!this.acpSessionId) {
            throw new Error('session/new sans sessionId');
        }
        this.attached = true;
        if (mode && res?.modes?.availableModes?.some((m: any) => m.id === mode)) {
            try { await this.request('session/set_mode', { sessionId: this.acpSessionId, modeId: mode }); } catch { /* best-effort */ }
        }
        await this.applyWantedModel(res, wantedModel);
        logRuntime(`acp session/new ok ${this.acpSessionId}`);
        // Modèles : models.availableModels OU configOptions (kilo/vibe/AGY mettent
        // le catalogue dans configOptions — models.availableModels y est vide).
        const avail = res?.models?.availableModels;
        const models = Array.isArray(avail) && avail.length ? avail : this.extractModels(res);
        return { sessionId: this.acpSessionId, models: { availableModels: models } };
    }

    async prompt(text: string, cbs: TurnCallbacks, signal?: AbortSignal): Promise<{ stopReason?: string; text: string; thought: string }> {
        if (!this.acpSessionId) throw new Error('session ACP non attachée');
        this.accText = '';
        this.accThought = '';
        this.tools.clear();
        this.turnCbs = cbs;

        const onAbort = () => {
            this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpSessionId } });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await this.request('session/prompt', {
                sessionId: this.acpSessionId,
                prompt: [{ type: 'text', text }],
            });
            return { stopReason: res?.stopReason, text: this.accText, thought: this.accThought };
        } finally {
            signal?.removeEventListener('abort', onAbort);
            this.turnCbs = null;
        }
    }

    dispose(): void {
        this.alive = false;
        for (const p of this.pending.values()) p.rej(new Error('connexion ACP disposée'));
        this.pending.clear();
        for (const t of this.terminals.values()) {
            killTree(t.child);
            for (const w of t.waiters.splice(0)) w({ exitCode: null, signal: null });
        }
        this.terminals.clear();
        killTree(this.child);
        this.child = null;
        this.attached = false;
    }
}

/* ---------- registre par session de chat ---------- */
const connections = new Map<string, AcpConnection>();

export function acpDispose(chatSessionId: string): void {
    connections.get(chatSessionId)?.dispose();
    connections.delete(chatSessionId);
}

export function acpDisposeAll(): void {
    for (const c of connections.values()) c.dispose();
    connections.clear();
}

export interface AcpTurnParams {
    chatSessionId: string;
    providerId: string;
    storedAcpSessionId?: string;
    mode: string;
    model?: string;
    text: string;
    cwd: string;
    signal?: AbortSignal;
    cbs: TurnCallbacks;
}

/** Un tour complet dans une fenêtre ACP : connect → ensureSession → prompt → réponse. */
export async function acpTurn(p: AcpTurnParams): Promise<{ reply: string; acpSessionId: string; models?: any }> {
    const spec = PROVIDERS[p.providerId];
    let conn = connections.get(p.chatSessionId);
    // Serveur à modèle figé au spawn : le modèle a changé → respawn, sinon le
    // tour partirait silencieusement sur l'ancien modèle.
    if (conn && spec?.modelArg && conn.spawnedModel !== p.model) {
        conn.dispose();
        connections.delete(p.chatSessionId);
        conn = undefined;
    }
    if (!conn || !conn.isAlive() || conn.providerId !== p.providerId) {
        conn?.dispose();
        conn = new AcpConnection(p.providerId, p.cwd, p.model);
        connections.set(p.chatSessionId, conn);
        await conn.connect();
    }
    const { sessionId, models } = await conn.ensureSession(p.storedAcpSessionId, p.mode, p.model);
    const res = await conn.prompt(p.text, p.cbs, p.signal);
    return { reply: res.text, acpSessionId: sessionId, models };
}

/* ---------- sonde de modèles : spawn → initialize → session/new → kill ---------- */
export async function probeAcpModels(providerId: string, cwd: string): Promise<{ provider: string; id: string }[]> {
    const spec = PROVIDERS[providerId];
    if (!spec) return [];
    const conn = new AcpConnection(providerId, cwd);
    try {
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 90000));
        const work = (async () => {
            await conn.connect();
            const res = await conn.ensureSession(undefined, '');
            const avail = res?.models?.availableModels || [];
            return avail.map((m: any) => ({ provider: providerId, id: m.id || m.modelId || String(m) }));
        })();
        return await Promise.race([work, timeout]);
    } catch {
        return [];
    } finally {
        conn.dispose();
    }
}
