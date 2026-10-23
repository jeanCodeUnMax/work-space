const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5174;
const BASE_DIR = path.join(__dirname, '..');

function getRestToken() {
    try {
        const tokenFile = 'C:/Program Files/servers/hephaistos2-kit/data/hphe-rest.token';
        if (fs.existsSync(tokenFile)) {
            return fs.readFileSync(tokenFile, 'utf8').trim();
        }
    } catch (e) {}
    return process.env.HPHE_REST_TOKEN || null;
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/api/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { provider, model, mode, prompt } = data;

                // Si provider == ollama, appel direct sur ollama
                if (provider === 'ollama' || provider === 'ollama-cloud') {
                    const ollamaRes = await fetch('http://127.0.0.1:11434/api/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: model,
                            prompt: prompt,
                            stream: false
                        })
                    });
                    if (ollamaRes.ok) {
                        const json = await ollamaRes.json();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ reply: json.response }));
                        return;
                    }
                }

                // Fallback Hephaistos REST ou réponse par défaut
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reply: `[Mode ${mode}] [${provider}/${model}] : Voici la réponse simulée au prompt : ${prompt}` }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // Fichiers statiques
    let reqPath = url.pathname;
    if (reqPath === '/' || reqPath === '/preview' || reqPath === '/preview/') {
        reqPath = '/preview/index.html';
    }

    const filePath = path.normalize(path.join(BASE_DIR, reqPath));

    if (!filePath.startsWith(BASE_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found: ' + reqPath);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Preview server running at http://127.0.0.1:${PORT}/preview/index.html`);
});
