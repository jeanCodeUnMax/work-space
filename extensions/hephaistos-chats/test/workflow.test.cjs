const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const roster = require('../../../.agent/agent-bridge/workspace-roster.js');
const { buildWorkflowPrompt, preferredEntrySession, workflowOrder } = require('../out/workflow.js');

const temporaryRoots = [];

function makeRosterRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hephaistos-workflow-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agent', 'workspace-roster.json'), JSON.stringify({
        schemaVersion: 1,
        core: { devin: [], cerberos: [], bleubites: [] },
    }));
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('a chat agent is added to the roster and workflow once', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Devin' });
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Changed role' });

    const data = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'workspace-roster.json'), 'utf8'));
    assert.equal(data.core.bleubites.length, 1);
    assert.equal(data.workflow.nodes.length, 1);
    assert.equal(data.workflow.nodes[0].sessionId, 'chat-one');
    assert.equal(data.workflow.nodes[0].role, 'Devin');
});

test('workflow roster rejects cycles and removes links with a member', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Devin' });
    roster.upsertChatAgent(root, { sessionId: 'chat-two', model: 'model-b', role: 'Reviewer' });
    roster.connectWorkflowAgents(root, 'chat-one', 'chat-two');

    assert.throws(() => roster.connectWorkflowAgents(root, 'chat-two', 'chat-one'), /cyclique/);

    const data = roster.removeChatAgent(root, 'chat-two');
    assert.equal(data.nodes.length, 1);
    assert.equal(data.edges.length, 0);
});

test('workflow nodes mirror active Hephaistos roster entries', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Devin' });
    roster.upsertChatAgent(root, { sessionId: 'chat-two', model: 'model-b', role: 'Reviewer' });
    roster.connectWorkflowAgents(root, 'chat-one', 'chat-two');

    const rosterFile = path.join(root, '.agent', 'workspace-roster.json');
    const data = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    data.core.bleubites = data.core.bleubites.filter((agent) => agent.sessionId !== 'chat-two');
    fs.writeFileSync(rosterFile, JSON.stringify(data));

    const graph = roster.syncRosterWorkflow(root, [
        { id: 'chat-one', model: 'model-a' },
        { id: 'chat-two', model: 'model-b' },
        { id: 'chat-three', model: 'model-c' },
    ]);
    assert.deepEqual(graph.nodes.map((node) => node.sessionId), ['chat-one']);
    assert.equal(graph.edges.length, 0);

    const added = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    added.core.bleubites.push({
        providerId: 'hephaistos',
        sessionId: 'chat-three',
        model: 'model-c',
        restore: 'open-or-reveal',
    });
    fs.writeFileSync(rosterFile, JSON.stringify(added));
    const refreshed = roster.syncRosterWorkflow(root, [
        { id: 'chat-one', model: 'model-a' },
        { id: 'chat-three', model: 'model-c' },
    ]);
    assert.deepEqual(refreshed.nodes.map((node) => node.sessionId), ['chat-one', 'chat-three']);
});

test('workflow execution starts with Devin, falls back to Antigravity, and follows reachable edges', () => {
    const graph = {
        version: 1,
        name: 'Test',
        entrySessionId: null,
        nodes: [
            { sessionId: 'chat-openrouter', role: 'Writer', task: 'write', position: { x: 0, y: 0 } },
            { sessionId: 'chat-devin', role: 'Devin', task: 'review', position: { x: 1, y: 0 } },
            { sessionId: 'chat-antigravity', role: 'AGY', task: 'synthesize', position: { x: 2, y: 0 } },
            { sessionId: 'chat-isolated', role: 'Other', task: 'skip', position: { x: 3, y: 0 } },
        ],
        edges: [
            { id: 'e1', source: 'chat-devin', target: 'chat-openrouter' },
            { id: 'e2', source: 'chat-openrouter', target: 'chat-antigravity' },
        ],
    };
    const sessions = [
        { id: 'chat-openrouter', provider: 'openrouter' },
        { id: 'chat-devin', provider: 'devin-cli' },
        { id: 'chat-antigravity', provider: 'antigravity-acp' },
        { id: 'chat-isolated', provider: 'omniroute' },
    ];

    const entry = preferredEntrySession(graph, sessions);
    assert.equal(entry, 'chat-devin');
    assert.equal(
        preferredEntrySession(graph, sessions.filter((session) => session.id !== 'chat-devin')),
        'chat-antigravity',
    );
    assert.deepEqual(workflowOrder(graph, entry).map((node) => node.sessionId), [
        'chat-devin',
        'chat-openrouter',
        'chat-antigravity',
    ]);
    assert.match(buildWorkflowPrompt(graph.nodes[1], []), /données non fiables/);
});
