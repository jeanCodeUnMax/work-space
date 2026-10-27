/**
 * n8n-auth-proxy — tunnel authentifié vers n8n local.
 * Routes de contrôle (ctl) étendues pour piloter n8n via le proxy.
 *
 * Problème : la page n8n dans une iframe cross-site (webview IDE ->
 * localhost:5678) fait droper les cookies third-party -> login en boucle.
 * Ici, LE PROXY fait le login avec les creds de .env (gitignore) et injecte
 * le cookie de session sur CHAQUE requête forwardée : l'iframe charge
 * 127.0.0.1:5680 et tombe direct dans l'éditeur, sans jamais voir /signin.
 *
 * Ports : N8N_TARGET (def. http://127.0.0.1:5678), N8N_PROXY_PORT (def. 5680)
 * Creds  : .env à la racine du workspace -> N8N_EMAIL / N8N_PASSWORD
 *
 * === ROUTES CTL (exposées sur http://127.0.0.1:5680/ctl/...) ===
 * Toutes les routes forwardent vers http://127.0.0.1:5678/rest/... avec le cookie injecté.
 * Les agents n'ont qu'à appeler :5680/ctl/* sans gérer l'auth.
 *
 *   GET  /ctl/workflows          -> GET  /rest/workflows
 *   POST /ctl/workflows          -> POST /rest/workflows
 *   POST /ctl/workflows/:id/activate  -> POST /rest/workflows/:id/activate
 *   POST /ctl/workflows/:id/deactivate -> POST /rest/workflows/:id/deactivate
 *   POST /ctl/workflows/:id/archive   -> POST /rest/workflows/:id/archive
 *   DELETE /ctl/workflows/:id       -> DELETE /rest/workflows/:id (archive+delete auto)
 *   GET  /ctl/workflows/:id/executions -> GET /rest/workflows/:id/executions
 *
 * Exemples :
 *   curl http://127.0.0.1:5680/ctl/workflows
 *   curl -X POST http://127.0.0.1:5680/ctl/workflows -H "Content-Type: application/json" -d '{"name":"Mon Workflow"}'
 *   curl http://127.0.0.1:5680/ctl/workflows/123/executions
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE = process.cwd();
const TARGET = process.env.N8N_TARGET || 'http://127.0.0.1:5678';
const PORT = Number(process.env.N8N_PROXY_PORT || 5680);

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

const env = { ...loadEnv(path.join(WORKSPACE, '.env')), ...process.env };
const EMAIL = env.N8N_EMAIL || '';
const PASSWORD = env.N8N_PASSWORD || '';

let sessionCookie = '';

async function login() {
    const res = await fetch(`${TARGET}/rest/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emailOrLdapLoginId: EMAIL, password: PASSWORD }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const m = /n8n-auth=[^;]+/.exec(setCookie);
    if (!res.ok || !m) throw new Error(`login n8n KO (${res.status})`);
    sessionCookie = m[0];
    console.log(`[n8n-proxy] login OK ${EMAIL}`);
}

/* ---------- /x-run : execution locale whitelistee pour n8n ----------
 * n8n 2.x refuse le noeud ExecuteCommand. Les workflows utilisent un noeud
 * HTTP Request vers POST /x-run {command,args[],timeoutMs?} — seuls les
 * binaires whitelistes tournent, pas d'auth (loopback only). */
const { execFile } = await import('node:child_process');
const RUN_WHITELIST = new Set(['cli-anything-telegram', 'cli-anything-mail', 'cli-anything-notes']);

function runWhitelisted(command, args, timeoutMs) {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: timeoutMs || 30000, windowsHide: true },
            (err, stdout, stderr) => {
                resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || '').slice(0, 20000), stderr: String(stderr || '').slice(0, 4000) });
            });
    });
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.url === '/x-run' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                    const args = Array.isArray(body.args) ? body.args.map(String) : [];
                    if (!RUN_WHITELIST.has(body.command)) {
                        res.writeHead(403, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ ok: false, error: `commande non whitelistee: ${body.command}` }));
                        return;
                    }
                    const out = await runWhitelisted(body.command, args, body.timeoutMs);
                    res.writeHead(out.ok ? 200 : 500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(out));
                } catch (e) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
            return;
        }

        if (!sessionCookie) await login();
        // /ctl/* -> /rest/* (facade de controle) ; tout le reste passe tel quel (UI, assets, webhooks)
        const forwardPath = req.url.startsWith('/ctl/')
            ? '/rest' + req.url.slice(4)
            : req.url;
        const target = `${TARGET}${forwardPath}`;

        const headers = { ...req.headers, host: new URL(TARGET).host, cookie: sessionCookie };
        delete headers['content-length'];
        const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((ok) => {
                const chunks = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => ok(Buffer.concat(chunks)));
            }),
            redirect: 'manual',
        });
        // Strip set-cookie, content-encoding, content-length pour eviter les fuites
        const outHeaders = {};
        upstream.headers.forEach((v, k) => {
            if (['set-cookie', 'content-encoding', 'content-length'].includes(k.toLowerCase())) return;
            outHeaders[k] = v;
        });
        res.writeHead(upstream.status, outHeaders);
        res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`n8n-auth-proxy: ${e.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[n8n-proxy] http://127.0.0.1:${PORT} -> ${TARGET} (auth injectée)`);
    console.log('[n8n-proxy] Routes CTV available under /ctl/*');
    if (!EMAIL) console.warn('[n8n-proxy] N8N_EMAIL absent du .env — login impossible');
});