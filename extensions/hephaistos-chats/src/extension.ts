import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acpDispose, acpDisposeAll, acpProfileModel } from './acpClient';
import { ChatPanel } from './chatPanel';
import { devinAgentPreference } from './devinConfig';
import { ideAgentSessions, injectIdeAgentText, setDevinBridge } from './devinRoute';
import { FlowWorkspacePanel } from './flowWorkspacePanel';
import { HomeView } from './homeView';
import { OrchWsClient } from './orchWs';
import { callHpheTool, loadProviderFlags, pingModels, setOrchTracker, setRemoteProviders } from './runtime';
import { SessionStore } from './sessionStore';
import { ACP_PROVIDERS, ChatSession, normalizeIconTheme, sessionTitle } from './types';
import { createWorkflowView, defaultRoleForProvider, PaletteAgent, preferredEntrySession, WorkflowCatalog, WorkflowGraph, WorkflowView } from './workflow';
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
        vscode.commands.registerCommand('hephaistosChats.pointAgent', (sessionId?: string) => void pointAgent(sessionId)),
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

    function openSession(sessionId: string, restoreIfMissing = false): void {
        let session = store.get(sessionId);
        if (!session && restoreIfMissing && sessionId.startsWith('chat-') && workflowStore) {
            const profile = workflowStore.getAgentProfile(sessionId);
            if (profile) {
                // L'historique est un cache de conversation, pas l'identite du
                // bloc. Recréer une session vide conserve l'ID du schéma.
                session = store.restore(
                    sessionId,
                    profile.providerId === 'hephaistos' ? 'openrouter' : profile.providerId,
                    profile.model,
                    profile.title || profile.role,
                );
            }
        }
        if (!session) {
            if (sessionId.startsWith('acp/')) {
                // Le sessionId du schéma est souvent périmé : on résout la
                // session IDE live du provider (la fenêtre active, où
                // l'utilisateur écrit vraiment) avant d'ouvrir quoi que ce soit.
                void (async () => {
                    const providerId = sessionId.split('/')[1] || 'devin-cli';
                    let target = sessionId;
                    try {
                        const live = await ideAgentSessions(providerId, workspaceRoot || '');
                        const focused = live.find((s) => s.focused) || live[0];
                        if (focused?.sessionId) target = `acp/${providerId}/${focused.sessionId}`;
                    } catch { /* bridge indisponible : on tente l'ID brut */ }
                    void openAcpSession(target);
                })();
            }
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

    /**
     * Puce ⌖ : pointe un agent du flux vers l'agent référent (nœud d'entrée).
     * Ouvre la fenêtre du référent et pré-remplit sa saisie avec la référence
     * de l'agent pointé — l'utilisateur n'a plus qu'à dicter sa directive.
     * Le pointage est aussi journalisé sur .agent/comms.jsonl pour les
     * référents ACP (Devin/AGY) dont la saisie n'est pas pré-remplissable.
     */
    async function pointAgent(sessionId?: string): Promise<void> {
        if (!sessionId || !workflowStore) return;
        try {
            const graph = workflowStore.load(store.list());
            const referentId = preferredEntrySession(graph, store.list())
                || graph.nodes.find((node) => node.sessionId !== sessionId)?.sessionId;
            if (!referentId) return;
            const pointed = graph.nodes.find((node) => node.sessionId === sessionId);
            const label = pointed?.title || sessionId;
            const draft = `[Agent pointé : ${label} (${sessionId})${pointed?.role ? ` — ${pointed.role}` : ''}] `;
            const refSession = store.get(referentId);
            if (refSession || referentId.startsWith('chat-')) {
                if (workspaceRoot) {
                    try {
                        fs.appendFileSync(
                            path.join(workspaceRoot, '.agent', 'comms.jsonl'),
                            `${JSON.stringify({ src: 'chats', dst: referentId, kind: 'point', text: `Agent pointé : ${label} (${sessionId})`, at: new Date().toISOString() })}\n`,
                        );
                    } catch { /* bus indisponible */ }
                }
                openSession(referentId, true);
                ChatPanel.prefill(referentId, draft);
                return;
            }
            // Référent ACP (Devin / AGY) : le nœud du schéma peut être une
            // session périmée (ex. acp/devin-cli/ionian-helicopter) — on cible
            // la session IDE LIVE focalisée, où l'utilisateur écrit vraiment.
            const providerId = referentId.split('/')[1] || 'devin-cli';
            const wsRoot = workspaceRoot || '';
            let live: { sessionId: string; focused?: boolean }[] = [];
            if (wsRoot) {
                try {
                    live = await ideAgentSessions(providerId, wsRoot);
                    if (!live.length && providerId !== 'devin-cli') {
                        live = await ideAgentSessions('devin-cli', wsRoot);
                    }
                    if (!live.length) {
                        live = await ideAgentSessions('cascade', wsRoot);
                    }
                } catch { /* bridge indisponible */ }
            }
            const target = live.find((s) => s.focused)?.sessionId || live[0]?.sessionId || referentId;
            // Ne rouvrir l'onglet cascade QUE si la session n'etait pas
            // deja live : sinon vscode.open cree un doublon du chat.
            if (workspaceRoot) {
                try {
                    fs.appendFileSync(
                        path.join(workspaceRoot, '.agent', 'comms.jsonl'),
                        `${JSON.stringify({ src: 'chats', dst: target, kind: 'point', text: `Agent pointé : ${label} (${sessionId})`, at: new Date().toISOString() })}\n`,
                    );
                } catch { /* bus indisponible */ }
            }
            // Pas d'openAcpSession ici : la session cible est deja live
            // (l'utilisateur ecrit dedans) — vscode.open sur son URI cascade
            // ouvrirait le meme chat en doublon.
            // Draft direct dans le composer de CETTE fenetre : addCascadeInput
            // pose le texte en saisie, editable, jamais soumis. Pas de passage
            // par le bridge : wake_acp_agent est broadcaste a tous les IDE et
            // un monitor ancien repondrait en soumettant le message.
            const draftText = `⌖ ${draft.trim()} — directive pour cet agent : `;
            let sent = false;
            try {
                const encVarint = (n: number): number[] => {
                    const o: number[] = [];
                    while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
                    o.push(n);
                    return o;
                };
                const lenField = (no: number, d: Buffer) => Buffer.concat([
                    Buffer.from([(no << 3) | 2]), Buffer.from(encVarint(d.length)), d,
                ]);
                const payload = lenField(1, lenField(1, Buffer.from(draftText, 'utf8'))).toString('base64');
                await vscode.commands.executeCommand('devin.sendChatActionMessage',
                    JSON.stringify({ actionType: 'addCascadeInput', payload: [payload] }));
                sent = true;
                // Focaliser la fenêtre du référent : openCascadeIdInChatPanel
                // révèle le panneau live — pas de doublon (le doublon venait
                // de l'URI vscode-cascade-editor, pas de cette commande).
                try {
                    await vscode.commands.executeCommand('devin.sendChatActionMessage',
                        JSON.stringify({ actionType: 'openCascadeIdInChatPanel', payload: [Buffer.from(target, 'utf8').toString('base64')] }));
                } catch { /* fenêtre déjà visible ou commande absente */ }
            } catch { /* commande indisponible -> fallback */ }
            if (!sent) {
                sent = wsRoot ? await injectIdeAgentText(
                    providerId,
                    target,
                    draftText,
                    wsRoot,
                    { draft: true },
                ) : false;
            }
            if (!sent) {
                void vscode.env.clipboard.writeText(draft.trim());
                void vscode.window.showInformationMessage(
                    `Agent pointé : ${label} — référence copiée, colle-la dans le chat du référent.`,
                );
            }
        } catch (error) {
            status = `Pointage impossible : ${String(error)}`;
            void paint();
        }
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
        // Les toggles provider vivent dans orchestrator-monitor
        // (provider_prefs) — cette extension ne fait que les lire.
        if (message.type === 'ping') {
            status = 'Interrogation des modèles et de l\'orchestrateur…';
            await paint();
            orchWs.refresh();
            await refreshModels();
        }
    }

    function workflowCatalog(graph?: WorkflowGraph, sessions?: ChatSession[]): WorkflowCatalog {
        const skillsDir = workspaceRoot ? path.join(workspaceRoot, '.agent', 'skills') : '';
        let skills: string[] = [];
        try {
            skills = fs.readdirSync(skillsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch { /* pas de dossier skills */ }
        const skillSet = new Set(skills);
        // Registre central skill-mux : tous les skills de la machine,
        // dedupliques (canonical > user > packs externes). Rafraichi par
        // .agent/skill-mux/registry-builder.mjs.
        try {
            const regPath = workspaceRoot ? path.join(workspaceRoot, '.agent', 'skill-registry.json') : '';
            const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            for (const s of reg.skills || []) skillSet.add(String(s.name));
        } catch { /* registre absent : sources directes ci-dessous */ }
        // Enrichit aussi depuis les catalogues de skills utilisateur et les
        // schemas sauvegardes : toutes les competences disponibles.
        for (const dir of [
            path.join(os.homedir(), '.agents', 'skills'),
            path.join(os.homedir(), '.claude', 'skills'),
        ]) {
            try {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (e.isDirectory()) skillSet.add(e.name);
                }
            } catch { /* absent */ }
        }
        try {
            const schemasRaw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hephaistos-workflow-schemas.json'), 'utf8'));
            for (const sch of schemasRaw.schemas || []) {
                for (const n of sch?.graph?.nodes || []) {
                    for (const s of n.skills || []) skillSet.add(String(s));
                }
            }
        } catch { /* banque absente */ }
        // Union avec les skills réellement portées par les blocs + roster :
        // les puces d'expertise des cartes (vulnerability-scanner,
        // database-design...) doivent toutes etre glissables, pas seulement
        // celles de .agent/skills.
        for (const n of graph?.nodes || []) {
            for (const s of n.skills || []) skillSet.add(String(s));
        }
        try {
            const rosterPath = workspaceRoot ? path.join(workspaceRoot, '.agent', 'workspace-roster.json') : '';
            const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
            for (const mems of Object.values(roster.core || {}) as { skills?: string[] }[][]) {
                for (const m of mems) for (const s of m.skills || []) skillSet.add(String(s));
            }
        } catch { /* roster absent */ }
        skills = [...skillSet].sort((a, b) => a.localeCompare(b, 'fr'));
        // Palette AGENTS : le referent (Devin live) + tous les agents connus
        // (noeuds du graphe avec leur role + sessions chat non placees) —
        // glissables sur un bloc pour l'editer ou sur le canvas pour creer.
        const nodeById = new Map((graph?.nodes || []).map((n) => [n.sessionId, n]));
        const agents: PaletteAgent[] = [];
        const entry = graph?.nodes.find((n) => n.sessionId === graph?.entrySessionId)
            || graph?.nodes.find((n) => n.sessionId.startsWith('acp/devin-cli/'));
        agents.push({
            sessionId: entry?.sessionId || 'acp/devin-cli/referent',
            title: entry?.title || 'Agent référent',
            role: entry?.role || 'Devin',
            provider: 'devin-cli',
            referent: true,
            placed: Boolean(entry),
        });
        // Palette AGENTS = vrais agents (fenêtres/sessions), jamais les
        // routeurs : un provider (nim, omniroute...) est un transport, pas un
        // agent. Le rôle affiché = rôle métier du bloc, sinon codename/Bleubite.
        const ROLE_JUNK = /^(openrouter|omniroute|devin-cli|antigravity-acp|opencode|hermes|kilo|kilo-code|nim2?|ollama|gemini|cli|local|cerberos|agent|unknown|cascade)$/i;
        const agentRole = (nodeRole: string | undefined, s?: ChatSession): string => {
            if (nodeRole && !ROLE_JUNK.test(nodeRole.trim())) return nodeRole;
            return (s?.codename && String(s.codename).trim()) || 'Bleubite';
        };
        for (const [sessionId, node] of nodeById) {
            if (agents.some((a) => a.sessionId === sessionId)) continue;
            const s = sessions?.find((item) => item.id === sessionId);
            agents.push({
                sessionId,
                title: node.title || (s ? sessionTitle(s) : sessionId.split('/').pop() || 'agent'),
                role: agentRole(node.role, s),
                provider: s?.provider || (sessionId.startsWith('acp/') ? sessionId.split('/')[1] : 'unknown'),
                model: s?.model,
                placed: true,
            });
        }
        for (const s of sessions || []) {
            if (nodeById.has(s.id) || agents.some((a) => a.sessionId === s.id)) continue;
            agents.push({
                sessionId: s.id,
                title: sessionTitle(s),
                role: agentRole(undefined, s),
                provider: s.provider,
                model: s.model,
            });
        }
        // Palette roles = les vrais roles metier du graphe + roster (puces
        // d'expertise des blocs), pas une liste statique.
        // Palette roles = les vraies specialisations des blocs (graphe +
        // roster + tous les schemas sauvegardes), providers exclus.
        const roleSet = new Set<string>();
        const pushRole = (r?: string) => { if (r && !ROLE_JUNK.test(r.trim())) roleSet.add(r.trim()); };
        for (const n of graph?.nodes || []) pushRole(n.role);
        try {
            const rosterPath = workspaceRoot ? path.join(workspaceRoot, '.agent', 'workspace-roster.json') : '';
            const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
            for (const mems of Object.values(roster.core || {}) as { role?: string }[][]) {
                for (const m of mems) pushRole(m.role);
            }
        } catch { /* roster absent */ }
        try {
            const schemasRaw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hephaistos-workflow-schemas.json'), 'utf8'));
            for (const sch of schemasRaw.schemas || []) {
                for (const n of sch?.graph?.nodes || []) pushRole(n.role);
            }
        } catch { /* banque absente */ }
        if (!roleSet.size) ['Devin', 'Orchestrateur', 'Codeur', 'Testeur', 'Reviewer'].forEach((r) => roleSet.add(r));
        const roles = [...roleSet].sort((a, b) => a.localeCompare(b, 'fr'));
        // Palette MCPS : les serveurs déclarés dans le broker mcp-mux —
        // glissables sur un bloc pour lui distribuer les outils du serveur.
        const mcps: string[] = [];
        try {
            const muxPath = path.join(os.homedir(), '.config', 'mcp-mux', 'mcp-mux.json');
            const mux = JSON.parse(fs.readFileSync(muxPath, 'utf8'));
            for (const [name, def] of Object.entries(mux.servers || {}) as [string, { disabled?: boolean }][]) {
                if (!def.disabled && name !== 'mcp-mux') mcps.push(name);
            }
        } catch { /* broker absent */ }
        mcps.sort((a, b) => a.localeCompare(b, 'fr'));
        return {
            roles,
            skills,
            mcps,
            providers: ACP_PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label })),
            agents,
        };
    }

    function view(graph: WorkflowGraph): WorkflowView {
        const sessions = store.list();
        return { ...createWorkflowView(graph, sessions), catalog: workflowCatalog(graph, sessions) };
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
                    // Ne pas throw : une session morte dans le graphe ne doit
                    // pas faire echouer la sauvegarde entiere (positions
                    // perdues). On logue et on continue.
                    if (!session && !node.sessionId.startsWith('acp/') && !node.sessionId.startsWith('local-')) {
                        console.warn('[workflow] session absente du store, noeud conserve:', node.sessionId);
                    }
                    if (session && session.workspace && workspaceRoot && session.workspace !== workspaceRoot) {
                        console.warn('[workflow] session hors workspace, noeud conserve:', node.sessionId);
                    }
                }
                const graph = workflowStore.save(message.graph);
                // Ne pas repousser workflow_state vers le webview émetteur :
                // le canvas possède déjà cet état exact et un écho asynchrone
                // écraserait un drag ou une saisie en cours.
                FlowWorkspacePanel.syncCache(view(graph));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'add_agent' && typeof (message as { provider?: string }).provider === 'string') {
            const agent = (message as { agent?: PaletteAgent }).agent;
            if (agent?.sessionId) {
                // Puce agent de la palette : ajoute le vrai agent (session
                // existante ou referent) au graphe, pas une session neuve.
                try {
                    const graph = workflowStore.load(store.list());
                    if (!graph.nodes.some((n) => n.sessionId === agent.sessionId)) {
                        const idx = graph.nodes.length;
                        graph.nodes.push({
                            sessionId: agent.sessionId,
                            role: agent.role || defaultRoleForProvider(agent.provider),
                            task: '',
                            skills: [],
                            title: agent.title,
                            position: { x: 120 + (idx % 4) * 260, y: 120 + Math.floor(idx / 4) * 160 },
                        });
                    }
                    FlowWorkspacePanel.update(view(workflowStore.save(graph)));
                } catch (error) {
                    FlowWorkspacePanel.error(String(error));
                }
                return;
            }
            openNew((message as { provider?: string }).provider, (message as { role?: string }).role);
            return;
        }

        if (message.type === 'assign_agent' && message.sessionId) {
            // Drop d'une puce agent sur un bloc : remplace l'identite du bloc
            // (session/titre/role), conserve tache + skills, remap les edges.
            try {
                const agent = (message as { agent?: PaletteAgent }).agent;
                if (!agent?.sessionId) return;
                const oldId = String(message.sessionId);
                const graph = workflowStore.load(store.list());
                const node = graph.nodes.find((n) => n.sessionId === oldId);
                if (!node || oldId === agent.sessionId) return;
                node.sessionId = agent.sessionId;
                node.title = agent.title;
                node.role = agent.role || node.role;
                for (const edge of graph.edges) {
                    if (edge.source === oldId) edge.source = agent.sessionId;
                    if (edge.target === oldId) edge.target = agent.sessionId;
                }
                if (graph.entrySessionId === oldId) graph.entrySessionId = agent.sessionId;
                FlowWorkspacePanel.update(view(workflowStore.save(graph)));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
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
                const graphToSave = message.graph ? workflowStore.save(message.graph) : workflowStore.load(store.list());
                workflowStore.saveSchema(String((message as { name?: string }).name || graphToSave.name || 'Schema'), graphToSave);
                const refreshed = workflowStore.load(store.list());
                FlowWorkspacePanel.syncCache(view(refreshed));
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_create') {
            try {
                const name = String((message as { name?: string }).name || '').trim() || 'Nouveau schema';
                FlowWorkspacePanel.update(view(workflowStore.createSchema(name)), true);
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schemas_restore') {
            try {
                const restored = workflowStore.restoreStandards();
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
                if (restored.length === 0) {
                    FlowWorkspacePanel.error('Tous les schémas standards sont déjà présents.');
                }
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_load') {
            try {
                FlowWorkspacePanel.update(view(workflowStore.loadSchema(String((message as { id?: string }).id || ''))), true);
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_rename') {
            try {
                const result = workflowStore.renameSchema(
                    String((message as { id?: string }).id || ''),
                    String((message as { name?: string }).name || ''),
                );
                if (result?.protected) {
                    FlowWorkspacePanel.error('Schéma standard — renommage refusé (gabarit canonique).');
                } else if (result?.renamed === false) {
                    FlowWorkspacePanel.error(`Renommage impossible : ${result.error || 'inconnu'}`);
                }
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'schema_update_standard') {
            try {
                const result = workflowStore.updateStandardSchema(
                    String((message as { id?: string }).id || ''),
                    workflowStore.load(store.list()),
                );
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(Boolean((message as { all?: boolean }).all)) });
                if (result?.updated === false) {
                    FlowWorkspacePanel.error(`Promotion impossible : ${result.error || 'inconnu'}`);
                }
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
            openSession(message.sessionId, true);
            return;
        }

        if (message.type === 'point_agent' && message.sessionId) {
            void pointAgent(message.sessionId);
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
                // Mode concile : ouvrir le transcript live (.agent/reports/concil-live.md)
                // dans un aperçu Markdown pour suivre la délibération en direct.
                if (graph.mode === 'council' && workspaceRoot) {
                    const liveReport = vscode.Uri.file(
                        path.join(workspaceRoot, '.agent', 'reports', 'concil-live.md'));
                    void vscode.commands.executeCommand('markdown.showPreviewToSide', liveReport)
                        .then(undefined, () => undefined);
                }
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
