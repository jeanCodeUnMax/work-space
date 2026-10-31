import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import * as vscode from 'vscode';
import { acpProfileModel, acpTurn, ACP_UNSUPPORTED, isAcpOnlyProvider, isAcpProvider, probeAcpModels } from './acpClient';
import { devinAgentEnabled, devinAgentPreference, providerEnv } from './devinConfig';
import { runDevinTurn } from './devinRoute';
import { ACP_PROVIDERS, AcpProvider, ChatMode, ChatTool, ListedModel, TurnCtx } from './types';

const MODEL_SOURCE: Record<string, string> = {
    nim: 'nvidia-nim',
    nim2: 'nvidia-nim2',
    openrouter: 'openrouter-free',
    ollama: 'ollama',
    'ollama-cloud': 'ollama-cloud',
};

const REQUEST_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** Journal de diagnostic lisible hors de l'extension host. */
export function logRuntime(...args: unknown[]): void {
    try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || 'C:/Program Files/Projet-complet/hephaistos2-kit';
        const dir = path.join(root, '.agent', 'chats');
        fs.mkdirSync(dir, { recursive: true });
        const line = args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' ')
            .replace(/Bearer\s+\S+/g, 'Bearer ***');
        fs.appendFileSync(path.join(dir, 'runtime.log'), `[${new Date().toISOString()}] ${line}\n`);
    } catch {
        /* best effort */
    }
}

/** Suivi orchestrateur : injecté par extension.ts, no-op si absent. */
let orchTracker: ((p: Record<string, unknown>) => void) | null = null;
export function setOrchTracker(fn: ((p: Record<string, unknown>) => void) | null): void {
    orchTracker = fn;
}
function orchTrack(p: Record<string, unknown>): void {
    try { orchTracker?.(p); } catch { /* suivi best-effort, jamais bloquant */ }
}

/** Combine le signal d'annulation utilisateur avec un timeout dur. */
function makeRequestSignal(userSignal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error(`le fournisseur n'a pas répondu en ${Math.round(ms / 1000)}s`)),
        ms,
    );
    const onAbort = () => controller.abort(userSignal?.reason);
    if (userSignal) {
        if (userSignal.aborted) {
            controller.abort(userSignal.reason);
        } else {
            userSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            userSignal?.removeEventListener('abort', onAbort);
        },
    };
}

// Chargement automatique des fichiers d'environnement du workspace et du kit
function loadWorkspaceEnv(): void {
    // Racine du kit dérivée de l'emplacement de l'extension (out/ → ../../..)
    // — aucun chemin machine en dur. USERPROFILE reste la référence du profil.
    const kitRoot = path.resolve(__dirname, '..', '..', '..');
    const candidates = [
        path.join(kitRoot, '.env'),
        ...(process.env.USERPROFILE ? [
            path.join(process.env.USERPROFILE, 'AppData', 'Local', 'hermes', '.env'),
            path.join(process.env.USERPROFILE, '.env'),
        ] : []),
    ];
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        candidates.unshift(path.join(wsRoot, '.env'));
    }

    for (const envPath of candidates) {
        try {
            if (fs.existsSync(envPath)) {
                const text = fs.readFileSync(envPath, 'utf8');
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx > 0) {
                        const key = trimmed.slice(0, eqIdx).trim();
                        const val = trimmed.slice(eqIdx + 1).trim();
                        if (key && !process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            }
        } catch {
            /* ignore */
        }
    }
}
loadWorkspaceEnv();

const SKIP_MODEL = /embed|guard|parse|clip|lyria|reward|detector|nvclip|riva|deplot|fuyu|kosmos|diffusion|synthetic|calibration|neva|vila|muse-glimmer/i;

function readText(file: string): string | undefined {
    try {
        const text = fs.readFileSync(file, 'utf8').trim();
        return text || undefined;
    } catch {
        return undefined;
    }
}

function restToken(): string | undefined {
    if (process.env.HPHE_REST_TOKEN) {
        return process.env.HPHE_REST_TOKEN.trim();
    }
    const candidates = [
        'C:/Program Files/servers/hephaistos2-kit/data/hphe-rest.token',
        path.join(process.env.HPHE_INSTALL || 'C:/Program Files/servers/hephaistos2-kit', 'data', 'hphe-rest.token'),
        path.join(process.env.ProgramFiles || 'C:/Program Files', 'servers', 'hephaistos2-kit', 'data', 'hphe-rest.token'),
    ];
    for (const c of candidates) {
        const found = readText(c);
        if (found) return found;
    }
    return undefined;
}

function bridgeToken(workspace: string | undefined): string | undefined {
    if (process.env.ORCH_MONITOR_TOKEN) {
        return process.env.ORCH_MONITOR_TOKEN.trim();
    }
    if (!workspace) {
        return undefined;
    }
    return readText(path.join(workspace, '.agent', 'ws-bridge.token'));
}

async function rest(name: string, args: Record<string, unknown>): Promise<any> {
    const token = restToken();
    if (!token) {
        throw new Error('Jeton REST Hephaistos introuvable.');
    }
    const response = await fetch(`http://127.0.0.1:8792/tools/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const body = (await response.json()) as any;
    if (!response.ok) {
        throw new Error(body?.error || `Outil ${name} refusé (${response.status}).`);
    }
    return body;
}

export async function callHpheTool(name: string, args: Record<string, unknown>): Promise<any> {
    return rest(name, args);
}

export interface ProviderSyncResult {
    provider: string;
    models: ListedModel[];
    source: 'acp-probe' | 'http' | 'rest' | 'fallback' | 'unsupported';
    error?: string;
}

/** NIM (compte 1 ou 2) — référence : liste officielle /v1/models. */
async function syncNimModels(providerId: string): Promise<ListedModel[]> {
    const key = providerId === 'nim2'
        ? (providerEnv('nim2','NVIDIA_API_KEY_2') || providerEnv('nim2','NVIDIA_API_KEY'))
        : (providerEnv('nim','NVIDIA_API_KEY') || providerEnv('nim','NVIDIA_API_KEY_2'));
    if (!key) return [];
    try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as any;
        const ids: string[] = Array.isArray(data.data) ? data.data.map((m: any) => m.id).sort((a: string, b: string) => a.localeCompare(b)) : [];
        return ids.filter((id) => !SKIP_MODEL.test(id)).map((id) => ({ provider: providerId, id }));
    } catch {
        return [];
    }
}

/** Ollama local (:cloud exclus) ou Ollama Cloud (:cloud uniquement). */
async function syncOllamaModels(providerId: string): Promise<ListedModel[]> {
    const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    const wantCloud = providerId === 'ollama-cloud';
    try {
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
        if (!res.ok) return [];
        const data = (await res.json()) as { models?: { name: string }[] };
        return (data.models || [])
            .sort((a, b) => a.name.localeCompare(b.name))
            .filter((m) => m.name.includes(':cloud') === wantCloud)
            .map((m) => ({ provider: providerId, id: m.name }));
    } catch {
        return [];
    }
}

const OPENROUTER_FALLBACK: ListedModel[] = [
    { provider: 'openrouter', id: 'liquid/lfm-2.5-2.6b:free' },
    { provider: 'openrouter', id: 'poolside/laguna-s-2.1:free' },
    { provider: 'openrouter', id: 'minimax/minimax-m3.1-flash:free' },
    { provider: 'openrouter', id: 'cohere/north-mini-code:free' },
];

/** OpenRouter : /api/v1/models si clé, sinon liste :free curée. */
async function syncOpenRouterModels(): Promise<ListedModel[]> {
    const key = providerEnv('openrouter','OPENROUTER_API_KEY');
    if (key) {
        try {
            const res = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
            });
            if (res.ok) {
                const data = (await res.json()) as any;
                const ids: string[] = Array.isArray(data.data) ? data.data.map((m: any) => m.id) : [];
                const free = ids.filter((id) => id.endsWith(':free') && !SKIP_MODEL.test(id));
                if (free.length) return free.map((id) => ({ provider: 'openrouter', id }));
            }
        } catch {
            /* fallback curé */
        }
    }
    return OPENROUTER_FALLBACK;
}

/** URL de base de la gateway OmniRoute (même règle que le harness omni-routeur). */
function omnirouteBase(): string {
    const raw = providerEnv('omniroute','OMNIROUTE_BASE_URL') || `http://localhost:${process.env.PORT || '20128'}/v1`;
    const trimmed = String(raw).replace(/\/+$/, '');
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** OmniRoute : catalogue de la gateway locale — /v1/models (~440 entrées). */
async function syncOmnirouteModels(providerId: string): Promise<ListedModel[]> {
    const key = providerEnv('omniroute','OMNIROUTE_API_KEY');
    try {
        const res = await fetch(`${omnirouteBase()}/models`, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as any;
        // Whitelist free/local : aihorde/pollinations/veoaifree = generation
        // d'images (ComfyUI), uncloseai = provider mort, gemini = forfait payant.
        // openrouter : seuls les :free restent (le reste debite la cle).
        const FREE_OWNERS = new Set(['combo', 'ollama-cloud', 'cloudflare-ai', 'huggingchat',
            'duckduckgo-web', 'kilo-gateway', 'nvidia', 'groq', 'mistral', 'huggingface']);
        const NON_CHAT = /image|flux|sdxl|diffus|dall|ltx|hunyuan|video|whisper|tts|audio|rerank|moderation|embed/i;
        const ids: string[] = Array.isArray(data.data)
            ? data.data
                .filter((m: any) => {
                    const owner = String(m.owned_by || '');
                    const id = String(m.id || '');
                    if (NON_CHAT.test(id)) return false;
                    if (owner === 'openrouter') return id.endsWith(':free');
                    return FREE_OWNERS.has(owner);
                })
                .map((m: any) => String(m.id))
                .sort((a: string, b: string) => a.localeCompare(b))
            : [];
        return ids.filter((id) => !SKIP_MODEL.test(id)).map((id) => ({ provider: providerId, id }));
    } catch {
        return [];
    }
}

/** Listes connues quand le provider n'annonce pas ses modèles en ACP. */
const ACP_MODEL_FALLBACK: Record<string, string[]> = {
    'gemini': ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-3-pro-preview'],
    'codex-acp': ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-mini'],
    'opencode': ['opencode/grok-code-fast-1', 'opencode/nemotron-3-ultra-free', 'opencode/big-pickle'],
    'huggingface': ['deepseek-ai/DeepSeek-V3.2', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
};

/**
 * Syncing par provider — même contrat que la sonde NIM : liste triée de modèles.
 * Agents ACP → session/new (models/configOptions) ; providers HTTP → API officielle.
 */
export async function syncProviderModels(providerId: string, cwd: string): Promise<ProviderSyncResult> {
    try {
        if (providerId === 'devin-cli') {
            // Pas de transport ACP spawnable — la liste reflète les modèles Devin
            // connus (préférence IDE en tête), pas une sonde live.
            const pref = devinAgentPreference('devin-cli').model;
            const known = ['swe-2-high', 'swe-2-max'];
            const ids = pref ? [pref, ...known.filter((m) => m !== pref)] : known;
            return { provider: providerId, models: ids.map((id) => ({ provider: providerId, id })), source: 'fallback' };
        }
        if (ACP_UNSUPPORTED.has(providerId)) {
            return { provider: providerId, models: [], source: 'unsupported', error: 'pas de transport ACP local' };
        }
        if (providerId === 'opencode' || providerId === 'huggingface') {
            // Le modèle actif est celui du profil OPENCODE_CONFIG (la sonde ACP
            // renvoie les agents build/plan, pas la liste des modèles).
            const m = acpProfileModel(providerId) || devinAgentPreference(providerId).model;
            const known = ACP_MODEL_FALLBACK[providerId] || [];
            const ids = m ? [m, ...known.filter((x) => x !== m)] : known;
            return { provider: providerId, models: ids.map((id) => ({ provider: providerId, id })), source: 'fallback' };
        }
        if (isAcpOnlyProvider(providerId)) {
            const models = await probeAcpModels(providerId, cwd);
            if (models.length) {
                return { provider: providerId, models, source: 'acp-probe' };
            }
            // Sonde vide (cold-start/timeout ou provider qui n'annonce pas ses
            // modèles, ex. gemini/codex) : liste statique connue + préférence Devin.
            const pref = devinAgentPreference(providerId).model;
            const known = ACP_MODEL_FALLBACK[providerId] || [];
            const ids = pref ? [pref, ...known.filter((m) => m !== pref)] : known;
            return {
                provider: providerId,
                models: ids.map((id) => ({ provider: providerId, id })),
                source: 'acp-probe',
                error: 'aucun modèle annoncé',
            };
        }
        if (providerId === 'nim' || providerId === 'nim2') {
            return { provider: providerId, models: await syncNimModels(providerId), source: 'http' };
        }
        if (providerId === 'ollama' || providerId === 'ollama-cloud') {
            return { provider: providerId, models: await syncOllamaModels(providerId), source: 'http' };
        }
        if (providerId === 'openrouter') {
            return { provider: providerId, models: await syncOpenRouterModels(), source: 'http' };
        }
        if (providerId === 'omniroute') {
            return { provider: providerId, models: await syncOmnirouteModels(providerId), source: 'http' };
        }
        if (isAcpProvider(providerId)) {
            // profil opencode restant — modèle du profil puis préférence Devin
            const pref = acpProfileModel(providerId) || devinAgentPreference(providerId).model;
            return { provider: providerId, models: pref ? [{ provider: providerId, id: pref }] : [], source: 'fallback' };
        }
        return { provider: providerId, models: [], source: 'unsupported' };
    } catch (e: any) {
        return { provider: providerId, models: [], source: 'fallback', error: e?.message || String(e) };
    }
}

/* Cache des listes de modèles : les sondes ACP spawnent des agents réels —
 * on ne les relance pas à chaque ouverture de fenêtre (TTL 120 s). */
let modelsCache: { key: string; at: number; models: ListedModel[] } | null = null;
const MODELS_CACHE_TTL_MS = 120_000;

export async function pingModels(enabled: Set<string>): Promise<ListedModel[]> {
    const key = [...enabled].sort().join(',');
    if (modelsCache && modelsCache.key === key && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
        return modelsCache.models;
    }
    const listed: ListedModel[] = [];

    // 1. Hephaistos REST (modèles centralisés) — source additionnelle
    try {
        const body = await rest('available_models', { refresh: true });
        const groups = body?.providers || {};
        for (const provider of ACP_PROVIDERS) {
            if (!enabled.has(provider.id)) continue;
            const source = MODEL_SOURCE[provider.id];
            const ids: string[] = source && Array.isArray(groups[source]) ? groups[source] : [];
            for (const id of ids) {
                if (typeof id === 'string' && !SKIP_MODEL.test(id)) {
                    listed.push({ provider: provider.id, id });
                }
            }
        }
    } catch {
        /* fallback direct */
    }

    // 2. Sync de chaque provider activé — HTTP en parallèle, agents ACP par
    // groupes de 3 (spawn réel : le parallélisme total fait expirer les sondes)
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const ids = [...enabled];
    logRuntime(`sync start enabled=[${ids.join(',')}]`);
    const httpIds = ids.filter((id) => !isAcpOnlyProvider(id));
    const acpIds = ids.filter((id) => isAcpOnlyProvider(id));
    const results: ProviderSyncResult[] = await Promise.all(httpIds.map((id) => syncProviderModels(id, cwd)));
    for (let i = 0; i < acpIds.length; i += 3) {
        const batch = await Promise.all(acpIds.slice(i, i + 3).map((id) => syncProviderModels(id, cwd)));
        results.push(...batch);
    }
    for (const r of results) {
        // Chaque provider loggue son résultat — fini les listes vides silencieuses
        logRuntime(r.error
            ? `sync ${r.provider}: ${r.error} (${r.models.length} repli)`
            : `sync ${r.provider}: ${r.models.length} modèles`);
        for (const m of r.models) {
            if (!listed.some((x) => x.provider === m.provider && x.id === m.id)) {
                listed.push(m);
            }
        }
    }

    // 3. Tri par provider puis id — l'UI garde son champ de recherche
    listed.sort((a, b) => a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider));
    modelsCache = { key, at: Date.now(), models: listed };
    return listed;
}

function getWorkspaceContext(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        return 'Aucun workspace ouvert dans l\'IDE.';
    }

    const lines = [
        `### Contexte de l'Espace de Travail (IDE)`,
        `- Répertoire de travail (Workspace Root) : ${root}`,
        `- Système d'exploitation : Windows (win32) | Date courante : ${new Date().toISOString().slice(0, 10)}`,
        `- Forge logicielle active : Hephaistos2-Kit (The Developer's Forge)`,
        `- Infrastructure locale :`,
        `  * Serveur unifié Hephaistos-everything-search (REST loopback http://127.0.0.1:8792)`,
        `  * Orchestrateur multi-agents & Watchdog (WebSocket ws://127.0.0.1:7477)`,
        `  * Moteur de recherche NTFS MFT/USN instantané (sans Everything.exe) & Tantivy`,
    ];

    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
        const topFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
        lines.push(`- Dossiers principaux à la racine : [${dirs.join(', ')}]`);
        lines.push(`- Fichiers à la racine : [${topFiles.join(', ')}]`);
    } catch {
        /* best effort */
    }

    try {
        const skillsDir = path.join(root, '.agent', 'skills');
        if (fs.existsSync(skillsDir)) {
            const skills = fs.readdirSync(skillsDir);
            lines.push(`- Compétences (Skills) actives dans .agent/skills/ : [${skills.join(', ')}]`);
        }
    } catch {
        /* best effort */
    }

    try {
        const agentsDir = path.join(root, '.agent', 'agents');
        if (fs.existsSync(agentsDir)) {
            const agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''));
            lines.push(`- Agents disponibles pour délégation (.agent/agents/) : [${agents.join(', ')}]`);
        }
    } catch {
        /* best effort */
    }

    try {
        const agentsMd = path.join(root, 'AGENTS.md');
        if (fs.existsSync(agentsMd)) {
            const content = fs.readFileSync(agentsMd, 'utf8');
            lines.push(`\n[MANDAT MAÎTRE AGENTS.MD (Règles obligatoires Hephaistos-first)]\n${content}`);
        }
    } catch {
        /* best effort */
    }

    // Règles globales : priming obligatoire à l'arrivée de l'agent, comme tout
    // agent du kit (identités Cash/Tango/Bleubites, lois, priorité, langue).
    // On injecte la tête du fichier — le tronc contractuel — plafonnée pour
    // ne pas saturer le contexte du modèle à chaque tour.
    try {
        const rulesMd = path.join(root, '.agent', 'rules', 'global_rules.md');
        if (fs.existsSync(rulesMd)) {
            const content = fs.readFileSync(rulesMd, 'utf8');
            lines.push(`\n[RÈGLES GLOBALES DU KIT — TRONC CONTRACTUEL]\n${content.slice(0, 8000)}`);
        }
    } catch {
        /* best effort */
    }

    return lines.join('\n');
}

function buildSystemPrompt(mode: ChatMode): string {
    const wsContext = getWorkspaceContext();
    const baseCore = [
        'Tu es l\'agent d\'ingénierie et d\'intelligence opérationnelle de Hephaistos2-Kit (The Developer\'s Forge).',
        'Tu vis et opères à l\'intérieur de l\'IDE (Devin / Cursor / VS Code).',
        '',
        wsContext,
        '',
        'Tu appliques rigoureusement les directives fondamentales du kit :',
        '1. Architecture canonique : Serveur MCP unifié Rust "Hephaistos-everything-search" (58 outils, stdio/REST :8792). Recherche NTFS instantanée ($MFT/USN) Hephaistos-first sans Everything.exe.',
        '2. Interdiction formelle des scans récursifs lents (Get-ChildItem -Recurse, find, dir /s) pour la découverte de fichiers.',
        '3. Protocole binôme : Distinction stricte entre Cash (exécuteur dans l\'IDE) et Tango (Antigravity hub). Commandes /jointes et /chat-id supportées pour la synchronisation multi-agents.',
        '4. Style de réponse : Français obligatoire, professionnel, concis, direct, sans bavardage inutile, code propre et sécurisé conforme aux standards industriels.',
    ].join('\n');

    switch (mode) {
        case 'plan':
            return `${baseCore}\n\n[MODE PLAN ACTIF] Tu agis en tant qu'architecte logiciel principal. Analyse les besoins, décompose la tâche en étapes logiques actionnables avec critères de vérification précis. Ne génère pas de code exécutable tant que la stratégie n'est pas validée.`;
        case 'ask':
            return `${baseCore}\n\n[MODE ASK ACTIF] Tu agis en tant qu'oracle technique et consultant expert. Réponds précisément aux questions, fournis explications claires et contextes sans modifier de fichiers ni générer de modifications non demandées.`;
        case 'debug':
            return `${baseCore}\n\n[MODE DEBUG ACTIF] Tu agis en tant que spécialiste du diagnostic causale et de l'analyse système. Recherche méthodiquement la cause racine à partir des faits et logs, formule des hypothèses testables et propose le correctif minimal exact.`;
        case 'agent':
        default:
            return `${baseCore}\n\n[MODE AGENT ACTIF] Tu es en mode exécution directe. Fournis du code complet, prêt pour la production, sans raccourcis, avec typage rigoureux et gestion élégante des cas limites.`;
    }
}

export async function completeTurn(
    provider: string,
    model: string,
    mode: ChatMode,
    messages: { role: 'user' | 'assistant'; text: string }[],
    onChunk?: (token: string) => void,
    abortSignal?: AbortSignal,
    onThought?: (accumulated: string) => void,
    ctx?: TurnCtx,
): Promise<string> {
    const req = makeRequestSignal(abortSignal, REQUEST_TIMEOUT_MS);
    logRuntime(`→ completeTurn provider=${provider} model=${model} mode=${mode} messages=${messages.length}`);
    // Tracé orchestrateur : chaque tour devient une tâche acp_chat visible
    // dans le moniteur (pending/in_progress -> completed/failed).
    const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const preview = messages.filter((m) => m.role === 'user').pop()?.text || '';
    orchTrack({
        requestId, action: 'start', provider, model, mode,
        sessionId: ctx?.chatSessionId || '', workspace: wsRoot,
        preview: preview.slice(0, 400), ts: new Date().toISOString(),
    });
    try {
        let reply: string;
        if (provider === 'devin-cli') {
            // Route hub : pas de transport ACP local — le message est injecté
            // dans une session Devin existante via le ws-bridge :7477 et la
            // réponse remonte par comms.jsonl (asynchrone, tour agent).
            reply = await runDevinTurn(model, mode, messages, onChunk, abortSignal || req.signal, ctx, (m) => logRuntime(m));
        } else if (ACP_UNSUPPORTED.has(provider)) {
            throw new Error(`Le provider "${provider}" n'a pas de transport ACP local (agent externe / cloud) — choisis un agent installé ou un provider routé.`);
        } else if (isAcpProvider(provider)) {
            // Fenêtre agent ACP : même protocole que les onglets natifs de l'IDE.
            // Pas de timeout dur 120s — les tours agent (outils) peuvent durer.
            try {
                reply = await runAcpTurn(provider, model, mode, messages, onChunk, abortSignal || req.signal, onThought, ctx);
            } catch (e: any) {
                if (isAcpOnlyProvider(provider)) throw e;
                // Provider modèle (nim/ollama/openrouter) : repli HTTP si le routeur ACP est indisponible.
                logRuntime(`acp indisponible (${e?.message}) → fallback HTTP direct`);
                reply = await runProviderTurn(provider, model, mode, messages, onChunk, req.signal, onThought);
            }
        } else {
            reply = await runProviderTurn(provider, model, mode, messages, onChunk, req.signal, onThought);
        }
        logRuntime(`← completeTurn provider=${provider} model=${model} réponse=${reply.length} car.`);
        orchTrack({ requestId, action: 'done', result: reply.slice(0, 4000), ts: new Date().toISOString() });
        return reply;
    } catch (error: any) {
        logRuntime(`✗ completeTurn provider=${provider} model=${model} erreur=${error?.message || String(error)}`);
        orchTrack({ requestId, action: 'fail', error: error?.message || String(error), ts: new Date().toISOString() });
        throw error;
    } finally {
        req.done();
    }
}

/** Tour ACP : délègue la conversation à l'agent (spawn + session/new|load + prompt streamé). */
async function runAcpTurn(
    provider: string,
    model: string,
    mode: ChatMode,
    messages: { role: 'user' | 'assistant'; text: string }[],
    onChunk: ((token: string) => void) | undefined,
    signal: AbortSignal,
    onThought: ((accumulated: string) => void) | undefined,
    ctx: TurnCtx | undefined,
): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const text = messages.filter((m) => m.role === 'user').pop()?.text || '';
    const res = await acpTurn({
        chatSessionId: ctx?.chatSessionId || `anon-${Date.now()}`,
        providerId: provider,
        storedAcpSessionId: ctx?.acpSessionId,
        mode,
        model,
        text,
        cwd,
        signal,
        cbs: { onChunk, onThought, onTools: ctx?.onTools },
    });
    if (res.acpSessionId && res.acpSessionId !== ctx?.acpSessionId) {
        ctx?.onAcpSessionId?.(res.acpSessionId);
    }
    return res.reply || 'Réponse vide.';
}

async function runProviderTurn(
    provider: string,
    model: string,
    mode: ChatMode,
    messages: { role: 'user' | 'assistant'; text: string }[],
    onChunk: ((token: string) => void) | undefined,
    abortSignal: AbortSignal,
    onThought?: (accumulated: string) => void,
): Promise<string> {
    const system = buildSystemPrompt(mode);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let autoContext = '';

    // Détection automatique de fichiers mentionnés dans le prompt pour injection contextuelle
    const lastUser = messages.filter((m) => m.role === 'user').pop();
    if (lastUser && root) {
        const text = lastUser.text;
        const fileRegex = /([a-zA-Z0-9_\-/\\]+\.[a-zA-Z0-9]{1,8})/g;
        const matches = text.match(fileRegex) || [];
        for (const candidate of matches.slice(0, 3)) {
            const absPath = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
            try {
                if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
                    const content = fs.readFileSync(absPath, 'utf8').slice(0, 3000);
                    autoContext += `\n[FICHIER LOCALISÉ ET INSPECTÉ DANS LE WORKSPACE : ${candidate}]\n\`\`\`\n${content}\n\`\`\`\n`;
                }
            } catch {
                /* continuer */
            }
        }
    }

    // Formater les messages pour le format standard OpenAI / Chat
    const chatMessages = [
        { role: 'system', content: autoContext ? `${system}\n\n${autoContext}` : system },
        ...messages.map((m) => ({ role: m.role, content: m.text })),
    ];

    // ROUTAGE FOURNISSEURS :

    // A. OpenRouter
    if (provider === 'openrouter') {
        const apiKey = providerEnv('openrouter','OPENROUTER_API_KEY');
        if (!apiKey) {
            throw new Error('OPENROUTER_API_KEY absente de l\'environnement.');
        }

        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/projet-temporaire/hephaistos2-kit',
                'X-Title': 'Hephaistos Chats',
            },
            body: JSON.stringify({
                model,
                messages: chatMessages,
                stream: !!onChunk,
            }),
            signal: abortSignal,
        });

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`OpenRouter HTTP ${res.status}: ${errBody}`);
        }

        if (onChunk && res.body) {
            return await readSseStream(res.body, onChunk, onThought);
        }

        const json = (await res.json()) as any;
        const orMsg = json.choices?.[0]?.message;
        const orThinking = (orMsg?.reasoning || orMsg?.reasoning_content || '').trim();
        if (orThinking) onThought?.(orThinking);
        return orMsg?.content?.trim() || 'Réponse vide.';
    }

    // A2. OmniRoute — gateway locale OpenAI-compatible (même contrat que le harness)
    if (provider === 'omniroute') {
        const key = providerEnv('omniroute','OMNIROUTE_API_KEY');
        const res = await fetch(`${omnirouteBase()}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify({ model, messages: chatMessages, max_tokens: 8192, stream: !!onChunk }),
            signal: abortSignal,
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`OmniRoute HTTP ${res.status}: ${errBody}`);
        }
        if (onChunk && res.body) {
            return await readSseStream(res.body, onChunk, onThought);
        }
        const json = (await res.json()) as any;
        const omniMsg = json.choices?.[0]?.message;
        const omniThinking = (omniMsg?.reasoning || omniMsg?.reasoning_content || '').trim();
        if (omniThinking) onThought?.(omniThinking);
        return omniMsg?.content?.trim() || 'Réponse vide.';
    }

    // A3. HuggingFace — router OpenAI-compatible officiel, direct.
    if (provider === 'huggingface') {
        const hfKey = providerEnv('huggingface','HF_TOKEN') || providerEnv('huggingface','HUGGINGFACE_API_KEY');
        if (!hfKey) {
            throw new Error('HF_TOKEN absent de l\'environnement.');
        }
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${hfKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, messages: chatMessages, stream: !!onChunk }),
            signal: abortSignal,
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`HuggingFace HTTP ${res.status}: ${errBody}`);
        }
        if (onChunk && res.body) {
            return await readSseStream(res.body, onChunk, onThought);
        }
        const json = (await res.json()) as any;
        const hfMsg = json.choices?.[0]?.message;
        const hfThinking = (hfMsg?.reasoning_content || hfMsg?.reasoning || '').trim();
        if (hfThinking) onThought?.(hfThinking);
        return hfMsg?.content?.trim() || 'Réponse vide.';
    }

    // B. Ollama local ou Ollama Cloud
    if (provider === 'ollama' || provider === 'ollama-cloud') {
        const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const res = await fetch(`${host}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: chatMessages,
                stream: !!onChunk,
            }),
            signal: abortSignal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
        }

        if (onChunk && res.body) {
            return await readNdjsonStream(res.body, onChunk, onThought);
        }

        const json = (await res.json()) as any;
        const ollThinking = (json.message?.thinking || '').trim();
        if (ollThinking) onThought?.(ollThinking);
        return json.message?.content?.trim() || 'Réponse vide.';
    }

    // C. NVIDIA NIM — API officielle directe, séparation stricte des comptes :
    // nim → NVIDIA_API_KEY, nim2 → NVIDIA_API_KEY_2, jamais de fallback croisé.
    if (provider === 'nim' || provider === 'nim2') {
        const primaryKey = provider === 'nim2'
            ? providerEnv('nim2','NVIDIA_API_KEY_2')
            : providerEnv('nim','NVIDIA_API_KEY');
        const fallbackKey = undefined;

        const keysToTry = [primaryKey, fallbackKey].filter((k): k is string => !!k);

        if (keysToTry.length > 0) {
            let lastErr = '';
            for (const key of keysToTry) {
                try {
                    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${key}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            model,
                            messages: chatMessages,
                            max_tokens: 4096,
                            stream: !!onChunk,
                        }),
                        signal: abortSignal,
                    });

                    if (!res.ok) {
                        const err = await res.text().catch(() => '');
                        lastErr = `HTTP ${res.status}: ${err}`;
                        if (res.status === 429 || res.status === 401) {
                            continue; // Tenter la deuxième clé NIM
                        }
                        throw new Error(`NVIDIA NIM ${lastErr}`);
                    }

                    if (onChunk && res.body) {
                        return await readSseStream(res.body, onChunk, onThought);
                    }

                    const json = (await res.json()) as any;
                    const choice = json.choices?.[0]?.message;
                    const nimThinking = (choice?.reasoning_content || choice?.reasoning || '').trim();
                    if (nimThinking) onThought?.(nimThinking);
                    return choice?.content?.trim() || 'Réponse vide.';
                } catch (e: any) {
                    lastErr = e?.message || String(e);
                    if (abortSignal.aborted || e?.name === 'AbortError') throw e;
                }
            }
            if (lastErr) {
                throw new Error(`NVIDIA NIM : ${lastErr}`);
            }
        }

        // Fallback REST Daemon
        const lastUser = messages.filter((m) => m.role === 'user').pop()?.text || '';
        const body = await rest('nim_chat_model', {
            model,
            prompt: lastUser,
            system,
            account: provider === 'nim2' ? 2 : 1,
            max_tokens: 2048,
        });
        const content = body?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('Le modèle NIM n\'a rien renvoyé.');
        }
        return content.trim();
    }

    // D. Agents ACP (Kilo, Hermes, etc.)
    throw new Error(`Le fournisseur "${provider}" est une CLI/agent ACP externe. Utilise Kilo ou Hermes directement dans le terminal, ou sélectionne Ollama / OpenRouter pour dialoguer en direct ici.`);
}

async function readSseStream(
    body: ReadableStream<Uint8Array>,
    onChunk: (token: string) => void,
    onThought?: (accumulated: string) => void,
): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let thinking = '';
    let buffer = '';
    let streamError = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (trimmed.startsWith('data: ')) {
                try {
                    const parsed = JSON.parse(trimmed.slice(6));
                    if (parsed?.error) {
                        streamError = typeof parsed.error === 'string'
                            ? parsed.error
                            : parsed.error.message || JSON.stringify(parsed.error);
                        continue;
                    }
                    const delta = parsed.choices?.[0]?.delta;
                    const thinkTok = (typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '')
                                   || (typeof delta?.reasoning === 'string' ? delta.reasoning : '');
                    if (thinkTok) {
                        thinking += thinkTok;
                        onThought?.(thinking);
                    }
                    const token = typeof delta?.content === 'string' ? delta.content : '';
                    if (token) {
                        full += token;
                        onChunk(full);
                    }
                } catch {
                    /* ignore keepalive */
                }
            }
        }
    }

    if (streamError && !full) {
        throw new Error(streamError);
    }
    if (!full.trim()) {
        throw new Error(thinking.trim()
            ? 'Le modèle a épuisé son budget de tokens en raisonnement sans produire de réponse (augmente max_tokens).'
            : 'Le fournisseur a clos le flux sans envoyer de réponse.');
    }
    return full.trim();
}

async function readNdjsonStream(
    body: ReadableStream<Uint8Array>,
    onChunk: (token: string) => void,
    onThought?: (accumulated: string) => void,
): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let thinking = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed?.error) {
                    throw new Error(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
                }
                const thinkTok = typeof parsed.message?.thinking === 'string' ? parsed.message.thinking : '';
                if (thinkTok) {
                    thinking += thinkTok;
                    onThought?.(thinking);
                }
                const token = (typeof parsed.message?.content === 'string' ? parsed.message.content : '')
                           || (typeof parsed.response === 'string' ? parsed.response : '');
                if (token) {
                    full += token;
                    onChunk(full);
                }
            } catch (e: any) {
                if (e instanceof SyntaxError) continue;
                throw e;
            }
        }
    }
    if (!full.trim()) {
        throw new Error('Ollama a clos le flux sans envoyer de réponse.');
    }
    return full.trim();
}

/** Dernier snapshot providers de l'orchestrateur — alimenté par extension.ts. */
let remoteProviders: Record<string, boolean> = {};

export function setRemoteProviders(p: Record<string, boolean> | undefined): void {
    remoteProviders = p || {};
}

/** Noms provider_prefs (orchestrateur) ↔ ids ACP de l'extension. */
const ORCH_PROVIDER_NAME: Record<string, string> = {
    nim: 'nvidia-nim',
    nim2: 'nvidia-nim2',
    openrouter: 'openrouter-free',
    omniroute: 'omniroute-local',
    kilo: 'kilo-free',
    hermes: 'hermes-free',
    'antigravity-acp': 'antigravity-subscription',
    'devin-cli': 'devin-subscription',
};

export function loadProviderFlags(
    context: vscode.ExtensionContext,
    liveBridgeProviders?: Record<string, boolean>,
): AcpProvider[] {
    void context;
    const remote = liveBridgeProviders || remoteProviders;
    return ACP_PROVIDERS.map((provider) => ({
        ...provider,
        // provider_prefs (orchestrateur-monitor) est la seule source de
        // vérité — l'extension ne fait plus que la lire.
        enabled: remote[ORCH_PROVIDER_NAME[provider.id] ?? provider.id]
            ?? remote[provider.id]
            ?? devinAgentEnabled(provider.id)
            ?? false,
    }));
}
