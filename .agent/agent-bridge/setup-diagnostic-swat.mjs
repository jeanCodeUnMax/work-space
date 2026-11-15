import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const api = require('./workspace-roster.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roster = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'workspace-roster.json'), 'utf8'));
const entry = roster.workflow?.entrySessionId;
if (!entry?.startsWith('acp/devin-cli/')) throw new Error('Orchestrateur Devin exact absent du schema actif');
const readSessions = () => JSON.parse(fs.readFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), 'utf8'));
const source = readSessions().find((s) => s.id === 'chat-n8narchi');
if (!source?.provider || !source.model) throw new Error('Provider/modele du staff de reference absent');
const roles = [
    ['Diagnostic-Runtime-Comms', 'Analyse uniquement les checks de services, MCP, WS, ACP et bus transmis dans inputs.evidence. Cite les IDs des checks et leurs preuves. Aucune modification, aucun outil, aucun redemarrage. Ne confonds jamais ACP natif et fenetres chat-*.'],
    ['Diagnostic-Roster-Identites', 'Analyse uniquement le roster, les sessions et les liaisons presentes dans inputs.evidence. Distingue presence disque, ACK agent et fenetre visible. Cite les checks ; pas de choix de remplacement, pas de modification ni outil.'],
    ['Diagnostic-Architecture', 'Analyse la couverture des checks transmis dans inputs.evidence : architecture canonique, orchestrateur, versions et limites. N invente aucun test GUI ou CLI. Aucun outil ni modification. Propose seulement les verifications manquantes.'],
    ['Diagnostic-Synthese', 'Synthetise les trois analyses amont et les preuves inputs.evidence. Rend anomalies prioritaires, impact, causes etablies versus hypotheses, limites et recommandations. Ne transforme aucun fail ou not_tested en OK. Aucun outil, reparation ou redemarrage.'],
];
const child = spawn(process.execPath, [path.join(root, 'extensions', 'hephaistos-chats', 'acp-server.mjs')], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
});
let serial = 0;
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    }
});
function rpc(method, params) {
    return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}
try {
    await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'diagnostic-swat-setup', version: '1.0' } });
    const nodes = [{ ...roster.workflow.nodes.find((n) => n.sessionId === entry), sessionId: entry,
        role: 'Orchestrateur', task: 'Attribue les missions de diagnostic, controle les preuves et autorise separement toute correction.', position: { x: 0, y: 200 } }];
    for (let i = 0; i < roles.length; i++) {
        const [role, task] = roles[i];
        const member = roster.core.bleubites.find((m) => m.role === role);
        let session = member ? readSessions().find((s) => s.id === member.sessionId) : null;
        if (member && !session) throw new Error(`Session declaree mais absente : ${member.sessionId}. Pas de remplacement.`);
        if (!session) {
            const created = await rpc('session/new', { cwd: root, provider: source.provider, model: source.model, mode: 'agent', title: role });
            session = readSessions().find((s) => s.id === created.sessionId);
            if (!session) throw new Error(`Creation ACP non persistante : ${role}`);
            api.upsertCoreAgent(root, 'bleubites', { sessionId: session.id, providerId: session.provider, model: session.model, role, title: role, restore: 'open-or-reveal' });
        }
        nodes.push({ sessionId: session.id, role, task, title: role, skills: [], mcps: [],
            position: i === 3 ? { x: 650, y: 200 } : { x: 300, y: i * 200 } });
    }
    const workers = nodes.slice(1, 4);
    const graph = { version: 1, name: 'swat-diagnostic-hephaistos', entrySessionId: entry, nodes,
        edges: [...workers.map((n, i) => ({ id: `entry-${i}`, source: entry, target: n.sessionId })),
            ...workers.map((n, i) => ({ id: `synthesis-${i}`, source: n.sessionId, target: nodes[4].sessionId }))] };
    const schema = api.saveSchema(root, graph.name, graph);
    api.loadSchema(root, schema.id);
    console.log(JSON.stringify({ schemaId: schema.id, name: schema.name, entrySessionId: entry,
        agents: nodes.slice(1).map(({ sessionId, role }) => ({ sessionId, role })) }, null, 2));
} finally { child.kill(); }
