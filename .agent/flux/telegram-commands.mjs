// Inventaire des commandes / du bot Hermes (getMyCommands).
// Usage : node .agent/flux/telegram-commands.mjs [--json] [--scope all_group_chats]
import fs from 'node:fs';
const envFile = new URL('../handoff/heraldos-n8n/n8n-env.json', import.meta.url);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
    || (() => { try { return JSON.parse(fs.readFileSync(envFile, 'utf8')).TELEGRAM_BOT_TOKEN; } catch { return ''; } })();
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN introuvable'); process.exit(1); }
const args = process.argv.slice(2);
const json = args.includes('--json');
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : null;
const url = `https://api.telegram.org/bot${TOKEN}/getMyCommands` + (scope ? `?scope=${encodeURIComponent(JSON.stringify({ type: scope }))}` : '');
const res = await fetch(url);
const out = await res.json();
if (!out.ok) { console.error(JSON.stringify(out)); process.exit(1); }
if (json) console.log(JSON.stringify(out.result));
else for (const c of out.result) console.log(`/${c.command} — ${c.description}`);
