// Orchestrator WS Bridge — poll orchestrator.db (read-only) and broadcast snapshots.
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DB_PATH = process.env.ORCHESTRATOR_DB
    || 'C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db';
const WS_PORT = Number(process.env.ORCH_MONITOR_PORT || 7477);
const POLL_INTERVAL = Number(process.env.ORCH_MONITOR_POLL_MS || 2000);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
console.log(`[bridge] connected to ${DB_PATH} (read-only)`);

// Bus comms inter-agents : .agent/comms.jsonl à la racine du workspace
// (agy-hub, monitor, scripts y appendent ; on tail et on broadcast).
// Résolution : COMMS_LOG > HEPHAISTOS_WORKSPACE (passé par l'extension) >
// cwd si elle contient .agent/ > fallback layout repo.
// Multi-workspaces : plusieurs sessions écrivent chacune dans leur propre
// .agent/comms.jsonl — le feed doit les FUSIONNER, sinon il n'affiche que le
// workspace courant et paraît désynchronisé de la réalité.
function resolveCommsPaths() {
    if (process.env.COMMS_LOG) return [process.env.COMMS_LOG];
    const dirs = [
        process.env.HEPHAISTOS_WORKSPACE,
        process.cwd(),
        path.join(__dirname, '..', '..', '..'), // layout repo : ws-bridge → racine
        'F:/Promgramation-teste/Thot-Agents',   // workspace frère connu
        'F:/Promgramation-teste/Hephaistos-Kit',
        'C:/Users/Administrator/Desktop/Sysinternals Suite',
    ].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const dir of dirs) {
        const norm = path.resolve(dir);
        if (seen.has(norm)) continue;
        seen.add(norm);
        const p = path.join(norm, '.agent', 'comms.jsonl');
        if (fs.existsSync(p)) out.push(p);
    }
    if (out.length === 0 && dirs[0]) out.push(path.join(dirs[0], '.agent', 'comms.jsonl'));
    return out;
}
const COMMS_PATHS = resolveCommsPaths();
const commsOffsets = new Map(); // path -> offset

function parseLines(lines) {
    return lines.filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

function readCommsTail(n = 100) {
    const all = [];
    for (const p of COMMS_PATHS) {
        try {
            all.push(...parseLines(fs.readFileSync(p, 'utf8').split('\n')));
        } catch { /* absent */ }
    }
    // merge trié par ts, dédup ts+text
    const seen = new Set();
    return all
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .filter((e) => {
            const k = String(e.ts) + '|' + String(e.text);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .slice(-n);
}

function readCommsFrom(p, offset) {
    try {
        const st = fs.statSync(p);
        let truncated = false;
        if (offset > st.size) { offset = 0; truncated = true; }
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        return { entries: parseLines(buf.toString('utf8').split('\n')), offset: st.size, truncated };
    } catch { return { entries: [], offset: 0, truncated: (commsOffsets.get(p) || 0) > 0 }; }
}
// Prime les offsets pour ne broadcaster que les NOUVELLES entrées
for (const p of COMMS_PATHS) {
    try { commsOffsets.set(p, fs.statSync(p).size); } catch { commsOffsets.set(p, 0); }
}

// Table des toggles provider (créée en écriture, lue partout) :
// enabled = on/off, position = ordre de priorité (drag & drop UI)
try {
    const wdb = new Database(DB_PATH);
    wdb.exec('CREATE TABLE IF NOT EXISTS provider_prefs (provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)');
    try { wdb.exec('ALTER TABLE provider_prefs ADD COLUMN position INTEGER'); } catch { /* colonne déjà là */ }
    // ollama local : réservé à l'utilisateur par défaut → seed OFF
    wdb.prepare("INSERT OR IGNORE INTO provider_prefs (provider, enabled) VALUES ('ollama', 0)").run();
    wdb.close();
} catch (e) { console.error('[bridge] provider_prefs init:', e.message); }

function readProviderPrefs() {
    const prefs = {};
    try {
        for (const r of db.prepare('SELECT provider, enabled FROM provider_prefs').all()) {
            prefs[r.provider] = !!r.enabled;
        }
    } catch { /* table absente → tout ON */ }
    return prefs;
}

function readProviderOrder() {
    try {
        return db.prepare('SELECT provider FROM provider_prefs WHERE position IS NOT NULL ORDER BY position').all()
            .map(r => r.provider);
    } catch { return []; }
}

// Santé modèles : dernier état connu par (provider, model) — table alimentée
// par les pings model-discovery ET par la sonde locale ci-dessous.
function readModelHealth() {
    try {
        return db.prepare(
            `SELECT supplier, provider, model, available, latency_ms, checked_at
             FROM model_health
             WHERE id IN (SELECT MAX(id) FROM model_health GROUP BY provider, model)
             ORDER BY checked_at DESC`
        ).all();
    } catch { return []; }
}

// --- Sonde de modèles : même recette que ping-model du MCP model-discovery
// (POST /chat/completions, max_tokens=1). Round-robin : un modèle par tick,
// cibles = modèles vus dans les tâches récentes (pending/in_progress/failed).
const PING_MS = Number(process.env.ORCH_MODEL_PING_MS || 15000);
const PROVIDER_TO_SUPPLIER = {
    'nvidia-nim': 'nim', 'nvidia-nim2': 'nim2',
    'openrouter': 'openrouter', 'openrouter-free': 'openrouter-free',
    'kilo': 'kilo', 'kilo-free': 'kilo', 'nous': 'nous', 'hermes-free': 'nous',
    'ollama': 'ollama', 'ollama-cloud': 'ollama',
};
const PING_ENDPOINTS = {
    nim: () => ({ url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, key: process.env.NVIDIA_API_KEY }),
    nim2: () => ({ url: `${process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'}/chat/completions`, key: process.env.NVIDIA_API_KEY_2 }),
    openrouter: () => ({ url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY }),
    'openrouter-free': () => ({ url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY }),
    kilo: () => ({ url: 'https://api.kilo.ai/api/gateway/chat/completions', key: process.env.KILO_API_KEY }),
    nous: () => {
        try {
            const p = `${process.env.LOCALAPPDATA || ''}/hermes/auth.json`;
            const tok = JSON.parse(fs.readFileSync(p, 'utf-8'))?.providers?.nous?.access_token;
            if (!tok) return null;
            return { url: 'https://inference-api.nousresearch.com/v1/chat/completions', key: tok };
        } catch { return null; }
    },
    ollama: () => ({ url: 'http://localhost:11434/v1/chat/completions' }),
};

// Catalogues free par provider — rechargés toutes les 30 min. Le ping doit
// couvrir CHAQUE modèle free détaillé (pas seulement le routeur) : quand un
// modèle spécifique répond bien, pickModel le préfère au routeur free.
const FREE_CATALOGS = [
    { supplier: 'openrouter-free', url: 'https://openrouter.ai/api/v1/models', key: () => process.env.OPENROUTER_API_KEY, free: (id) => id.endsWith(':free') || id === 'openrouter/free' },
    { supplier: 'kilo', url: 'https://api.kilo.ai/api/gateway/models', key: () => process.env.KILO_API_KEY, free: (id) => id.includes('free') },
    { supplier: 'nous', url: 'https://inference-api.nousresearch.com/v1/models', key: () => PING_ENDPOINTS.nous()?.key, free: (id) => id.includes(':free') },
];
let freeTargets = [];
let freeTargetsAt = 0;
function fetchJsonArr(url, key, cb) {
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { timeout: 10000, headers: key ? { Authorization: `Bearer ${key}` } : {} }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { cb(JSON.parse(buf)); } catch { cb(null); } });
    }).on('error', () => cb(null)).on('timeout', function () { this.destroy(); cb(null); });
}
function refreshFreeTargets() {
    for (const cat of FREE_CATALOGS) {
        fetchJsonArr(cat.url, cat.key(), (data) => {
            if (!data?.data) return;
            const models = data.data
                .map((m) => m.id)
                .filter((id) => typeof id === 'string' && cat.free(id))
                .map((model) => ({ supplier: cat.supplier, model }));
            freeTargets = freeTargets.filter((t) => t.supplier !== cat.supplier).concat(models);
        });
    }
    freeTargetsAt = Date.now();
}
refreshFreeTargets();
setInterval(refreshFreeTargets, 30 * 60e3);

function pingTargets() {
    let taskModels = [];
    try {
        taskModels = db.prepare(
            `SELECT DISTINCT provider, model FROM tasks_todo
             WHERE model IS NOT NULL AND model != ''
               AND status IN ('pending','in_progress','failed')
             ORDER BY id DESC LIMIT 20`
        ).all()
            .map((r) => ({ supplier: PROVIDER_TO_SUPPLIER[r.provider], model: r.model }))
            .filter((t) => t.supplier && t.model);
    } catch { /* */ }
    const seen = new Set(taskModels.map((t) => `${t.supplier}|${t.model}`));
    return taskModels.concat(freeTargets.filter((t) => !seen.has(`${t.supplier}|${t.model}`)));
}

let pingIdx = 0;
let pingInFlight = false;
function pingNextModel() {
    if (pingInFlight) return;
    const targets = pingTargets();
    if (!targets.length) return;
    const t = targets[pingIdx++ % targets.length];
    const ep = PING_ENDPOINTS[t.supplier] && PING_ENDPOINTS[t.supplier]();
    if (!ep || ep.error) return;
    pingInFlight = true;
    const started = Date.now();
    const body = JSON.stringify({ model: t.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });
    const transport = ep.url.startsWith('https') ? https : http;
    const req = transport.request(ep.url, {
        method: 'POST',
        timeout: 20000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
        },
    }, (res) => {
        res.resume();
        res.on('end', () => recordPing(t, res.statusCode >= 200 && res.statusCode < 300, Date.now() - started));
    });
    req.on('timeout', () => { req.destroy(); recordPing(t, false, Date.now() - started); });
    req.on('error', () => recordPing(t, false, Date.now() - started));
    req.end(body);
}
const SUPPLIER_TO_PROVIDER = {
    nim: 'nvidia-nim', nim2: 'nvidia-nim2',
    'openrouter-free': 'openrouter-free', openrouter: 'openrouter-free',
    kilo: 'kilo-free', nous: 'hermes-free', ollama: 'ollama',
};
function recordPing(t, ok, latency) {
    pingInFlight = false;
    try {
        const wdb = new Database(DB_PATH);
        wdb.prepare('INSERT INTO model_health (supplier, provider, model, available, latency_ms) VALUES (?,?,?,?,?)')
            .run(t.supplier, SUPPLIER_TO_PROVIDER[t.supplier] || t.supplier, t.model, ok ? 1 : 0, latency);
        wdb.close();
    } catch (e) { console.error('[bridge] ping write:', e.message); }
}
if (PING_MS > 0) setInterval(pingNextModel, PING_MS);

const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`[bridge] websocket listening on ws://127.0.0.1:${WS_PORT}`);

const lastTaskHash = new Map(); // task id -> hash of serialized row
let lastAgentHash = '';
let lastHealthHash = '';

function readTasks() {
    return db.prepare(
        `SELECT id, title, description, priority, status, due_date, created_at,
                dependencies, assigned_to, result, task_type, model, provider, dispatcher
         FROM tasks_todo ORDER BY id DESC`
    ).all();
}

function readAgents() {
    return db.prepare(
        `SELECT id, agent_name, agent_type, config, active FROM agents ORDER BY id`
    ).all();
}

function snapshot() {
    return {
        type: 'snapshot',
        tasks: readTasks(),
        agents: readAgents(),
        providers: readProviderPrefs(),
        provider_order: readProviderOrder(),
        model_health: readModelHealth(),
        comms: readCommsTail(100),
        ts: new Date().toISOString()
    };
}

function broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(raw);
    }
}

function poll() {
    try {
        const tasks = readTasks();
        const now = new Date().toISOString();

        for (const task of tasks) {
            const h = JSON.stringify(task);
            if (lastTaskHash.get(task.id) !== h) {
                lastTaskHash.set(task.id, h);
                broadcast({ type: 'task_update', task, ts: now });
            }
        }
        // deleted tasks
        const ids = new Set(tasks.map(t => t.id));
        for (const id of [...lastTaskHash.keys()]) {
            if (!ids.has(id)) lastTaskHash.delete(id);
        }

        const agents = readAgents();
        const ah = JSON.stringify(agents);
        if (ah !== lastAgentHash) {
            lastAgentHash = ah;
            broadcast({ type: 'snapshot', tasks, agents, providers: readProviderPrefs(), provider_order: readProviderOrder(), ts: now });
        }

        // Santé modèles : broadcast quand la table bouge (pings discovery ou sonde locale)
        const mh = readModelHealth();
        const mhHash = JSON.stringify(mh);
        if (mhHash !== lastHealthHash) {
            lastHealthHash = mhHash;
            broadcast({ type: 'model_health', models: mh, ts: now });
        }

        // Feed comms inter-agents (append-only JSONL, multi-workspaces)
        let anyTruncated = false;
        const fresh = [];
        for (const p of COMMS_PATHS) {
            const c = readCommsFrom(p, commsOffsets.get(p) || 0);
            commsOffsets.set(p, c.offset);
            if (c.truncated) anyTruncated = true;
            fresh.push(...c.entries);
        }
        if (anyTruncated) {
            broadcast({ type: 'comms', reset: true, entries: [], ts: now });
            broadcast({ type: 'comms', entries: readCommsTail(100), ts: now });
        }
        if (fresh.length) {
            fresh.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
            broadcast({ type: 'comms', entries: fresh, ts: now });
        }
    } catch (err) {
        console.error('[bridge] poll error:', err.message);
    }
}

function handleProviderToggle(provider, enabled) {
    if (!provider || typeof provider !== 'string') return;
    try {
        const wdb = new Database(DB_PATH);
        wdb.prepare('INSERT INTO provider_prefs (provider, enabled) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled')
            .run(provider, enabled ? 1 : 0);
        wdb.close();
        console.log(`[bridge] provider ${provider} -> ${enabled ? 'ON' : 'OFF'}`);
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] provider_toggle error:', err.message);
    }
}

function handleProviderOrder(order) {
    if (!Array.isArray(order)) return;
    try {
        const wdb = new Database(DB_PATH);
        const stmt = wdb.prepare('INSERT INTO provider_prefs (provider, enabled, position) VALUES (?, 1, ?) ' +
            'ON CONFLICT(provider) DO UPDATE SET position = excluded.position');
        const tx = wdb.transaction(() => { order.forEach((p, i) => { if (typeof p === 'string') stmt.run(p, i); }); });
        tx();
        wdb.close();
        console.log(`[bridge] provider order: ${order.join(' > ')}`);
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] provider_order error:', err.message);
    }
}

function handleClearTasks(statuses) {
    const allowed = new Set(['completed', 'failed', 'pending', 'in_progress']);
    const sts = statuses.filter((s) => allowed.has(s));
    if (!sts.length) return;
    try {
        const wdb = new Database(DB_PATH);
        const res = wdb
            .prepare(`DELETE FROM tasks_todo WHERE status IN (${sts.map(() => '?').join(',')})`)
            .run(...sts);
        wdb.close();
        console.log(`[bridge] cleared ${res.changes} task(s) [${sts.join(',')}]`);
        // resynchronise les hash pour ne pas rebroadcaster les suppressions en task_update
        lastTaskHash.clear();
        for (const t of readTasks()) lastTaskHash.set(t.id, JSON.stringify(t));
        broadcast({ type: 'clear_result', deleted: res.changes, statuses: sts, ts: new Date().toISOString() });
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] clear_tasks error:', err.message);
        broadcast({ type: 'clear_result', error: err.message, ts: new Date().toISOString() });
    }
}

// Append d'un message dans le bus comms du premier workspace résolu — les
// agents abonnés au feed (et les autres sessions) sont informés des actions UI.
function appendComms(entry) {
    const target = COMMS_PATHS[0];
    if (!target) return;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, JSON.stringify(entry) + '\n');
    } catch (e) { console.error('[bridge] comms append:', e.message); }
}

function handleDeleteTask(id) {
    const tid = Number(id);
    if (!Number.isFinite(tid)) return;
    try {
        const t = db.prepare('SELECT id, title, assigned_to FROM tasks_todo WHERE id=?').get(tid);
        const wdb = new Database(DB_PATH);
        const res = wdb.prepare('DELETE FROM tasks_todo WHERE id=?').run(tid);
        wdb.close();
        lastTaskHash.delete(tid);
        if (res.changes > 0) {
            appendComms({
                src: 'user', dst: 'broadcast',
                text: `tâche #${tid} supprimée manuellement${t ? ` — « ${String(t.title).slice(0, 80)} »` : ''}`,
                ts: new Date().toISOString(),
            });
        }
        broadcast({ type: 'task_delete', id: tid, deleted: res.changes, ts: new Date().toISOString() });
        broadcast(snapshot());
    } catch (err) {
        console.error('[bridge] delete_task error:', err.message);
        broadcast({ type: 'task_delete', id: tid, error: err.message, ts: new Date().toISOString() });
    }
}

wss.on('connection', (ws) => {
    console.log('[bridge] client connected');
    ws.send(JSON.stringify(snapshot()));
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.command === 'refresh') ws.send(JSON.stringify(snapshot()));
            if (msg.command === 'provider_toggle' && typeof msg.provider === 'string') {
                handleProviderToggle(msg.provider, !!msg.enabled);
            }
            if (msg.command === 'provider_order' && Array.isArray(msg.order)) {
                handleProviderOrder(msg.order);
            }
            if (msg.command === 'clear_tasks' && Array.isArray(msg.statuses)) {
                handleClearTasks(msg.statuses);
            }
            if (msg.command === 'delete_task') {
                handleDeleteTask(msg.id);
            }
        } catch { /* ignore malformed */ }
    });
    ws.on('close', () => console.log('[bridge] client disconnected'));
    ws.on('error', (e) => console.error('[bridge] ws error:', e.message));
});

// prime hashes without broadcasting the whole history
for (const t of readTasks()) lastTaskHash.set(t.id, JSON.stringify(t));
lastAgentHash = JSON.stringify(readAgents());

setInterval(poll, POLL_INTERVAL);
console.log(`[bridge] polling every ${POLL_INTERVAL} ms`);
