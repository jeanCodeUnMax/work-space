import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function summarizeChecks(checks) {
    const counts = { pass: 0, fail: 0, warn: 0, not_tested: 0 };
    for (const check of checks) {
        if (!(check.status in counts)) throw new Error('Statut de diagnostic inconnu');
        counts[check.status]++;
    }
    return { counts, verdict: counts.fail ? 'degraded' : counts.warn || counts.not_tested ? 'partial' : 'healthy' };
}

export function reportPath(root, id, final = false) {
    if (!ID.test(id)) throw new Error('Identifiant diagnostic invalide');
    return path.join(root, '.agent', 'reports', `diagnostic-${id}${final ? '-final' : ''}.json`);
}

export async function collectDiagnostics({ root, tool, requestAcp, bridgeConnected, fetchImpl = fetch, exec = execFileAsync }) {
    const checks = [];
    const measure = async (id, fn) => {
        const started = Date.now();
        try { checks.push({ id, ...await fn(), durationMs: Date.now() - started }); }
        catch (e) { checks.push({ id, status: 'fail', evidence: String(e.message).slice(0, 400), durationMs: Date.now() - started }); }
    };
    let roster;
    let sessions;
    await measure('roster-json', async () => {
        roster = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'workspace-roster.json'), 'utf8'));
        const nodes = roster.workflow?.nodes || [];
        const ids = nodes.map((n) => n.sessionId);
        const edges = roster.workflow?.edges || [];
        const invalid = !ids.includes(roster.workflow?.entrySessionId) || new Set(ids).size !== ids.length
            || nodes.some((n) => !n.role?.trim() || !n.task?.trim())
            || edges.some((e) => !ids.includes(e.source) || !ids.includes(e.target));
        return { status: invalid ? 'fail' : 'pass', evidence: { activeSchemaId: roster.workflow?.activeSchemaId,
            entrySessionId: roster.workflow?.entrySessionId, nodeCount: nodes.length, edgeCount: edges.length } };
    });
    await measure('chat-session-bindings', async () => {
        sessions = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), 'utf8'));
        if (!Array.isArray(sessions) || !roster) throw new Error('Roster ou sessions indisponibles');
        const members = Object.values(roster.core || {}).flat();
        const bindings = roster.workflow.nodes.filter((n) => n.sessionId.startsWith('chat-')).map((n) => {
            const s = sessions.find((s) => s.id === n.sessionId);
            const m = members.find((m) => m.sessionId === n.sessionId);
            return { sessionId: n.sessionId, present: !!s, hidden: m?.hidden === true,
                providerMatches: !!s && s.provider === m?.providerId, modelMatches: !!s && s.model === m?.model };
        });
        return { status: bindings.length && bindings.every((b) => b.present && !b.hidden && b.providerMatches && b.modelMatches) ? 'pass' : 'fail',
            evidence: bindings, limitation: 'Presence et coherence disque uniquement ; pas une preuve de fenetre ouverte.' };
    });
    await measure('architecture-canonical-reference', async () => {
        const text = fs.readFileSync(path.join(root, '.agent', 'ARCHITECTURE.md'), 'utf8');
        return { status: text.includes('Hephaistos-everything-search') && text.includes('hphe-mcp') ? 'pass' : 'fail',
            evidence: { file: '.agent/ARCHITECTURE.md', sha256: crypto.createHash('sha256').update(text).digest('hex') },
            limitation: 'Reference canonique presente ; pas une validation exhaustive de architecture.' };
    });
    for (const [id, url] of [['n8n-health', 'http://127.0.0.1:5678/healthz'], ['rest-health', 'http://127.0.0.1:8792/health']]) {
        await measure(id, async () => {
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
            const body = await response.json();
            return { status: response.ok && ['ok', 'healthy'].includes(body.status || body.state)
                && body.pipe_connected !== false ? 'pass' : 'fail', evidence: { httpStatus: response.status,
                status: body.status || body.state, pipeConnected: body.pipe_connected, ingestBusy: body.ingest_busy } };
        });
    }
    checks.push({ id: 'bridge-websocket', status: bridgeConnected ? 'pass' : 'fail',
        evidence: { connected: bridgeConnected }, limitation: 'Connexion du bridge ; pas un ACK de livraison agent.' });
    await measure('native-acp-enumeration', async () => {
        const result = await requestAcp();
        return { status: result.sessions?.length ? 'pass' : 'warn', evidence: { sessionCount: result.sessions?.length || 0 },
            limitation: 'Enumeration ACP native seulement : ne pas traiter les fenetres chat-* comme des ACP natifs manquants.' };
    });
    await measure('canonical-mcp-health', async () => {
        const result = await tool('hphe_health', {});
        return { status: result.status === 'healthy' || result.pipe_connected === true ? 'pass' : 'warn',
            evidence: { status: result.status, pipeConnected: result.pipe_connected }, limitation: 'Sonde du serveur canonique, pas de tous ses outils.' };
    });
    await measure('orchestrator-task-state', async () => {
        const tasks = await tool('list_tasks', {});
        if (!Array.isArray(tasks)) throw new Error('Reponse list_tasks non reconnue');
        const states = {};
        for (const t of tasks) states[t.status] = (states[t.status] || 0) + 1;
        return { status: 'pass', evidence: { readable: true, taskCount: tasks.length, states },
            limitation: 'Lecture seule : ne teste pas le spawn des workers CLI ni ne reconcilie les taches.' };
    });
    await measure('comms-jsonl-integrity', async () => {
        const lines = fs.readFileSync(path.join(root, '.agent', 'comms.jsonl'), 'utf8').split('\n');
        const malformedLines = [];
        let entries = 0;
        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue;
            try { JSON.parse(line); entries++; }
            catch {
                malformedLines.push({ lineNumber: index + 1, bytes: Buffer.byteLength(line),
                    sha256: crypto.createHash('sha256').update(line).digest('hex'),
                    startsWithBom: line.charCodeAt(0) === 0xfeff });
            }
        }
        const malformed = malformedLines.length;
        return { status: malformed ? 'fail' : 'pass', evidence: { entries, malformed, malformedLines },
            limitation: 'Integrite du journal uniquement ; aucun contenu de message expose.' };
    });
    await measure('installed-extensions', async () => {
        const install = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Devin');
        const { stdout } = await exec(path.join(install, 'Devin.exe'),
            [path.join(install, 'resources', 'app', 'out', 'cli.js'), '--list-extensions', '--show-versions'],
            { timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } });
        const versions = stdout.split(/\r?\n/).filter((s) => /^hephaistos\.(hephaistos-chats|orchestrator-monitor)@/.test(s.trim()));
        return { status: versions.length === 2 ? 'pass' : 'warn', evidence: { versions },
            limitation: 'Versions installees seulement ; activation et rechargement non prouves.' };
    });
    for (const [id, reason] of [
        ['ide-ui-interaction', 'Aucun clic utilisateur, association de carte ou affichage de panneau teste par cette sonde.'],
        ['cli-worker-execution', 'Aucun worker CLI lance : pas de consommation ni de modification pour simuler un test.'],
        ['cloud-and-external-services', 'Kaggle, Colab, ComfyUI et autres integrations externes non testes.'],
    ]) checks.push({ id, status: 'not_tested', evidence: reason });
    const report = { diagnosticId: crypto.randomUUID(), collectedAt: new Date().toISOString(),
        activeSchemaId: roster?.workflow?.activeSchemaId, activeSchemaName: roster?.workflow?.activeSchema,
        checks, ...summarizeChecks(checks), repairsPerformed: false };
    const file = reportPath(root, report.diagnosticId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx' });
    return { ...report, evidenceFile: file };
}

export function normalizeEnvBytes(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { changed: false, bytes };
    } catch {
        const text = new TextDecoder('windows-1252', { fatal: true }).decode(bytes);
        if (text.includes('\u0000') || text.split(/\r?\n/).some((line) => line.trim()
            && !line.trimStart().startsWith('#') && /[^\x00-\x7f]/.test(line))) {
            throw new Error('Valeur env non ASCII ou encodage non reconnu : conversion automatique refusee');
        }
        return { changed: true, bytes: Buffer.from(text, 'utf8') };
    }
}

export function repairWorkspaceEnvEncoding(root) {
    const file = path.join(root, '.env');
    const original = fs.readFileSync(file);
    const normalized = normalizeEnvBytes(original);
    if (!normalized.changed) return { changed: false, encoding: 'utf8' };
    const backup = path.join(root, '.agent', 'reports', `env-before-utf8-${crypto.randomUUID()}.bak`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(backup).equals(original) || !fs.readFileSync(file).equals(original)) {
        throw new Error('Fichier modifie pendant sauvegarde : aucune correction appliquee');
    }
    const temporary = `${backup}.utf8-tmp`;
    fs.writeFileSync(temporary, normalized.bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
    if (!fs.readFileSync(file).equals(normalized.bytes)) throw new Error('Verification encodage echouee');
    return { changed: true, encoding: 'utf8', backup, originalBytes: original.length, normalizedBytes: normalized.bytes.length };
}

export async function verifyCommsRepair(root, archiveFile, exec = execFileAsync) {
    const { stdout: before } = await exec(path.join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip', '7z.exe'),
        ['x', '-so', archiveFile, 'comms.jsonl'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const after = fs.readFileSync(path.join(root, '.agent', 'comms.jsonl'), 'utf8');
    const oldLines = before.split('\n');
    if (oldLines.at(-1) === '') oldLines.pop();
    const newLines = after.split('\n');
    const changed = oldLines.flatMap((line, i) => line === newLines[i] ? [] : [i]);
    if (newLines.length < oldLines.length || changed.length !== 1) throw new Error('Historique different au-dela de la correction autorisee');
    const index = changed[0];
    const original = oldLines[index].replace(/\r$/, '').match(/^src:(\S+) dst:(\S+) kind:(\S+) convId:(\S+) text:([\s\S]*)$/);
    const repaired = JSON.parse(newLines[index]);
    if (!original || repaired.src !== original[1] || repaired.dst !== original[2] || repaired.kind !== original[3]
        || repaired.convId !== original[4] || repaired.text !== original[5]) throw new Error('Contenu historique non preserve');
    for (const line of newLines) if (line.trim()) JSON.parse(line);
    return { backupVerified: true, correctedLine: index + 1, unchangedArchivedLines: oldLines.length - 1,
        extraLinesSinceBackup: newLines.filter((l) => l.trim()).length - oldLines.filter((l) => l.trim()).length,
        malformed: 0, messageAndConversationPreserved: true };
}

export function saveDiagnosticReport(root, evidenceId, mission) {
    const evidence = JSON.parse(fs.readFileSync(reportPath(root, evidenceId), 'utf8'));
    const result = { ...evidence, ...summarizeChecks(evidence.checks), missionId: mission.missionId,
        swatExecutionState: mission.state, agentAnalyses: mission.steps,
        analysisWarning: 'Analyses agents non probantes seules : les checks mesures restent la source des verdicts.',
        repairsPerformed: false };
    const file = reportPath(root, evidenceId, true);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    return { ok: true, reportFile: file, report: result };
}
