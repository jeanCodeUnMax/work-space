const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const roster = require('../../../.agent/agent-bridge/workspace-roster.js');
const { buildWorkflowPrompt, preferredEntrySession, workflowOrder, focusedIdeSessionId, ideSessionChoices } = require('../out/workflow.js');

test('IDE binding preserves the full Antigravity session identity', () => {
    const sessionId = 'acp/antigravity-acp/exact-session';
    assert.equal(focusedIdeSessionId('antigravity-acp', [
        { providerId: 'antigravity-acp', sessionId, focused: true },
    ]), sessionId);
});

test('IDE binding normalizes raw identities without selecting another conversation', () => {
    assert.equal(focusedIdeSessionId('antigravity-acp', [
        { providerId: 'antigravity-acp', sessionId: 'inactive', focused: false },
        { providerId: 'antigravity-acp', sessionId: 'active', focused: true },
    ]), 'acp/antigravity-acp/active');
    assert.equal(focusedIdeSessionId('antigravity-acp', [
        { providerId: 'antigravity-acp', sessionId: 'inactive', focused: false },
    ]), '');
    assert.equal(focusedIdeSessionId('antigravity-acp', [
        { providerId: 'devin-cli', sessionId: 'acp/devin-cli/other', focused: true },
    ]), '');
    assert.equal(focusedIdeSessionId('antigravity-acp', [
        { providerId: 'antigravity-acp', sessionId: 'acp/devin-cli/other', focused: true },
    ]), '');
});

test('IDE binding exposes normalized choices when no session is marked focused', () => {
    assert.deepEqual(
        ideSessionChoices('antigravity-acp', [
            { providerId: 'antigravity-acp', sessionId: 'acp/antigravity-acp/exact-session', title: 'Cascade exacte' },
            { providerId: 'antigravity-acp', sessionId: 'raw-session', focused: true },
            { providerId: 'antigravity-acp', sessionId: 'acp/devin-cli/wrong-provider' },
        ]),
        [
            { providerId: 'antigravity-acp', sessionId: 'acp/antigravity-acp/raw-session', focused: true },
            { providerId: 'antigravity-acp', sessionId: 'acp/antigravity-acp/exact-session', title: 'Cascade exacte' },
        ],
    );
});

const temporaryRoots = [];
const schemaTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hephaistos-schemas-'));
process.env.HEPHAISTOS_SCHEMA_FILE = path.join(schemaTempRoot, 'schemas.json');

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

test('schema load preserves node positions and connections after roster sync', () => {
    const root = makeRosterRoot();
    const graph = {
        version: 1,
        name: 'Positions',
        entrySessionId: 'chat-one',
        nodes: [
            { sessionId: 'chat-one', role: 'Writer', task: 'write', position: { x: -320, y: 144 } },
            { sessionId: 'chat-two', role: 'Reviewer', task: 'review', position: { x: 420, y: -88 } },
        ],
        edges: [{ id: 'edge:one-two', source: 'chat-one', target: 'chat-two' }],
    };
    const entry = roster.saveSchema(root, 'Positions', graph);
    const loaded = roster.loadSchema(root, entry.id);
    const synced = roster.syncRosterWorkflow(root, [
        { id: 'chat-one', model: 'model-a' },
        { id: 'chat-two', model: 'model-b' },
    ]);

    assert.deepEqual(loaded.nodes.map((node) => node.position), [
        { x: -320, y: 144 },
        { x: 420, y: -88 },
    ]);
    assert.deepEqual(synced.nodes.map((node) => node.position), [
        { x: -320, y: 144 },
        { x: 420, y: -88 },
    ]);
    assert.deepEqual(synced.edges, graph.edges);
});

test('roster keeps schema nodes and exposes their profile when chat history is empty', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Codeur', providerId: 'openrouter' });
    roster.configureWorkflowNode(root, 'chat-one', { position: { x: 712, y: -204 } });

    const graph = roster.syncRosterWorkflow(root, []);
    const profile = roster.getWorkflowAgentProfile(root, 'chat-one');

    assert.equal(graph.nodes.length, 1);
    assert.deepEqual(graph.nodes[0].position, { x: 712, y: -204 });
    assert.deepEqual(profile, {
        providerId: 'openrouter',
        model: 'model-a',
        role: 'Codeur',
        title: '',
    });
});

test('moving nodes on an active schema auto-saves to that schema when switching schemas and returning', () => {
    const root = makeRosterRoot();
    const schemaA = roster.saveSchema(root, 'Schema-A', {
        version: 1,
        name: 'Schema-A',
        entrySessionId: 'acp/devin-cli/head-a',
        nodes: [
            { sessionId: 'acp/devin-cli/head-a', role: 'Orchestrateur', task: 'a1', position: { x: -500, y: -140 } },
            { sessionId: 'chat-one', role: 'Codeur', task: 'a2', position: { x: -200, y: -140 } },
            { sessionId: 'chat-two', role: 'Reviewer', task: 'a3', position: { x: 100, y: -140 } },
        ],
        edges: [
            { id: 'edge:head-one', source: 'acp/devin-cli/head-a', target: 'chat-one' },
            { id: 'edge:one-two', source: 'chat-one', target: 'chat-two' },
        ],
    });
    const schemaB = roster.saveSchema(root, 'Schema-B', {
        version: 1,
        name: 'Schema-B',
        entrySessionId: 'acp/devin-cli/head-a',
        nodes: [
            { sessionId: 'acp/devin-cli/head-a', role: 'Orchestrateur', task: 'b1', position: { x: 0, y: 0 } },
            { sessionId: 'chat-one', role: 'Codeur', task: 'b2', position: { x: 300, y: 80 } },
        ],
        edges: [
            { id: 'edge:b-head-one', source: 'acp/devin-cli/head-a', target: 'chat-one' },
        ],
    });

    // Charge Schema-A et déplace les blocs sans clic manuel sur "Sauvegarder le schéma"
    const loadedA = roster.loadSchema(root, schemaA.id);
    loadedA.nodes[0].position = { x: -660, y: -308 };
    loadedA.nodes[1].position = { x: -176, y: 242 };
    loadedA.nodes[2].position = { x: 484, y: -88 };
    roster.saveWorkflow(root, loadedA);

    // Simule l'ouverture du workspace depuis une autre session Devin active
    roster.upsertCoreAgent(root, 'devin', {
        providerId: 'devin-cli',
        sessionId: 'acp/devin-cli/other-tab',
        role: 'Devin',
        title: 'other-tab',
    });

    // Bascule sur Schema-B puis revient sur Schema-A
    const loadedB = roster.loadSchema(root, schemaB.id);
    assert.deepEqual(loadedB.nodes.map((n) => n.position), [
        { x: 0, y: 0 },
        { x: 300, y: 80 },
    ]);

    const reloadedA = roster.loadSchema(root, schemaA.id);
    const syncedA = roster.syncRosterWorkflow(root, []);
    assert.equal(syncedA.nodes.length, 3);
    assert.deepEqual(reloadedA.nodes.map((n) => n.position), [
        { x: -660, y: -308 },
        { x: -176, y: 242 },
        { x: 484, y: -88 },
    ]);
    assert.deepEqual(syncedA.nodes.map((n) => n.position), [
        { x: -660, y: -308 },
        { x: -176, y: 242 },
        { x: 484, y: -88 },
    ]);
    assert.equal(syncedA.edges.length, 2);
});

test('workflow positions survive a workspace reload without chat history', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Codeur', providerId: 'openrouter' });
    const graph = roster.syncRosterWorkflow(root, []);
    graph.nodes[0].position = { x: 936, y: 312 };
    roster.saveWorkflow(root, graph);

    const reloaded = roster.readWorkflow(root);

    assert.deepEqual(reloaded.nodes[0].position, { x: 936, y: 312 });
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

test('workflow roster persists cycles and removes links with a member', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Devin' });
    roster.upsertChatAgent(root, { sessionId: 'chat-two', model: 'model-b', role: 'Reviewer' });
    roster.connectWorkflowAgents(root, 'chat-one', 'chat-two');

    // Boucle autorisée au stockage : le lancement auto (workflowOrder) la
    // refusera toujours, mais le graphe de l'utilisateur persiste.
    const cyclic = roster.connectWorkflowAgents(root, 'chat-two', 'chat-one');
    assert.equal(cyclic.edges.length, 2);

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

test('createEmptySchema creates an active empty canvas that roster sync does not repopulate', () => {
    const root = makeRosterRoot();
    roster.upsertChatAgent(root, { sessionId: 'chat-one', model: 'model-a', role: 'Codeur', providerId: 'omniroute' });
    roster.syncRosterWorkflow(root, [{ id: 'chat-one', model: 'model-a' }]);

    const created = roster.createEmptySchema(root, 'Mon flux vide');
    assert.equal(created.name, 'Mon flux vide');
    assert.equal(created.nodes.length, 0);
    assert.equal(created.edges.length, 0);
    assert.equal(created.activeSchema, 'Mon flux vide');
    assert.ok(created.activeSchemaId);

    // Le schéma vide reste vide après sync : aucun repeuplement roster.
    const synced = roster.syncRosterWorkflow(root, [{ id: 'chat-one', model: 'model-a' }]);
    assert.equal(synced.nodes.length, 0);
    assert.equal(synced.activeSchema, 'Mon flux vide');

    // Nom dupliqué -> suffixe automatique
    const again = roster.createEmptySchema(root, 'Mon flux vide');
    assert.equal(again.name, 'Mon flux vide 2');
});

test('standard schemas are flagged builtin and restorable from kit templates', () => {
    const root = makeRosterRoot();
    // Gabarit canonique dans .agent/templates/schemas/ du workspace
    const templateDir = path.join(root, '.agent', 'templates', 'schemas');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'swat-code-review.json'), JSON.stringify({
        name: 'swat-code-review',
        graph: {
            version: 1,
            name: 'swat-code-review',
            entrySessionId: 'chat-rev',
            nodes: [
                { sessionId: 'chat-rev', role: 'Reviewer', task: 'audit', position: { x: 0, y: 0 } },
                { sessionId: 'chat-beacon', role: 'Beacon', task: 'learn', position: { x: 300, y: 0 } },
            ],
            edges: [{ id: 'edge:r->b', source: 'chat-rev', target: 'chat-beacon' }],
        },
    }));

    const entry = roster.saveSchema(root, 'swat-code-review', {
        version: 1,
        name: 'swat-code-review',
        entrySessionId: 'chat-rev',
        nodes: [
            { sessionId: 'chat-rev', role: 'Reviewer', task: 'audit', position: { x: 0, y: 0 } },
            { sessionId: 'chat-beacon', role: 'Beacon', task: 'learn', position: { x: 300, y: 0 } },
        ],
        edges: [{ id: 'edge:r->b', source: 'chat-rev', target: 'chat-beacon' }],
    });
    const userSchema = roster.saveSchema(root, 'flux-perso', {
        version: 1,
        name: 'flux-perso',
        entrySessionId: 'chat-rev',
        nodes: [{ sessionId: 'chat-rev', role: 'Solo', task: '', position: { x: 0, y: 0 } }],
        edges: [],
    });

    const listed = roster.listSchemas(root, false);
    assert.equal(listed.find((s) => s.name === 'swat-code-review').builtin, true);
    assert.equal(listed.find((s) => s.name === 'flux-perso').builtin, false);

    // Schéma standard protégé : suppression refusée, l'entrée reste listée.
    // NB : saveSchema renomme les noms standards en « (copie) » — entry.id
    // désigne donc la copie utilisateur ; le builtin est l'entrée auto-restaurée.
    const builtin = listed.find((s) => s.name === 'swat-code-review');
    const refused = roster.deleteSchema(root, builtin.id);
    assert.equal(refused.protected, true);
    assert.equal(roster.listSchemas(root, false).some((s) => s.name === 'swat-code-review'), true);

    // Auto-guérison : un graphe standard divergent du gabarit est réparé.
    const store = JSON.parse(fs.readFileSync(process.env.HEPHAISTOS_SCHEMA_FILE, 'utf8'));
    const idx = store.schemas.findIndex((s) => s.id === builtin.id);
    store.schemas[idx].graph.nodes = store.schemas[idx].graph.nodes.slice(0, 1);
    fs.writeFileSync(process.env.HEPHAISTOS_SCHEMA_FILE, JSON.stringify(store));
    const restored = roster.restoreStandardSchemas(root);
    assert.deepEqual(restored.restored, ['swat-code-review (repare)']);
    const back = roster.listSchemas(root, false).find((s) => s.name === 'swat-code-review');
    assert.equal(back.builtin, true);
    assert.equal(back.nodes, 2);

    // Schéma utilisateur : suppression définitive, non restaurable
    roster.deleteSchema(root, userSchema.id);
    const again = roster.restoreStandardSchemas(root);
    assert.deepEqual(again.restored, []);
    assert.equal(roster.listSchemas(root, false).some((s) => s.name === 'flux-perso'), false);
});

test('council mode is detected from schema name and propagated to the active workflow', () => {
    const root = makeRosterRoot();
    const created = roster.createEmptySchema(root, 'concil-experts');
    assert.equal(created.mode, 'council');
    const listed = roster.listSchemas(root, false).find((s) => s.name === 'concil-experts');
    assert.equal(listed.mode, 'council');

    // Le mode survit à un readWorkflow/validateWorkflow round-trip
    const workflow = roster.readWorkflow(root);
    assert.equal(workflow.mode, 'council');

    // Les schémas standards restent en mode DAG (pas de mode)
    const other = roster.createEmptySchema(root, 'flux-classique');
    assert.equal(other.mode, undefined);
    assert.equal(roster.listSchemas(root, false).find((s) => s.name === 'flux-classique').mode, undefined);
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
