/**
 * n8n-auth-proxy — tunnel authentifié vers n8n local.
 *
 * Problème : la page n8n dans une iframe cross-site (webview IDE ->
 * localhost:5678) fait droper les cookies third-party -> login en boucle.
 * Ici, LE PROXY fait le login avec les creds de .env (gitignore) et injecte
 * le cookie de session sur CHAQUE requête forwardée : l'iframe charge
 * 127.0.0.1:5680 et tombe direct dans l'éditeur, sans jamais voir /signin.
 *
 * Usage : node .agent/scripts/n8n-auth-proxy.mjs
 * Env   : N8N_TARGET (def. http://127.0.0.1:5678), N8N_PROXY_PORT (def. 5680)
 * Creds : .env à la racine du workspace -> N8N_EMAIL / N8N_PASSWORD
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

const server = http.createServer(async (req, res) => {
    try {
        if (!sessionCookie) await login();
        const target = `${TARGET}${req.url}`;
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
        // Le cookie reste cote proxy : on strip set-cookie pour eviter les fuites
        const outHeaders = {};
        upstream.headers.forEach((v, k) => {
            // fetch() a deja decompresse : content-encoding/length deviendraient mensongers
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
    console.log(`[n8n-proxy] http://127.0.0.1:${PORT} -> ${TARGET} (auth injectee)`);
    if (!EMAIL) console.warn('[n8n-proxy] N8N_EMAIL absent du .env — login impossible');
});
