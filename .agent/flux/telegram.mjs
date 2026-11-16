// Pont flux -> n8n "SWAT - Telegram Hub" (webhook swat-telegram-hub).
// Usage : node .agent/flux/telegram.mjs <action> [--chat X] [--text T]
//   [--imageUrl U] [--caption C] [--messageId N] [--topic N] [--reply N]
//   [--path F] [--kind K] [--question Q] [--options a,b,c] [--query Q]
//   [--limit N] [--deep] [--cmd C] [--args A]
// chat : nom configure (caverne, canal) ou id numerique (contact prive).
import fs from 'node:fs';
const BASE = process.env.N8N_WEBHOOK_BASE || 'http://127.0.0.1:5678/webhook';
const PATH = process.env.N8N_TELEGRAM_PATH || 'swat-telegram-hub';
// Header Auth « Hephaistos Bridge » = Bearer + token ws-bridge.
const TOKEN = process.env.ORCH_MONITOR_TOKEN
    || (() => { try { return fs.readFileSync(new URL('../ws-bridge.token', import.meta.url), 'utf8').trim(); } catch { return ''; } })();

const [, , action, ...rest] = process.argv;
if (!action) {
    console.error('usage: telegram.mjs <action> [options]');
    process.exit(2);
}
const body = { action };
for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, '');
    if (k === 'deep') { body.deep = true; continue; }
    const v = rest[++i];
    if (k === 'options') { body.options = String(v).split(','); continue; }
    if (k === 'messageId' || k === 'topic' || k === 'reply' || k === 'limit') {
        body[k] = Number(v); continue;
    }
    body[k] = v;
}

const res = await fetch(`${BASE}/${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
});
const out = await res.json().catch(() => ({}));
if (out.stdout) { process.stdout.write(out.stdout); }
else { console.log(JSON.stringify(out)); }
process.exit(res.ok && out.ok !== false ? 0 : 1);
