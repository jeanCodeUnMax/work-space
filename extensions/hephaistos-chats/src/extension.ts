import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { acpDispose, acpDisposeAll, acpProfileModel } from './acpClient';
import { ChatPanel } from './chatPanel';
import { devinAcpConfig, devinAgentPreference } from './devinConfig';
import { ideAgentSessions, setDevinBridge } from './devinRoute';
import { FlowWorkspacePanel } from './flowWorkspacePanel';
import { HomeView } from './homeView';
import { OrchWsClient } from './orchWs';
import { callHpheTool, loadProviderFlags, pingModels, setProviderEnabled, setOrchTracker, setRemoteProviders } from './runtime';
import { SessionStore } from './sessionStore';
import { ACP_PROVIDERS, normalizeIconTheme } from './types';
import { createWorkflowView, WorkflowCatalog, WorkflowGraph, WorkflowView } from './workflow';
import { WorkflowRunner } from './workflowRunner';
import { WorkflowStore } from './workflowStore';

export function activate(context: vscode.ExtensionContext): void {
    const store = new SessionStore(context);
    let status = 'Initialisation...';
    let orchConnected = false;
    let orchStats = { agents: 0, tasks: 0 };
    let cachedModels: { provider: string; id: string }[] = [];

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let workflowStore: WorkflowStore | undefined;
    let workflowRunner: WorkflowRunner | undefined;
    if (workspaceRoot) {
        try {
            workflowStore = new WorkflowStore(workspaceRoot);
            workflowStore.load(store.list());
            workflowRunner = new WorkflowRunner(
                workspaceRoot,
                store,
                FlowWorkspacePanel.progress,
                FlowWorkspacePanel.finished,
            );
        } catch (error) {
            status = `Roster du workflow indisponible : ${String(error)}`;
        }
    }

    const orchWs = new OrchWsClient('ws://127.0.0.1:7477', workspaceRoot);
    setOrchTracker((p) => orchWs.trackRequest(p));
    setDevinBridge(orchWs);

    const home = new HomeView(context.extensionUri, (message) => { void onHomeMessage(message); });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HomeView.viewId, home, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('hephaistosChats.newChat', (provider?: string) => openNew(provider)),
        vscode.commands.registerCommand('hephaistosChats.openChat', () => openLatest()),
        vscode.commands.registerCommand('hephaistosChats.openWorkspace', () => openWorkspace()),
        vscode.window.registerWebviewPanelSerializer(ChatPanel.viewType, {
            async deserializeWebviewPanel(panel, state) {
                const sessionId = (state as { sessionId?: string } | undefined)?.sessionId;
                const session = sessionId ? store.get(sessionId) : undefined;
                // Restaure les fenetres telles qu'au depart (flottantes incluses),
                // mais jamais de zombies : seuls les agents visibles du roster/
                // graphe actif reviennent. Les autres panels sont detruits.
                let legit = !!session;
                if (session && workflowStore) {
                    try {
                        legit = workflowStore.load(store.list()).nodes
                            .some((node) => node.sessionId === sessionId);
                    } catch { legit = true; }
                }
                if (!sessionId || !legit) {
                    panel.dispose();
                    return;
                }
                // webview.options est reassignable au deserialize (SDK) :
                // sans ca, les panels restaures perdent scripts + media roots -> fenetres noires.
                panel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
                };
                ChatPanel.revive(panel, context, store, sessionId, () => { void paint(); });
            },
        }),
        {
            dispose: () => { orchWs.dispose(); }
        }
    );

    // Connexion WebSocket vers l'orchestrateur (port 7477)
    orchWs.on('connected', () => {
        orchConnected = true;
        status = 'Connecté à l\'orchestrateur Hephaistos';
        // Ne publier que les états CONNUS : flags Devin + choix utilisateur local.
        // Un provider inconnu (Devin illisible/absent) n'est jamais repoussé en
        // false — sinon une config vide écrirait 'false' partout dans la DB.
        const devin = devinAcpConfig().enabledAgents;
        const local = context.workspaceState.get<Record<string, boolean>>('hephaistosChats.providers', {});
        const known = new Map<string, boolean>();
        for (const [id, on] of Object.entries(devin)) known.set(id, !!on);
        for (const [id, on] of Object.entries(local)) known.set(id, !!on);
        for (const [id, on] of known) {
            orchWs.toggleProvider(id, on);
        }
        void paint();
    });

    orchWs.on('disconnected', () => {
        orchConnected = false;
        status = 'Orchestrateur déconnecté (en attente du bridge)';
        void paint();
    });

    // Réouverture d'une fenêtre existante via le bus (ex. après crash IDE) —
    // jamais de doublon : ChatPanel.open révèle le panel s'il existe déjà.
    orchWs.on('message', (data: any) => {
        if (data?.type === 'open_chat' && typeof data.sessionId === 'string') {
            openSession(data.sessionId);
        }
    });

    orchWs.on('snapshot', (snapshot) => {
        orchConnected = true;
        setRemoteProviders(snapshot.providers);
        const agentsCount = Array.isArray(snapshot.agents) ? snapshot.agents.length : 0;
        const tasksCount = Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0;
        orchStats = { agents: agentsCount, tasks: tasksCount };
        status = `Orchestrateur synchronisé (${agentsCount} agents, ${tasksCount} tâches)`;
        void paint();
    });

    orchWs.connect();

    // Watcher : les écritures externes (acp-server / agents) dans sessions.json
    // sont reflétées en direct dans les fenêtres ouvertes et la vue Home.
    const sessionsFile = store.getSessionsFilePath();
    if (sessionsFile) {
        let watchTimer: NodeJS.Timeout | undefined;
        const watcher = fs.watch(sessionsFile, () => {
            if (watchTimer) clearTimeout(watchTimer);
            watchTimer = setTimeout(() => {
                if (store.reloadFromDisk()) {
                    ChatPanel.refreshOpen(store);
                    void paint();
                }
            }, 300);
        });
        context.subscriptions.push({ dispose: () => watcher.close() });
    }
    if (workspaceRoot && workflowStore) {
        const rosterFile = path.join(workspaceRoot, '.agent', 'workspace-roster.json');
        if (fs.existsSync(rosterFile)) {
            let rosterTimer: NodeJS.Timeout | undefined;
            let lastRosterHash = '';
            const rosterWatcher = fs.watch(rosterFile, () => {
                if (rosterTimer) clearTimeout(rosterTimer);
                rosterTimer = setTimeout(() => {
                    // Dedup contenu : syncRosterWorkflow reecrit parfois le
                    // roster de facon identique -> sans hash, watch->load->
                    // write->watch boucle en CPU et ralentit l'IDE.
                    try {
                        const content = fs.readFileSync(rosterFile, 'utf8');
                        const hash = require('crypto').createHash('sha1').update(content).digest('hex');
                        if (hash === lastRosterHash) return;
                        lastRosterHash = hash;
                    } catch { return; }
                    void paint();
                    // Roster modifié en dehors de l'UI (CLI workspace-roster.js,
                    // agent externe) : repousser l'état au canvas — sinon le
                    // graphe affiché diverge de la vérité jusqu'au prochain reload.
                    try {
                        FlowWorkspacePanel.update(view(workflowStore.load(store.list())));
                    } catch { /* store pas prêt */ }
                }, 250);
            });
            context.subscriptions.push({ dispose: () => rosterWatcher.close() });
    if (workflowStore) {
        const schemasFile = path.join((process.env.USERPROFILE || require('os').homedir()), '.hephaistos-workflow-schemas.json');
        if (fs.existsSync(schemasFile)) {
            let schemaTimer: NodeJS.Timeout | undefined;
            const schemaWatcher = fs.watch(schemasFile, () => {
                if (schemaTimer) clearTimeout(schemaTimer);
                schemaTimer = setTimeout(() => {
                    try { FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(false) }); } catch { /* ignore */ }
                }, 250);
            });
            context.subscriptions.push({ dispose: () => schemaWatcher.close() });
        }
    }
        }
    }

    // Dev : le bundle du canvas est reconstruit par `watch:workspace` sans
    // toucher l'extension host — le panneau ouvert se recharge à chaud.
    const webviewOutDir = path.join(context.extensionPath, 'out', 'webview');
    if (fs.existsSync(webviewOutDir)) {
        let assetTimer: NodeJS.Timeout | undefined;
        const assetWatcher = fs.watch(webviewOutDir, () => {
            if (assetTimer) clearTimeout(assetTimer);
            assetTimer = setTimeout(() => FlowWorkspacePanel.reload(), 300);
        });
        context.subscriptions.push({ dispose: () => assetWatcher.close() });
    }
    // Le code de l'extension (out/*.js) ne se hot-swappe pas : proposer le
    // rechargement plutôt qu'attendre le Ctrl+Shift+P manuel.
    const extOutDir = path.join(context.extensionPath, 'out');
    if (fs.existsSync(extOutDir)) {
        let reloadTimer: NodeJS.Timeout | undefined;
        const outWatcher = fs.watch(extOutDir, (_event, filename) => {
            if (!filename || !filename.endsWith('.js')) return;
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
                void vscode.window.showInformationMessage(
                    'Hephaistos Chats : code extension recompilé. Recharger la fenêtre pour appliquer ?',
                    'Recharger',
                ).then((choice) => {
                    if (choice === 'Recharger') void vscode.commands.executeCommand('workbench.action.reloadWindow');
                });
            }, 800);
        });
        context.subscriptions.push({ dispose: () => outWatcher.close() });
    }

    void paint();
    void refreshModels();
    void vscode.commands.executeCommand('hephaistosChats.list.focus');

    async function refreshModels(): Promise<void> {
        try {
            const providers = loadProviderFlags(context, orchWs.lastSnapshot?.providers);
            const enabled = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
            cachedModels = await pingModels(enabled);
            status = `${cachedModels.length} modèles disponibles`;
            await paint();
        } catch (error: any) {
            status = error?.message || 'Erreur lors de la détection des modèles';
            await paint();
        }
    }

    async function paint(): Promise<void> {
        const providers = loadProviderFlags(context, orchWs.lastSnapshot?.providers);
        const sessions = store.list();
        home.show({
            sessions,
            providers,
            status,
            orchConnected,
            orchStats,
        });
        if (workflowStore) {
            try {
                const graph = workflowStore.load(sessions);
                FlowWorkspacePanel.update(view(graph));
            } catch (error) {
                status = `Erreur workflow : ${String(error)}`;
            }
        }
    }

    function defaultModelForProvider(provider: string): string {
        // 1. Préférence Devin (devin.acp.agentPreferences) — l'agent garde son modèle IDE
        const pref = devinAgentPreference(provider).model;
        if (pref) return pref;

        // 2. Modèle configuré dans le profil OPENCODE_CONFIG (providers routés)
        const fromProfile = acpProfileModel(provider);
        if (fromProfile) return fromProfile;

        // 3. Modèle syncé disponible pour CE provider
        const matching = cachedModels.filter((m) => m.provider === provider);
        if (matching.length > 0) {
            const preferred = matching.find((m) => /yi-large|deepseek|llama|instruct|qwen|nemotron|gemini|mistral|devstral/i.test(m.id));
            return preferred ? preferred.id : matching[0].id;
        }

        // 4. Défauts par provider — jamais un modèle d'un autre provider
        switch (provider) {
            case 'nim':
            case 'nim2':
            case 'kilo':
                return 'nvidia/nemotron-3-super-120b-a12b';
            case 'ollama':
                return 'qwen3.5:4b';
            case 'ollama-cloud':
                return 'gpt-oss:120b-cloud';
            case 'hermes':
                return 'gpt-oss:120b-cloud';
            case 'antigravity-acp':
                return 'gemini-3.8-flash-high';
            case 'mistral-vibe':
                return 'mistral-medium-3.5';
            case 'gemini':
                return 'auto';
            case 'codex-acp':
                return 'gpt-6-astra[medium]';
            case 'openrouter':
                return 'liquid/lfm-2.5-2.6b:free';
            case 'omniroute':
                return 'groq/openai/gpt-oss-120b';
            case 'devin-cli':
                return 'swe-2-high';
            default:
                return provider;
        }
    }

    function openNew(targetProvider?: string, targetRole?: string): void {
        const provider = targetProvider || 'openrouter';
        const model = defaultModelForProvider(provider);
        const session = store.create(provider, model);
        try {
            workflowStore?.upsertSession(session);
            // Rôle demandé (puce palette déposée sur le canvas) : l'assigner
            // au nœud fraîchement créé — sinon il garde le rôle par défaut.
            if (targetRole && workflowStore) {
                const graph = workflowStore.load(store.list());
                const node = graph.nodes.find((n) => n.sessionId === session.id);
                if (node) {
                    node.role = targetRole;
                    workflowStore.save(graph);
                }
            }
        } catch (error) {
            status = `Agent non ajouté au roster : ${String(error)}`;
        }
        ChatPanel.open(context, store, session.id, () => { void paint(); });
        void paint();
    }

    // Rouvrir une session existante la réintègre au roster : sinon un agent
    // retiré du workspace n'a aucun chemin de retour (la session existe
    // toujours dans sessions.json, seule l'appartenance manque).
    // Sessions ACP (acp/devin-cli/<slug>, acp/<provider>/<id>) : pas de
    // sessions.json, elles vivent dans les conversations de l'IDE. On révèle
    // l'onglet cascade existant — même URI = même onglet, jamais de doublon.
    async function openAcpSession(sessionId: string): Promise<void> {
        const cascadeUri = `vscode-cascade-editor:///cascade-${sessionId}`;
        try {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(cascadeUri), { preview: false });
            return;
        } catch { /* onglet absent → panneau chat */ }
        try {
            await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                actionType: 'openCascadeIdInChatPanel',
                payload: [Buffer.from(sessionId, 'utf8').toString('base64')],
            }));
        } catch { /* session introuvable côté IDE */ }
    }

    function openSession(sessionId: string): void {
        const session = store.get(sessionId);
        if (!session) {
            if (sessionId.startsWith('acp/')) void openAcpSession(sessionId);
            return;
        }
        try {
            workflowStore?.upsertSession(session);
        } catch (error) {
            status = `Agent non réintégré au roster : ${String(error)}`;
        }
        ChatPanel.open(context, store, session.id, () => { void paint(); });
        void paint();
    }

    function openLatest(): void {
        const latest = store.list()[0];
        if (latest) {
            openSession(latest.id);
            return;
        }
        openNew();
    }

    async function onHomeMessage(message: { type: string; id?: string; enabled?: boolean; provider?: string }): Promise<void> {
        if (message.type === 'open_workspace') {
            openWorkspace();
            return;
        }
        if (message.type === 'new') {
            openNew(message.provider);
            return;
        }
        if (message.type === 'open' && message.id) {
            openSession(message.id);
            return;
        }
        if (message.type === 'delete' && message.id) {
            // Tue la connexion ACP du chat supprimé — sans ça le processus
            // de l'agent survivrait jusqu'au prochain refresh du watcher.
            acpDispose(message.id);
            store.delete(message.id);
            try {
                workflowStore?.removeSession(message.id);
                void callHpheTool('update_agent', { agent_name: message.id, active: 0 }).catch(() => undefined);
            } catch (error) {
                status = `Agent retiré du chat, roster non synchronisé : ${String(error)}`;
            }
            ChatPanel.refreshOpen(store);
            await paint();
            return;
        }
        if (message.type === 'provider' && message.id) {
            await setProviderEnabled(context, message.id, !!message.enabled);
            // Synchro directe avec le WebSocket de l'orchestrateur
            orchWs.toggleProvider(message.id, !!message.enabled);
            status = message.enabled ? `${message.id} activé` : `${message.id} désactivé`;
            await paint();
            return;
        }
        if (message.type === 'ping') {
            status = 'Interrogation des modèles et de l\'orchestrateur…';
            await paint();
            orchWs.refresh();
            await refreshModels();
        }
    }

    function workflowCatalog(): WorkflowCatalog {
        const skillsDir = workspaceRoot ? path.join(workspaceRoot, '.agent', 'skills') : '';
        let skills: string[] = [];
        try {
            skills = fs.readdirSync(skillsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
        } catch { /* pas de dossier skills */ }
        return {
            roles: ['Devin', 'Antigravity', 'Codeur', 'Reviewer', 'Documentaliste', 'Testeur', 'Chercheur', 'Architecte', 'DevOps'],
            skills,
            providers: ACP_PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label })),
        };
    }

    function view(graph: WorkflowGraph): WorkflowView {
        return { ...createWorkflowView(graph, store.list()), catalog: workflowCatalog() };
    }

    async function openWorkspace(): Promise<void> {
        if (!workflowStore) {
            void vscode.window.showErrorMessage('Ouvre un workspace Hephaistos pour utiliser le roster de workflow.');
            return;
        }
        // Agent de tête = fenêtre IDE active au clic (Devin d'abord, Antigravity sinon).
        if (workspaceRoot) {
            try {
                for (const providerId of ['devin-cli', 'antigravity-acp']) {
                    const ideSessions = await ideAgentSessions(providerId, workspaceRoot);
                    const focused = ideSessions.find((s) => s.focused) || ideSessions[0];
                    if (focused?.sessionId) {
                        workflowStore.upsertCoreAgent('devin', {
                            providerId,
                            sessionId: focused.sessionId,
                            title: focused.title,
                            role: providerId === 'devin-cli' ? 'Devin' : 'Antigravity',
                        });
                        break;
                    }
                }
            } catch (error) {
                status = `Agent IDE actif non détecté : ${String(error)}`;
            }
        }
        const sessions = store.list();
        try {
            const graph = workflowStore.load(sessions);
            FlowWorkspacePanel.setIconTheme(normalizeIconTheme(context.workspaceState.get('hephaistosChats.iconTheme')));
            FlowWorkspacePanel.open(context, view(graph), (message) => {
                void onWorkflowMessage(message);
            });
            for (const node of graph.nodes) {
                if (node.sessionId.startsWith('chat-')) {
                    try {
                        openSession(node.sessionId);
                    } catch { /* session indisponible */ }
                }
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`Impossible d'ouvrir le workflow : ${String(error)}`);
        }
    }

    async function onWorkflowMessage(message: {
        type: string;
        graph?: WorkflowGraph;
        sessionId?: string;
    }): Promise<void> {
        if (!workflowStore) return;

        if (message.type === 'workflow_change' && message.graph) {
            try {
                const sessionsById = new Map(store.list().map((session) => [session.id, session]));
                for (const node of message.graph.nodes) {
                    const session = sessionsById.get(node.sessionId);
                    if (!session && !node.sessionId.startsWith('acp/') && !node.sessionId.startsWith('local-')) {
                        throw new Error(`Session absente du workspace: ${node.sessionId}`);
                    }
                    if (session && session.workspace && workspaceRoot && session.workspace !== workspaceRoot) {
                        throw new Error(`Session hors workspace refusée: ${node.sessionId}`);
                    }
                }
                const graph = workflowStore.save(message.graph);
                FlowWorkspacePanel.update(view(graph));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'add_agent' && typeof (message as { provider?: string }).provider === 'string') {
            openNew((message as { provider?: string }).provider, (message as { role?: string }).role);
            return;
        }

        if (message.type === 'hide_agent' && message.sessionId) {
            try {
                FlowWorkspacePanel.update(view(workflowStore.setHidden(message.sessionId, true, store.list())));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'unhide_agent' && message.sessionId) {
            try {
                FlowWorkspacePanel.update(view(workflowStore.setHidden(message.sessionId, false, store.list())));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schemas_list') {
            FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
            return;
        }

        if (message.type === 'schema_save') {
            try {
                workflowStore.saveSchema(String((message as { name?: string }).name || 'Schema'), workflowStore.load(store.list()));
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_load') {
            try {
                FlowWorkspacePanel.update(view(workflowStore.loadSchema(String((message as { id?: string }).id || ''))));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_delete') {
            try {
                workflowStore.deleteSchema(String((message as { id?: string }).id || ''));
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
                FlowWorkspacePanel.update(view(workflowStore.load(store.list())));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        // Thème d'icônes : persisté en workspaceState puis repoussé aux
        // webviews (canvas + chats ouverts) pour rebaser les URI media.
        if (message.type === 'set_icon_theme') {
            const theme = normalizeIconTheme((message as { theme?: string }).theme);
            await context.workspaceState.update('hephaistosChats.iconTheme', theme);
            FlowWorkspacePanel.setIconTheme(theme);
            ChatPanel.refreshIcons(context);
            return;
        }

        if (message.type === 'open_agent' && message.sessionId) {
            openSession(message.sessionId);
            return;
        }

        if (message.type === 'remove_agent' && message.sessionId) {
            try {
                if (!workflowStore.load(store.list()).nodes.some((node) => node.sessionId === message.sessionId)) {
                    throw new Error(`Agent absent du workflow: ${message.sessionId}`);
                }
                const graph = workflowStore.removeSession(message.sessionId);
                void callHpheTool('update_agent', { agent_name: message.sessionId, active: 0 }).catch(() => undefined);
                FlowWorkspacePanel.update(view(graph));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'run_workflow' && message.sessionId) {
            if (!workflowRunner) {
                FlowWorkspacePanel.error('Le runner ACP n’est pas disponible dans ce workspace.');
                return;
            }
            try {
                const graph = workflowStore.load(store.list());
                const enabledProviders = new Set(
                    loadProviderFlags(context, orchWs.lastSnapshot?.providers)
                        .filter((provider) => provider.enabled)
                        .map((provider) => provider.id),
                );
                await workflowRunner.run(graph, message.sessionId, enabledProviders);
            } catch (error) {
                FlowWorkspacePanel.error(error instanceof Error ? error.message : String(error));
            }
        }
    }
}

export function deactivate(): void {
    acpDisposeAll();
}
