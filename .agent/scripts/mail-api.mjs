// mail-api.mjs — expose cli-anything-mail en HTTP local pour n8n (HTTP Request nodes)
// Usage: GET /inbox?account=live|gmail|all&top=20&unread -> tableau JSON de mails
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const PORT = 5681;
const CLI = 'F:\\Promgramation-teste\\CLI-Anything\\.venv\\Scripts\\cli-anything-mail.exe';

function fetchAccount(account, top, unread) {
    return new Promise((resolve) => {
        const args = ['--json', 'inbox', '--account', account, '--top', String(top)];
        if (unread) args.push('--unread');
        execFile(CLI, args, { timeout: 90000, windowsHide: true }, (err, stdout) => {
            if (err) return resolve({ account, error: err.message.slice(0, 200), items: [] });
            try {
                const items = JSON.parse(stdout);
                resolve({ account, items: Array.isArray(items) ? items : [items] });
            } catch (e) {
                resolve({ account, error: 'parse: ' + e.message, items: [] });
            }
        });
    });
}

const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/health') {
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (u.pathname === '/inbox' || u.pathname === '/inbox/all') {
        const acc = u.searchParams.get('account') || 'all';
        const top = parseInt(u.searchParams.get('top') || '20', 10);
        const unread = u.searchParams.get('unread') === '1' || u.searchParams.get('unread') === 'true';
        const targets = acc === 'all' ? ['live', 'gmail'] : [acc];
        const results = await Promise.all(targets.map((a) => fetchAccount(a, top, unread)));
        const items = results.flatMap((r) =>
            r.items.map((m) => ({ account: r.account, ...m })),
        );
        res.end(JSON.stringify({ ok: true, items, errors: results.filter((r) => r.error) }));
        return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
});
server.listen(PORT, '127.0.0.1', () => console.log(`mail-api on :${PORT}`));
