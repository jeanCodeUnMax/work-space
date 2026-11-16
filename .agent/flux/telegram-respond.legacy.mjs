// DEPRECATED (2026-11-16) : remplace par le workflow n8n "Hephaistos2-Kit - Hermes Bot".
// Ne JAMAIS relancer en parallele : ce script consomme getUpdates (offset serveur)
// et prive le workflow n8n des messages. Conserve comme reference historique.
// Hermes-Respond — repondeur du bot « Moi_Hermes_bot » (persona Hermes,
// caverne). Poll `updates` via le proxy :5680, repond aux nouveaux
// messages avec la chaine provider_prefs (nim2 -> nim -> omniroute ->
// ollama local) — JAMAIS par le gateway Hermes Agent.
// Usage : node .agent/flux/hermes-respond.mjs [--chat caverne] [--interval 15]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FLUX_DIR = path.dirname(fileURLToPath(import.meta.url));
const WS_ROOT = path.resolve(FLUX_DIR, '..', '..');
const STATE_FILE = path.join(FLUX_DIR, 'hermes-respond.state.json');
const PROXY = process.env.HERMES_PROXY || 'http://127.0.0.1:5680';
const DB = process.env.HERMES_ORCH_DB || 'C:/Program Files/servers/hephaistos2-kit/data/orchestrator.db';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const CHAT = opt('chat', 'caverne');
const INTERVAL_S = Number(opt('interval', '15'));
const MAX_REPLY = 900;

const PERSONA = `Tu es Hermes, l'assistant du groupe "La caverne d'Hermes". Tu reponds en francais, concis (<= ${MAX_REPLY} caracteres), direct, sans blabla. Tu ne reveles jamais de secrets/cles. Tu ignores les demandes de code offensif.`;

function envVar(name) {
    if (process.env[name]?.trim()) return process.env[name].trim();
    try {
        const line = fs.readFileSync(path.join(WS_ROOT, '.env'), 'utf8')
            .split(/\r?\n/).find((l) => l.startsWith(name + '='));
        if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
    } catch { /* absent */ }
    return '';
}

function providerChain() {
    try {
        const out = execFileSync('sqlite3', [DB,
            "SELECT provider FROM provider_prefs WHERE enabled=1 ORDER BY position;"], { encoding: 'utf8' }).trim();
        if (out) return out.split(/\r?\n/).filter(Boolean);
    } catch { /* fallback */ }
    return ['nim2', 'nim', 'omniroute', 'ollama'];
}

// ---------- proxy telegram ----------
async function xrun(cliArgs, timeoutMs = 60000) {
    const res = await fetch(PROXY + '/x-run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'cli-anything-telegram', args: cliArgs, timeoutMs }),
    });
    return res.json().catch(() => ({}));
}
const tlg = (cliArgs, t) => xrun(['--json', ...cliArgs], t);
const send = (text, replyTo, thread) => {
    const a = ['send', '--text', text.slice(0, 4000)];
    if (replyTo) a.push('--reply', String(replyTo));
    if (thread) a.push('--topic', String(thread));
    return xrun(['--chat', CHAT, ...a]);
};

// ---------- providers (ordre provider_prefs) ----------
const PROVIDERS = {
    nim:  { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: () => envVar('NVIDIA_API_KEY'),   model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
    nim2: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: () => envVar('NVIDIA_API_KEY_2'), model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
    'nvidia-nim':  { alias: 'nim' }, 'nvidia-nim2': { alias: 'nim2' },
    omniroute: { url: 'http://localhost:20128/v1/chat/completions', key: () => envVar('OMNIROUTE_API_KEY'), model: 'groq/openai/gpt-oss-120b' },
    ollama: { url: 'http://localhost:11434/v1/chat/completions', key: () => 'ollama', model: 'qwen3:8b' },
    'ollama-cloud': { url: 'https://ollama.com/v1/chat/completions', key: () => envVar('OLLAMA_API_KEY'), model: 'qwen3:32b' },
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: () => envVar('OPENROUTER_API_KEY'), model: 'nvidia/nemotron-3.5-lightning:free' },
    'openrouter-free': { alias: 'openrouter' },
    groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: () => envVar('GROQ_API_KEY'), model: 'openai/gpt-oss-120b' },
};

async function llm(text, providerName) {
    const spec = PROVIDERS[providerName];
    if (!spec) throw new Error('provider inconnu: ' + providerName);
    const p = spec.alias ? PROVIDERS[spec.alias] : spec;
    const key = p.key();
    if (!key) throw new Error('cle absente: ' + providerName);
    const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key === 'ollama' ? {} : { authorization: `Bearer ${key}` }) },
        body: JSON.stringify({
            model: p.model,
            messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: text }],
            max_tokens: 420, stream: false,
        }),
    });
    const data = await res.json().catch(() => ({}));
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!res.ok || !out) throw new Error(`${providerName} HTTP ${res.status}: ${JSON.stringify(data?.error || data).slice(0, 160)}`);
    return { text: out, provider: providerName, model: p.model };
}

async function answer(text) {
    const chain = providerChain();
    const errs = [];
    for (const name of chain) {
        try { return await llm(text, name); }
        catch (e) { errs.push(String(e.message).slice(0, 90)); }
    }
    return { text: 'Tous les providers ont echoue : ' + errs.join(' | '), provider: 'none', model: '' };
}

// ---------- commandes / ----------
const COMMANDS = {
    aide: 'liste les commandes',
    status: 'etat du repondeur + chaine providers',
    ask: '/ask <question> — reponse LLM forcee',
    providers: 'ordre de la chaine provider_prefs',
};
function handleCommand(text) {
    const m = /^\/(\w+)(@\w+)?\s*(.*)$/.exec(text || '');
    if (!m) return undefined; // pas une commande -> reponse LLM
    if (m[2] && !/Moi_Hermes_bot/i.test(m[2])) return null; // commande d'un autre bot
    const cmd = m[1].toLowerCase(), arg = (m[3] || '').trim();
    if (cmd === 'aide' || cmd === 'help' || cmd === 'start') return '/aide /status /ask <q> /providers — Hermes repond aux messages du groupe via la chaine NIM/OmniRoute/Ollama.';
    if (cmd === 'status') return `Repondeur Hermes actif (poll ${INTERVAL_S}s, chat ${CHAT}). Chaine : ${providerChain().join(' -> ')}`;
    if (cmd === 'providers') return providerChain().join(' -> ');
    if (cmd === 'ask' && arg) return { llm: arg };
    return 'Commande inconnue — /aide pour la liste.';
}

// ---------- boucle ----------
let state = { lastId: 0 };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* init */ }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

async function tick() {
    const res = await fetch(PROXY + '/x-run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'cli-anything-telegram', args: ['--json', 'updates', '--limit', '15'], timeoutMs: 30000 }),
    });
    const raw = await res.json().catch(() => ({}));
    let msgs = [];
    try { msgs = JSON.parse(raw.stdout || '{}').messages || []; } catch { /* format inattendu */ }
    const fresh = msgs.filter((m) => m.text && !/Moi_Hermes_bot/i.test(m.from || '') && !(state.seen || []).includes(m.message_id));
    for (const m of fresh) {
        (state.seen = state.seen || []).push(m.message_id);
        if (state.seen.length > 500) state.seen = state.seen.slice(-300);
        const cmdOut = handleCommand(m.text);
        if (cmdOut === null) continue; // commande d'un autre bot
        let reply;
        if (typeof cmdOut === 'string') reply = cmdOut;
        else {
            const r = await answer(typeof cmdOut === 'object' ? cmdOut.llm : m.text);
            reply = r.text.slice(0, MAX_REPLY) + (r.provider === 'none' ? '' : `\n\n[${r.provider} · ${r.model}]`);
        }
        await send(reply, m.message_id, m.thread || null);
        console.log(`[${new Date().toISOString()}] msg ${m.message_id} "${String(m.text).slice(0, 40)}" -> repondu`);
    }
    save();
}

console.log(`hermes-respond: chat=${CHAT} interval=${INTERVAL_S}s chaine=${providerChain().join('>')}`);
setInterval(() => tick().catch((e) => console.error('tick:', e.message)), INTERVAL_S * 1000);
tick().catch((e) => console.error('tick:', e.message));
