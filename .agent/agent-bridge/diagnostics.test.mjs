import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, reportPath, saveDiagnosticReport, summarizeChecks, verifyCommsRepair, normalizeEnvBytes, repairWorkspaceEnvEncoding } from './diagnostics.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hphe-diagnostics-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.agent', 'chats'), { recursive: true });
    const member = { sessionId: 'chat-test', providerId: 'nim2', model: 'chosen', hidden: false };
    fs.writeFileSync(path.join(root, '.agent', 'workspace-roster.json'), JSON.stringify({
        core: { bleubites: [member] }, workflow: { activeSchemaId: 'diag', activeSchema: 'swat-diagnostic-hephaistos',
            entrySessionId: 'acp/devin-cli/exact', nodes: [
                { sessionId: 'acp/devin-cli/exact', role: 'Orchestrateur', task: 'supervise' },
                { sessionId: 'chat-test', role: 'Diagnosticien', task: 'analyse' },
            ], edges: [{ source: 'acp/devin-cli/exact', target: 'chat-test' }] } }));
    fs.writeFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), JSON.stringify([
        { id: 'chat-test', provider: 'nim2', model: 'chosen', messages: [{ text: 'DO-NOT-EXPOSE' }] },
    ]));
    fs.writeFileSync(path.join(root, '.agent', 'ARCHITECTURE.md'), 'Hephaistos-everything-search hphe-mcp');
    fs.writeFileSync(path.join(root, '.agent', 'comms.jsonl'), '{"kind":"event","text":"DO-NOT-EXPOSE"}\n');
    const options = { root, bridgeConnected: true,
        tool: async (name) => name === 'hphe_health' ? { status: 'healthy' } : [{ id: 1, status: 'pending', description: 'DO-NOT-EXPOSE' }],
        requestAcp: async () => ({ sessions: [{ sessionId: 'native' }] }),
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'healthy' }) }),
        exec: async () => ({ stdout: 'hephaistos.hephaistos-chats@0.3.48\nhephaistos.orchestrator-monitor@0.0.74\n' }),
    };
    return options;
}

test('not-tested coverage cannot produce a healthy verdict', () => {
    assert.equal(summarizeChecks([{ status: 'pass' }, { status: 'not_tested' }]).verdict, 'partial');
    assert.equal(summarizeChecks([{ status: 'fail' }]).verdict, 'degraded');
    assert.throws(() => summarizeChecks([{ status: 'invented' }]));
});

test('collector persists measured evidence without leaking message or task contents', async (t) => {
    const options = fixture(t);
    const result = await collectDiagnostics(options);
    assert.equal(result.verdict, 'partial');
    assert.equal(result.counts.fail, 0);
    assert.equal(result.repairsPerformed, false);
    assert.ok(fs.existsSync(result.evidenceFile));
    assert.ok(!JSON.stringify(result).includes('DO-NOT-EXPOSE'));
});

test('unhealthy probes and malformed bus remain failures despite optimistic agent prose', async (t) => {
    const options = fixture(t);
    options.fetchImpl = async () => { throw new Error('service timeout'); };
    fs.appendFileSync(path.join(options.root, '.agent', 'comms.jsonl'), 'invalid-json\n');
    const evidence = await collectDiagnostics(options);
    assert.equal(evidence.verdict, 'degraded');
    assert.ok(evidence.counts.fail >= 3);
    const final = saveDiagnosticReport(options.root, evidence.diagnosticId, { missionId: 'test', state: 'completed', steps: [{ reply: 'Everything is healthy' }] });
    assert.equal(final.report.verdict, 'degraded');
    assert.equal(final.report.swatExecutionState, 'completed');
    assert.ok(fs.existsSync(final.reportFile));
});

test('env encoding repair preserves ASCII values, backs up original bytes and is idempotent', (t) => {
    const options = fixture(t);
    const original = Buffer.concat([Buffer.from('# comment '), Buffer.from([0x97]), Buffer.from('\nHPHE_URL=http://localhost:7478\nTEST_VALUE=ascii-only\n')]);
    const file = path.join(options.root, '.env');
    fs.writeFileSync(file, original);
    const result = repairWorkspaceEnvEncoding(options.root);
    assert.equal(result.changed, true);
    assert.deepEqual(fs.readFileSync(result.backup), original);
    const fixed = fs.readFileSync(file, 'utf8');
    assert.ok(fixed.includes('# comment \u2014'));
    assert.ok(fixed.includes('TEST_VALUE=ascii-only\n'));
    assert.equal(repairWorkspaceEnvEncoding(options.root).changed, false);
    assert.throws(() => normalizeEnvBytes(Buffer.from([65, 61, 0x97])), /conversion automatique refusee/);
});

test('repair verification preserves every other archived line and the original message', async (t) => {
    const options = fixture(t);
    const original = 'src:devin-cli dst:n8n kind:reply convId:exact-id text:Message historique';
    const first = '{"kind":"event","text":"unchanged"}';
    const before = `${first}\n${original}\n`;
    const repaired = JSON.stringify({ src: 'devin-cli', dst: 'n8n', kind: 'reply', convId: 'exact-id', text: 'Message historique' });
    const current = path.join(options.root, '.agent', 'comms.jsonl');
    fs.writeFileSync(current, `${first}\n${repaired}\n{"kind":"new-event"}\n`);
    const result = await verifyCommsRepair(options.root, 'fixture.7z', async () => ({ stdout: before }));
    assert.equal(result.correctedLine, 2);
    assert.equal(result.extraLinesSinceBackup, 1);
    assert.equal(result.messageAndConversationPreserved, true);
    fs.writeFileSync(current, `{"kind":"modified"}\n${repaired}\n`);
    await assert.rejects(() => verifyCommsRepair(options.root, 'fixture.7z', async () => ({ stdout: before })), /Historique different/);
});

test('report paths cannot escape the report directory', () => {
    assert.throws(() => reportPath('/tmp', '../credentials'));
    assert.throws(() => reportPath('/tmp', 'anything.json'));
});

test('diagnostic workflow is independently named and authenticated', () => {
    const workflow = JSON.parse(fs.readFileSync(new URL('./n8n-diagnostic-workflow.json', import.meta.url), 'utf8'));
    assert.equal(workflow.id, 'hpheDiagnosticSwat');
    assert.equal(workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters.authentication, 'headerAuth');
    assert.ok(!JSON.stringify(workflow).includes('Bearer '));
});
