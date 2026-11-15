import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { swatGraph, normalizeMission } from './bridge-api.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hphe-swat-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.agent', 'chats'), { recursive: true });
    const ids = ['acp/devin-cli/exact-entry', 'chat-n8narchi', 'chat-n8nops', 'chat-n8nverif'];
    const roster = { core: { devin: [{ sessionId: ids[0], providerId: 'devin-cli' }],
        bleubites: ids.slice(1).map((sessionId) => ({ sessionId, providerId: 'nim2', model: 'chosen-model' })) },
        workflow: { activeSchemaId: 'schema-swat-n8n', entrySessionId: ids[0],
            nodes: ids.map((sessionId) => ({ sessionId, task: 'mission', role: sessionId })),
            edges: ids.slice(1).map((target, i) => ({ source: ids[i], target })) } };
    const sessions = ids.slice(1).map((id) => ({ id, provider: 'nim2', model: 'chosen-model' }));
    const save = () => {
        fs.writeFileSync(path.join(root, '.agent', 'workspace-roster.json'), JSON.stringify(roster));
        fs.writeFileSync(path.join(root, '.agent', 'chats', 'sessions.json'), JSON.stringify(sessions));
    };
    save();
    return { root, roster, sessions, save };
}

test('uses the exact active graph and preserves entry identity', (t) => {
    const f = fixture(t);
    assert.deepEqual(swatGraph(f.root).graph, f.roster.workflow);
    assert.equal(swatGraph(f.root).digest, swatGraph(f.root).digest);
});

test('rejects missing sessions instead of choosing another agent', (t) => {
    const f = fixture(t);
    f.sessions.shift(); f.save();
    assert.throws(() => swatGraph(f.root), /chat-n8narchi/);
});

test('rejects provider or model drift', (t) => {
    const f = fixture(t);
    f.sessions[0].provider = 'different'; f.save();
    assert.throws(() => swatGraph(f.root), /divergent/);
});

test('rejects hidden members', (t) => {
    const f = fixture(t);
    f.roster.core.bleubites[0].hidden = true; f.save();
    assert.throws(() => swatGraph(f.root), /absente/);
});

test('accepts another explicitly active SWAT without a second registry', (t) => {
    const f = fixture(t);
    f.roster.workflow.activeSchemaId = 'another-swat'; f.save();
    assert.equal(swatGraph(f.root).graph.activeSchemaId, 'another-swat');
});

test('rejects cycles and disconnected graphs', (t) => {
    const f = fixture(t);
    f.roster.workflow.edges[1].source = 'chat-n8nverif'; f.save();
    assert.throws(() => swatGraph(f.root), /cyclique/);
});

test('accepts fork and join dependencies from the active graph', (t) => {
    const f = fixture(t);
    f.roster.workflow.edges = [
        { source: f.roster.workflow.entrySessionId, target: 'chat-n8narchi' },
        { source: f.roster.workflow.entrySessionId, target: 'chat-n8nops' },
        { source: 'chat-n8narchi', target: 'chat-n8nverif' },
        { source: 'chat-n8nops', target: 'chat-n8nverif' },
    ]; f.save();
    assert.equal(swatGraph(f.root).graph.edges.length, 4);
});

test('validates dynamic mission input and preserves inputs and constraints', () => {
    const contract = normalizeMission({ missionId: 'mission-123', swatId: 'schema-swat-n8n',
        objective: 'Analyse cette erreur', inputs: { error: 'example' }, constraints: ['Ne rien modifier'] });
    assert.equal(contract.schemaId, 'schema-swat-n8n');
    assert.equal(contract.inputs.error, 'example');
    assert.deepEqual(contract.constraints, ['Ne rien modifier']);
    for (const invalid of [{}, { ...contract, missionId: '../x' }, { ...contract, constraints: 'text' }]) {
        assert.throws(() => normalizeMission(invalid));
    }
});

test('n8n accepts authenticated external missions and loops over the canonical graph', () => {
    const workflow = JSON.parse(fs.readFileSync(new URL('./n8n-swat-workflow.json', import.meta.url), 'utf8'));
    const webhook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    assert.equal(webhook.parameters.authentication, 'headerAuth');
    assert.ok(webhook.credentials.httpHeaderAuth.id);
    assert.equal(workflow.connections['SWAT termine'].main[1][0].node, 'Executer prochain agent du graphe');
    assert.equal(workflow.id, 'vyvBFDvUdt1hcFl9');
    assert.ok(!JSON.stringify(workflow).includes('/sessions'));
    assert.ok(!JSON.stringify(workflow).includes('Bearer '));
    for (const [source, outputs] of Object.entries(workflow.connections)) {
        assert.ok(workflow.nodes.some((n) => n.name === source));
        for (const output of outputs.main) for (const edge of output) assert.ok(workflow.nodes.some((n) => n.name === edge.node));
    }
});
