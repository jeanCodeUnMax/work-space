import * as fs from 'fs';
import * as vscode from 'vscode';
import { acpDispose, acpDisposeAll, acpProfileModel } from './acpClient';
import { ChatPanel } from './chatPanel';
import { devinAcpConfig, devinAgentPreference } from './devinConfig';
import { setDevinBridge } from './devinRoute';
import { FlowWorkspacePanel } from './flowWorkspacePanel';
import { HomeView } from './homeView';
import { OrchWsClient } from './orchWs';
import { callHpheTool, loadProviderFlags, pingModels, setProviderEnabled, setOrchTracker, setRemoteProviders } from './runtime';
import { SessionStore } from './sessionStore';
import { createWorkflowView, WorkflowGraph } from './workflow';
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
                if (!sessionId) {
                    panel.dispose();
                    return;
                }
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
            const session = store.get(data.sessionId);
            if (!session) return;
            ChatPanel.open(context, store, session.id, () => { void paint(); });
            void paint();
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
                FlowWorkspacePanel.update(createWorkflowView(graph, sessions));
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

    function openNew(targetProvider?: string, preserveFocus = false): void {
        const provider = targetProvider || 'openrouter';
        const model = defaultModelForProvider(provider);
        const session = store.create(provider, model);
        try {
            workflowStore?.upsertSession(session);
        } catch (error) {
            status = `Agent non ajouté au roster : ${String(error)}`;
        }
        const showOptions = preserveFocus
            ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
            : vscode.ViewColumn.Active;
        ChatPanel.open(context, store, session.id, () => { void paint(); }, showOptions);
        void paint();
    }

    function openLatest(): void {
        const latest = store.list()[0];
        if (latest) {
            ChatPanel.open(context, store, latest.id, () => { void paint(); });
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
            ChatPanel.open(context, store, message.id, () => { void paint(); });
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

    function openWorkspace(): void {
        if (!workflowStore) {
            void vscode.window.showErrorMessage('Ouvre un workspace Hephaistos pour utiliser le roster de workflow.');
            return;
        }
        const sessions = store.list();
        try {
            const graph = workflowStore.load(sessions);
            FlowWorkspacePanel.open(context, createWorkflowView(graph, sessions), (message) => {
                void onWorkflowMessage(message);
            });
        } catch (error) {
            void vscode.window.showErrorMessage(`Impossible d’ouvrir le workflow : ${String(error)}`);
        }
    }

    async function onWorkflowMessage(message: {
        type: string;
        graph?: WorkflowGraph;
        sessionId?: string;
        provider?: string;
    }): Promise<void> {
        if (!workflowStore) return;

        if (message.type === 'workflow_change' && message.graph) {
            try {
                const sessionsById = new Map(store.list().map((session) => [session.id, session]));
                for (const node of message.graph.nodes) {
                    const session = sessionsById.get(node.sessionId);
                    if (!session) throw new Error(`Session absente du workspace: ${node.sessionId}`);
                    if (session.workspace && workspaceRoot && session.workspace !== workspaceRoot) {
                        throw new Error(`Session hors workspace refusée: ${node.sessionId}`);
                    }
                }
                const graph = workflowStore.save(message.graph);
                FlowWorkspacePanel.update(createWorkflowView(graph, store.list()));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'create_agent') {
            if (message.provider !== 'devin-cli' && message.provider !== 'antigravity-acp') {
                FlowWorkspacePanel.error('Seuls les chats Devin et Antigravity sont proposés comme entrée par défaut.');
                return;
            }
            openNew(message.provider, true);
            return;
        }

        if (message.type === 'remove_agent' && message.sessionId) {
            try {
                if (!workflowStore.load(store.list()).nodes.some((node) => node.sessionId === message.sessionId)) {
                    throw new Error(`Agent absent du workflow: ${message.sessionId}`);
                }
                const graph = workflowStore.removeSession(message.sessionId);
                void callHpheTool('update_agent', { agent_name: message.sessionId, active: 0 }).catch(() => undefined);
                FlowWorkspacePanel.update(createWorkflowView(graph, store.list()));
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
