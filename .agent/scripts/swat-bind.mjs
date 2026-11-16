// swat-bind.mjs — attribution dynamique des Bleubites a un schema SWAT.
// Usage : node .agent/scripts/swat-bind.mjs --name swat-obsidian [--dry] [--no-load]
// Le schema stocke des ROLES ; ce script resout les workers chat-* vers le pool
// de sessions reellement ouvertes, en diversifiant les providers selon la chaine
// provider_prefs de l'orchestrateur (orchestrator.db, lecture seule).
// Les Bleubites choisis sont demasques dans le roster, le schema est patch en
// place (meme id, zero duplication) puis active.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMAS_FILE = process.env.HPHE_SCHEMAS_FILE
    || path.join(os.homedir(), '.hephaistos-workflow-schemas.json');
const ROSTER = path.join(ROOT, '.agent', 'workspace-roster.json');
const SESSIONS = path.join(ROOT, '.agent', 'chats', 'sessions.json');
const STATE = path.join(ROOT, '.agent', 'state', 'swat-bind.json');
const CATALOG_CACHE = path.join(ROOT, '.agent', 'state', 'model-catalog.json');
const ORCH_DB = process.env.HPHE_ORCH_DB
    || 'C:\\Program Files\\servers\\hephaistos2-kit\\data\\orchestrator.db';
const MCP_CALL = process.env.HPHE_MCP_CALL
    || path.join(os.homedir(), '.config', 'devin', 'scripts', 'mcp-call.mjs');
const MCP_SERVER = process.env.HPHE_MCP_SERVER || 'Hephaistos-everything-search';
const CATALOG_TTL_MS = Number(process.env.SWAT_BIND_CATALOG_TTL_MS || 300_000);

const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes('--dry');
const NO_LOAD = process.argv.includes('--no-load');
const schemaKey = arg('id') || arg('name');
if (!schemaKey) {
    console.error('usage: swat-bind.mjs --name <schema> | --id <schema-id> [--dry] [--no-load]');
    process.exit(2);
}

const fail = (msg) => { console.error(JSON.stringify({ ok: false, error: msg })); process.exit(1); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// provider_prefs -> providerId roster (noms de la table -> ids de session)
const PREF_TO_PROVIDER = {
    'nvidia-nim': 'nim', 'nvidia-nim2': 'nim2', 'ollama-cloud': 'ollama-cloud',
    'antigravity-subscription': 'antigravity-acp', 'mistral-vibe': 'mistral-vibe',
    'kilo-free': 'kilo', 'hermes-free': 'hermes', 'openrouter-free': 'openrouter',
    'kilocode': 'kilo', 'ollama': 'ollama', 'devin-cloud': 'devin-cloud',
};

// providerId roster -> cle du catalogue `available_models` (hphe-mcp,
// ex-model-discovery). Les modeles sont attribues A L USAGE depuis ce
// catalogue live, jamais en dur : une session ne fournit qu'une identite.
const PROVIDER_CATALOG = {
    nim: 'nvidia-nim', nim2: 'nvidia-nim2',
    ollama: 'ollama', 'ollama-cloud': 'ollama-cloud',
    openrouter: 'openrouter-free',
    omniroute: 'omniroute',
    groq: 'groq',
};

// OmniRoute est un meta-routeur local (:20128) — son catalogue vient de
// GET /v1/models, PAS de hphe-mcp. Ses prefixes de canal designent l'upstream:
// il faut preferer les canaux GRATUITS (groq, ollamacloud, pollinations, cf,
// huggingface, openrouter :free...) — les canaux BYOK (gemini/, mistral/,
// ddgw/...) retournent API_KEY_INVALID quand la clef amont est absente, et
// les alias auto/* retombent souvent sur du BYOK.
// Canaux omniroute verifies en live (2026-11-16) : groq/cf/ddgw repondent ;
// pol/pollinations/ollamacloud -> 401 (clefs upstream absentes) ; huggingchat
// -> 502 ; auto/* et gemini//mistral/ -> BYOK API_KEY_INVALID.
const OMNI_CHANNEL_RANK = [
    'groq/', 'cf/', 'cloudflare-ai/', 'ddgw/',
    'hf/', 'huggingface/', 'ollamacloud/', 'ollama-cloud/',
    'pol/', 'pollinations/', 'huggingchat/',
];
const OMNI_FREE_SUFFIX = /:free(@.*)?$/;
const OMNI_BAD = /^auto\/|^aihorde\/|^veo|^gemini\/|^mistral\/|^unc\//;

// Modeles non-dialogue exclus de l'attribution (embed, garde-fous, OCR...).
const NON_CHAT = /embed|safety|guard|nvclip|riva|translate|detector|calibration|retriever|arctic|ocr|nomic|mxbai|bge|whisper|transcribe|image|video|vision/i;

// Ordre de preference par catalogue : modeles chat eprouves d'abord, puis le
// reste du catalogue filtre. La rotation utilise cette liste ordonnee.
const MODEL_PREF = {
    'nvidia-nim': [
        'nvidia/nemotron-3.5-lightning-30b-a3b',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia/nemotron-3.5-bolt-e4b',
        'nvidia/nemotron-3.5-super-vl-120b-a12b',
        'deepseek-ai/deepseek-v4.1-flash',
        'openai/gpt-oss-20b',
        'z-ai/glm-5.3-flash',
        'minimaxai/minimax-m3.1-flash',
        'google/gemma-4-31b-it',
        'mistralai/mistral-large-4-1t-a52b',
        'meta/muse-glimmer-30b',
        'stepfun-ai/step-5-preview',
        'poolside/laguna-xs-2.1',
        'bigcode/starcoder2-15b',
        'google/gemma-3-12b-it',
    ],
    'openrouter-free': [
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3.5-lightning:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        'nvidia/nemotron-3.5-super-vl:free',
        'cohere/north-mini-code:free',
        'google/gemma-4-31b-it:free',
        'google/gemma-4-26b-a4b-it:free',
        'inclusionai/ling-3.2-flash:free',
        'baidu/ernie-5.5-flash-preview:free',
    ],
    'ollama-cloud': [
        'gpt-oss:120b-cloud',
        'nemotron-3-ultra:cloud',
        'gpt-oss:20b-cloud',
        'nemotron-3-nano:30b-cloud',
        'gemma4:31b-cloud',
    ],
    'ollama': [
        'qwen3.5:9b', 'deepseek-r1:8b', 'mistral:7b', 'qwen3:4b',
        'gemma3:4b', 'qwen3.5:4b', 'llama3.2:latest', 'qwen3:1.7b',
    ],
    'groq': [
        'openai/gpt-oss-120b',
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-20b',
        'allam-2-7b',
    ],
};
MODEL_PREF['nvidia-nim2'] = MODEL_PREF['nvidia-nim'];

// Lit OMNIROUTE_* depuis .env (meme convention que providerEnv d'acp-server).
function envVar(name) {
    if (process.env[name]) return process.env[name];
    try {
        for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
            const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
            if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* pas de .env */ }
    return undefined;
}

// Catalogue live via hphe-mcp (mcp-call.mjs stdio, cache disque TTL),
// complete par le catalogue OmniRoute local GET /v1/models.
function fetchCatalog() {
    try {
        const c = readJson(CATALOG_CACHE);
        if (Date.now() - Date.parse(c.at || 0) < CATALOG_TTL_MS && c.catalog) return { catalog: c.catalog, src: 'cache' };
    } catch { /* pas de cache exploitable */ }
    let catalog = null;
    try {
        const out = execFileSync(process.execPath,
            [MCP_CALL, MCP_SERVER, 'available_models', '{}'],
            { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
        catalog = JSON.parse(out).providers || null;
    } catch { /* hphe-mcp indispo */ }
    try {
        const base = (envVar('OMNIROUTE_BASE_URL') || 'http://localhost:20128/v1').replace(/\/$/, '');
        const key = envVar('OMNIROUTE_API_KEY');
        const args = ['-s', '--max-time', '15', `${base}/models`];
        if (key) args.push('-H', `Authorization: Bearer ${key}`);
        const out = execFileSync('curl', args, { encoding: 'utf8', windowsHide: true });
        const ids = (JSON.parse(out).data || []).map((m) => m.id).filter(Boolean);
        if (ids.length) {
            if (!catalog) catalog = {};
            catalog.omniroute = ids;
        }
    } catch { /* omniroute indispo */ }
    try {
        const key = envVar('GROQ_API_KEY');
        if (key) {
            const out = execFileSync('curl',
                ['-s', '--max-time', '15', 'https://api.groq.com/openai/v1/models',
                 '-H', `Authorization: Bearer ${key}`],
                { encoding: 'utf8', windowsHide: true });
            const ids = (JSON.parse(out).data || []).map((m) => m.id).filter(Boolean);
            if (ids.length) {
                if (!catalog) catalog = {};
                catalog.groq = ids;
            }
        }
    } catch { /* groq indispo */ }
    if (catalog) {
        fs.mkdirSync(path.dirname(CATALOG_CACHE), { recursive: true });
        fs.writeFileSync(CATALOG_CACHE, JSON.stringify({ at: new Date().toISOString(), catalog }, null, 2));
        return { catalog, src: 'live' };
    }
    try {
        const c = readJson(CATALOG_CACHE);
        if (c.catalog) return { catalog: c.catalog, src: 'stale-cache' };
    } catch { /* rien */ }
    return { catalog: null, src: 'unavailable' };
}

// Liste ordonnee des modeles dialogue disponibles pour une cle de catalogue.
function chatModels(catKey, catalog) {
    const avail = (catalog?.[catKey] || []);
    if (catKey === 'omniroute') {
        const rank = (id) => {
            const i = OMNI_CHANNEL_RANK.findIndex((p) => id.startsWith(p));
            if (i >= 0) return i;
            if (id.startsWith('openrouter/') && OMNI_FREE_SUFFIX.test(id)) return OMNI_CHANNEL_RANK.length;
            if (OMNI_BAD.test(id) || NON_CHAT.test(id)) return 99;
            return OMNI_CHANNEL_RANK.length + 1;
        };
        return avail.filter((id) => rank(id) < 99).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    }
    const pref = MODEL_PREF[catKey] || [];
    return [
        ...pref.filter((m) => avail.includes(m)),
        ...avail.filter((m) => !pref.includes(m) && !NON_CHAT.test(m)),
    ];
}

// 1. Chaine provider canonique : position croissante, actives seulement,
//    puis actives sans position (ordre d apparition).
function providerChain() {
    try {
        const out = execFileSync('sqlite3',
            [ORCH_DB, 'SELECT provider, enabled, position FROM provider_prefs ORDER BY position;'],
            { encoding: 'utf8', windowsHide: true });
        const rows = out.trim().split('\n').filter(Boolean).map((l) => {
            const [provider, enabled, position] = l.split('|');
            return { provider, enabled: enabled === '1', position: position === '' ? null : Number(position) };
        });
        const positioned = rows.filter((r) => r.enabled && r.position !== null).sort((a, b) => a.position - b.position);
        const unpositioned = rows.filter((r) => r.enabled && r.position === null);
        return [...new Set([...positioned, ...unpositioned].map((r) => PREF_TO_PROVIDER[r.provider] || r.provider))];
    } catch { return []; }
}

// 2. Schema cible dans la banque (meme workspace)
const store = readJson(SCHEMAS_FILE);
const list = Array.isArray(store.schemas) ? store.schemas : [];
const workspace = path.resolve(ROOT);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const entry = list.find((s) => s.id === schemaKey)
    || list.find((s) => norm(s.name) === norm(schemaKey) && path.resolve(s.workspace) === workspace);
if (!entry) fail(`schema introuvable : ${schemaKey}`);
const graph = entry.graph;
if (!graph?.nodes?.length) fail('schema sans noeuds');
const entryId = graph.entrySessionId;
const workers = graph.nodes.filter((n) => n.sessionId !== entryId);
if (!workers.length) fail('schema sans noeud worker');

// 3. Pool : membres bleubites chat-* dont la session est ouverte et concordante.
//    hidden est IGNORE ici : le bind demasque les elus (attribution a l usage).
//    DRIVABLE = providers que acp-server sait piloter (devin-cli, antigravity-acp
//    exclus : non pilotables / sessions ACP sans toolset fs_* Bleubite).
const DRIVABLE = new Set((process.env.SWAT_BIND_PROVIDERS || 'nim,nim2,omniroute,ollama,openrouter,groq').split(','));
const roster = readJson(ROSTER);
const members = Object.values(roster.core || {}).flat()
    .filter((m) => String(m.sessionId || '').startsWith('chat-') && DRIVABLE.has(m.providerId));
const rawSessions = readJson(SESSIONS);
const sessionList = Array.isArray(rawSessions) ? rawSessions : rawSessions.sessions;
const openSessions = new Map(sessionList.map((s) => [s.id || s.sessionId, s]));
const pool = members.filter((m) => {
    const s = openSessions.get(m.sessionId);
    return s && s.provider === m.providerId && (!m.model || s.model === m.model);
});
if (pool.length < workers.length) {
    fail(`pool insuffisant : ${pool.length} bleubite(s) eligible(s) pour ${workers.length} roles.`);
}
const byProvider = new Map();
for (const m of pool) {
    if (!byProvider.has(m.providerId)) byProvider.set(m.providerId, []);
    byProvider.get(m.providerId).push(m);
}
// Catalogue live des modeles (hphe-mcp available_models / ex-model-discovery).
const { catalog, src: catalogSrc } = fetchCatalog();

// Depriorise les modeles hors catalogue live (opencode/*, noms mutiles,
// modeles retires) : reparables a l attribution mais evites quand un pair sain
// existe deja. Sans catalogue, depriorise juste 'opencode/' (comportement
// historique, couples provider+modele observes en echec systematique).
const modelOf = (m) => m.model || openSessions.get(m.sessionId)?.model || '';
const health = (m) => {
    const catKey = PROVIDER_CATALOG[m.providerId];
    if (catKey && catalog?.[catKey]) {
        return chatModels(catKey, catalog).includes(modelOf(m)) ? 0 : 1;
    }
    return /^opencode\//.test(modelOf(m)) ? 1 : 0;
};
for (const arr of byProvider.values()) {
    arr.sort((a, b) => health(a) - health(b) || a.sessionId.localeCompare(b.sessionId));
}

// 4. Ordre des providers : chaine orchestrateur, puis les autres par taille de pool.
const chain = providerChain();
const orderedProviders = [
    ...chain.filter((p) => byProvider.has(p)),
    ...[...byProvider.keys()].filter((p) => !chain.includes(p))
        .sort((a, b) => byProvider.get(b).length - byProvider.get(a).length),
];

// 5. Rotation persistee : un offset global + curseur par provider + curseur
//    de modele par catalogue (rotation des modeles attribues a l usage).
//    SWAT_BIND_ROTATE_MODELS=1 force la rotation meme sur un modele valide.
let state = { offset: 0, cursors: {}, modelCursors: {} };
try { state = { ...state, modelCursors: {}, ...readJson(STATE) }; } catch { /* premier run */ }
const ROTATE_MODELS = !!process.env.SWAT_BIND_ROTATE_MODELS;
const usedSessions = new Set();
const resolveModel = (m) => {
    const catKey = PROVIDER_CATALOG[m.providerId];
    if (!catKey) return { model: modelOf(m), fixed: false };
    const models = chatModels(catKey, catalog);
    if (!models.length) return { model: modelOf(m), fixed: false };
    const cur = modelOf(m);
    if (!ROTATE_MODELS && models.includes(cur)) return { model: cur, fixed: false };
    const idx = (state.modelCursors[catKey] || 0) % models.length;
    state.modelCursors[catKey] = (state.modelCursors[catKey] || 0) + 1;
    return { model: models[idx], fixed: models[idx] !== cur };
};
const bindings = workers.map((node, i) => {
    for (let k = 0; k < orderedProviders.length; k++) {
        const p = orderedProviders[(state.offset + i + k) % orderedProviders.length];
        const free = byProvider.get(p).filter((m) => !usedSessions.has(m.sessionId));
        // Prefere les modeles sains ; un modele hors catalogue ne disqualifie
        // pas la session (le bind le reaffecte depuis le catalogue live).
        const healthy = free.filter((m) => !health(m));
        const usable = healthy.length ? healthy : free;
        if (!usable.length) continue;
        const cur = (state.cursors[p] || 0) % usable.length;
        const m = usable[cur];
        state.cursors[p] = (state.cursors[p] || 0) + 1;
        usedSessions.add(m.sessionId);
        const { model, fixed } = resolveModel(m);
        return { role: node.role, from: node.sessionId, to: m.sessionId, provider: m.providerId, model, modelFixed: fixed };
    }
    return null;
});
if (bindings.some((b) => !b)) fail('aucun bleubite libre pour au moins un role.');

// 6. Patch : sessionIds des noeuds + remap des edges + demasquage des elus.
const remap = new Map(bindings.map((b) => [b.from, b.to]));
for (const node of graph.nodes) {
    if (remap.has(node.sessionId)) node.sessionId = remap.get(node.sessionId);
}
for (const edge of graph.edges || []) {
    if (remap.has(edge.source)) edge.source = remap.get(edge.source);
    if (remap.has(edge.target)) edge.target = remap.get(edge.target);
}
const chosen = new Set(bindings.map((b) => b.to));
for (const m of Object.values(roster.core || {}).flat()) {
    if (chosen.has(m.sessionId)) m.hidden = false;
}

// Attribution du modele a l usage : le modèle choisi (catalogue live) est
// reinjecte dans la session ET le membre roster — le runner croise les deux.
for (const b of bindings) {
    const s = openSessions.get(b.to);
    if (s && s.model !== b.model) s.model = b.model;
    for (const m of Object.values(roster.core || {}).flat()) {
        if (m.sessionId === b.to && m.model !== b.model) m.model = b.model;
    }
}

if (!DRY) {
    entry.savedAt = new Date().toISOString();
    fs.writeFileSync(SCHEMAS_FILE, JSON.stringify({ schemas: list }, null, 2));
    fs.writeFileSync(ROSTER, JSON.stringify(roster, null, 2));
    fs.writeFileSync(SESSIONS, JSON.stringify(rawSessions, null, 2));
    state.offset += workers.length;
    state.last = bindings;
    state.at = entry.savedAt;
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    if (!NO_LOAD) {
        const out = execFileSync(process.execPath,
            [path.join(ROOT, '.agent', 'agent-bridge', 'workspace-roster.js'), 'schema', 'load', entry.id],
            { cwd: ROOT, encoding: 'utf8' });
        var loaded = JSON.parse(out);
    }
}

console.log(JSON.stringify({
    ok: true, dry: DRY, schema: entry.name, schemaId: entry.id,
    chain: orderedProviders, pool: pool.length, catalog: catalogSrc, bindings,
    activated: !DRY && !NO_LOAD ? (loaded ? graph.name : false) : 'skipped',
}, null, 1));
