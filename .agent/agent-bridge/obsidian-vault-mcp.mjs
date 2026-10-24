import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.env.OBSIDIAN_VAULT_PATH || 'F:/doc_Obsidian/Doc');
const MAX_RESULTS = 200;
const MAX_BYTES = 2 * 1024 * 1024;

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }
function safe(relative) {
  const target = path.resolve(ROOT, String(relative || ''));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) throw new Error('Chemin hors du vault');
  return target;
}
async function files(dir = ROOT, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.obsidian' || entry.name === '.trash' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await files(full, out);
    else out.push(path.relative(ROOT, full).replaceAll(path.sep, '/'));
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}
async function toolsCall(name, args = {}) {
  if (name === 'vault_list') return { vault: ROOT, files: await files(safe(args.path || '')) };
  if (name === 'vault_read') {
    const file = safe(args.path);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Fichier absent ou trop volumineux');
    return { path: args.path, content: await fs.readFile(file, 'utf8') };
  }
  if (name === 'vault_search') {
    const query = String(args.query || '').toLowerCase();
    if (!query) throw new Error('query requis');
    const results = [];
    for (const rel of await files()) {
      if (!/\.(md|markdown|txt|json|yaml|yml|canvas)$/i.test(rel)) continue;
      try {
        const content = await fs.readFile(safe(rel), 'utf8');
        const index = content.toLowerCase().indexOf(query);
        if (index >= 0) results.push({ path: rel, excerpt: content.slice(Math.max(0, index - 160), index + query.length + 240) });
      } catch { /* fichier modifié pendant la recherche */ }
      if (results.length >= MAX_RESULTS) break;
    }
    return { query, results };
  }
  if (name === 'vault_write') {
    const file = safe(args.path);
    const content = String(args.content ?? '');
    if (!/\.(md|markdown|txt|json|yaml|yml|canvas)$/i.test(String(args.path))) throw new Error('Extension non autorisee');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return { path: args.path, bytes: Buffer.byteLength(content) };
  }
  throw new Error(`Outil inconnu: ${name}`);
}

let line = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  line += chunk;
  const rows = line.split('\n'); line = rows.pop();
  for (const raw of rows) {
    if (!raw.trim()) continue;
    let msg; try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'obsidian-live', version: '1.0.0' } });
    } else if (msg.method === 'notifications/initialized') {
      // notification: aucune réponse
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: [
        { name: 'vault_list', description: 'Liste les fichiers du vault Obsidian.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'vault_read', description: 'Lit une note du vault.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
        { name: 'vault_search', description: 'Recherche du texte dans les notes.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
        { name: 'vault_write', description: 'Ecrit une note dans le vault.', inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } }
      ] });
    } else if (msg.method === 'tools/call') {
      try { reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(await toolsCall(msg.params?.name, msg.params?.arguments), null, 2) }] }); }
      catch (e) { error(msg.id, -32000, e.message); }
    } else if (msg.id !== undefined) error(msg.id, -32601, `Méthode inconnue: ${msg.method}`);
  }
});
