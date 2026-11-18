import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acpDispose, acpDisposeAll, acpProfileModel } from './acpClient';
import { ChatPanel } from './chatPanel';
import { devinAgentPreference } from './devinConfig';
import { ideAgentSessions, injectIdeAgentText, setDevinBridge } from './devinRoute';
import { ComfyUIPanel } from './comfyuiPanel';
import { FlowWorkspacePanel } from './flowWorkspacePanel';
import { HomeView } from './homeView';
import { OrchWsClient } from './orchWs';
import { callHpheTool, loadProviderFlags, pingModels, setOrchTracker, setRemoteProviders } from './runtime';
import { SessionStore } from './sessionStore';
import { ACP_PROVIDERS, ChatSession, normalizeIconTheme, sessionTitle } from './types';
import { createWorkflowView, defaultRoleForProvider, focusedIdeSessionId, ideSessionChoices, PaletteAgent, preferredEntrySession, WorkflowCatalog, WorkflowGraph, WorkflowView } from './workflow';
import { WorkflowRunner } from './workflowRunner';
import { WorkflowStore } from './workflowStore';

/** Health-check court sur un port HTTP local. */
async function portUp(url: string, ms = 2500): Promise<boolean> {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        const r = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        return r.status > 0;
    } catch { return false; }
}

function spawnDetached(cmd: string, args: string[], cwd?: string, extraEnv?: NodeJS.ProcessEnv): void {
    const isScript = /\.(bat|cmd)$/i.test(cmd);
    const child = child_process.spawn(cmd, args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        // ELECTRON_RUN_AS_NODE : process.execPath pointe le binaire Electron de
        // l'IDE — sans ce flag, il ne peut pas exécuter les .mjs des proxies.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
        windowsHide: true,
        shell: isScript,
    });
    child.unref();
}

async function waitPort(url: string, tries = 40): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        if (await portUp(url)) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}

/** where.exe — premier binaire trouvé sur le PATH (ou null). */
function which(bin: string): string | null {
    try {
        const out = child_process.execFileSync('where.exe', [bin], { encoding: 'utf8', timeout: 5000 })
            .trim().split(/\r?\n/).filter(Boolean);
        return out[0] || null;
    } catch { return null; }
}

/**
 * ComfyUI — résolution portable, zéro chemin en dur :
 * 1. launcher `comfyui.cmd|bat` ou `run_nvidia_gpu.bat` sur le PATH
 *    (convention : %USERPROFILE%\.hephaistos\bin, répliquable par machine),
 * 2. COMFYUI_HOME explicite,
 * 3. emplacements classiques de la distrib portable (dernier recours).
 */
function resolveComfyUI(): { bat: string; cwd: string } | null {
    const exeEnv = process.env.COMFYUI_EXE;
    if (exeEnv && fs.existsSync(exeEnv)) return { bat: exeEnv, cwd: path.dirname(exeEnv) };
    for (const exe of [
        'F:\ComfyUi\ComfyUI\Comfy Desktop\Comfy Desktop.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Comfy Desktop', 'Comfy Desktop.exe'),
    ]) {
        if (fs.existsSync(exe)) return { bat: exe, cwd: path.dirname(exe) };
    }
    return null;
}

/**
 * n8n — résolution portable :
 * 1. N8N_NODE + N8N_BIN explicites,
 * 2. node sur le PATH + n8n via `npm root -g`,
 * 3. scan nvm (dernier node) + npm global classique.
 */
function resolveN8n(): { node: string; bin: string } | null {
    const envNode = process.env.N8N_NODE;
    const envBin = process.env.N8N_BIN;
    if (envNode && envBin && fs.existsSync(envNode) && fs.existsSync(envBin)) {
        return { node: envNode, bin: envBin };
    }
    const node = which('node.exe') || which('node');
    let n8nBin: string | null = envBin && fs.existsSync(envBin) ? envBin : null;
    if (!n8nBin) {
        try {
            const root = child_process.execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 8000, shell: true }).trim();
            const cand = path.join(root, 'n8n', 'bin', 'n8n');
            if (fs.existsSync(cand)) n8nBin = cand;
        } catch { /* npm absent du PATH */ }
    }
    if (!n8nBin) {
        const cand = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'n8n', 'bin', 'n8n');
        if (fs.existsSync(cand)) n8nBin = cand;
    }
    let nodeExe = node;
    if (!nodeExe) {
        const nvm = path.join(os.homedir(), 'AppData', 'Local', 'nvm');
        try {
            for (const v of fs.readdirSync(nvm).filter((d) => /^v\d+/.test(d)).sort().reverse()) {
                const exe = path.join(nvm, v, 'node.exe');
                if (fs.existsSync(exe)) { nodeExe = exe; break; }
            }
        } catch { /* pas de nvm */ }
    }
    return nodeExe && n8nBin ? { node: nodeExe, bin: n8nBin } : null;
}

/** Vrai si un processus dont la ligne de commande matche `match` est vivant. */
function processAlive(match: string): boolean {
    try {
        const out = child_process.execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { \\$_.CommandLine -match '${match}' -and \\$_.CommandLine -notmatch 'Get-CimInstance' }).Count"`,
            { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        return Number.parseInt(out.trim(), 10) > 0;
    } catch { return false; }
}

/**
 * Un seul démarrage en vol par service : les clics pendant le boot
 * (~60 s) réutilisent la promesse en cours au lieu de respawner.
 */
const serviceStarts = new Map<string, Promise<boolean>>();

async function ensureService(workspaceRoot: string, svc: string): Promise<boolean> {
    const pending = serviceStarts.get(svc);
    if (pending) return pending;
    const run = ensureServiceOnce(workspaceRoot, svc)
        .finally(() => { serviceStarts.delete(svc); });
    serviceStarts.set(svc, run);
    return run;
}

/** Racine de l'extension — renseignée par activate() pour les proxies internes. */
let extensionRoot = '';

/**
 * Chemin d'un proxy embarqué : <extension>/proxies/<name> d'abord (portable),
 * repli <workspace>/.agent/scripts/<name> (compat historique du kit).
 */
function proxyScript(workspaceRoot: string, name: string): string {
    if (extensionRoot) {
        const bundled = path.join(extensionRoot, 'proxies', name);
        if (fs.existsSync(bundled)) return bundled;
    }
    return path.join(workspaceRoot, '.agent', 'scripts', name);
}

/**
 * Auto-launch des services embarqués quand l'onglet est ouvert/rechargé :
 * comfyui → :8188, n8n → :5678 + proxy :5680, mail-api :5681.
 * Jamais de doublon : on ne spawn que si ni le port ni le processus ne répondent.
 */
async function ensureServiceOnce(workspaceRoot: string, svc: string): Promise<boolean> {
    if (svc === 'comfyui') {
        const comfyLocal = process.env.COMFYUI_LOCAL || 'http://127.0.0.1:8000';
        if (!(await portUp(comfyLocal))) {
        if (!processAlive('ComfyUI')) {
            const comfy = resolveComfyUI();
            if (!comfy) {
                FlowWorkspacePanel.error('ComfyUI introuvable : mets un launcher comfyui.cmd sur le PATH (%USERPROFILE%\\.hephaistos\\bin) ou définis COMFYUI_HOME.');
                return false;
            }
            spawnDetached(comfy.bat, [], comfy.cwd, { ...process.env, PYTHONUTF8: '1' });
        }
        if (!(await waitPort(comfyLocal, 60))) return false;
        }
        
        if (!(await portUp('http://127.0.0.1:8190'))) {
            const proxy = proxyScript(workspaceRoot, 'comfyui-proxy.mjs');
            if (fs.existsSync(proxy) && !processAlive('comfyui-proxy')) {
                const penv: Record<string, string> = {};
                for (const k of ['COMFYUI_LOCAL','COMFYUI_REMOTE','COMFYUI_PROXY_PORT']) { const v = process.env[k]; if (v) penv[k] = v; }
                spawnDetached(process.execPath, [proxy], workspaceRoot, penv);
            }
            if (!(await waitPort('http://127.0.0.1:8190', 20))) return false;
        }
        return true;
    }
    if (svc === 'n8n') {
        if (!(await portUp('http://127.0.0.1:5678'))) {
            if (!processAlive('bin[\\\\/]n8n')) {
                const n8n = resolveN8n();
                if (!n8n) {
                    FlowWorkspacePanel.error('n8n introuvable : installe-le en global (npm i -g n8n) ou définis N8N_NODE + N8N_BIN.');
                    return false;
                }
                const env = { ...process.env };
                delete env.N8N_ENCRYPTION_KEY;
                // `/api` est manglé en `C:/Program Files/Git/api` quand l'env
                // transite par Git Bash (MSYS path conversion) — on le supprime :
                // n8n retombe sur son défaut `/api`.
                delete env.N8N_PUBLIC_API_ENDPOINT;
                spawnDetached(n8n.node, [n8n.bin, 'start'], workspaceRoot, env);
            }
            // Premier boot n8n : migrations + licence peuvent dépasser 60 s.
            if (!(await waitPort('http://127.0.0.1:5678', 90))) return false;
        }
        if (!(await portUp('http://127.0.0.1:5680'))) {
            const proxy = proxyScript(workspaceRoot, 'n8n-auth-proxy.mjs');
            if (fs.existsSync(proxy) && !processAlive('n8n-auth-proxy')) {
                const proxyEnv: Record<string, string> = {};
                for (const k of ['N8N_EMAIL','N8N_PASSWORD','N8N_API_KEY']) { const v = process.env[k]; if (v) proxyEnv[k] = v; }
                spawnDetached(process.execPath, [proxy], workspaceRoot, proxyEnv);
            }
            if (!(await waitPort('http://127.0.0.1:5680', 20))) return false;
        }
        // mail-api (:5681) volontairement NON auto-lancé : config mail
        // personnelle de l'utilisateur, pas un service de l'extension. Le
        // script reste dispo dans .agent/scripts pour qui en a besoin.
        return true;
    }
    return true; // 'flow' : pas de service externe
}

/** Tue les processus qui écoutent un port local (pour restart réel). */
async function killPort(port: number): Promise<void> {
    const { execSync } = child_process;
    try {
        const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
        const pids = new Set<string>();
        for (const line of out.split(/\r?\n/)) {
            if (line.includes(`:${port}`) && line.includes('LISTENING')) {
                const pid = line.trim().split(/\s+/).pop();
                if (pid && /^\d+$/.test(pid)) pids.add(pid);
            }
        }
        for (const pid of pids) {
            try { execSync(`taskkill /F /PID ${pid} /T`); } catch { /* déjà mort */ }
        }
        await new Promise((r) => setTimeout(r, 1500));
    } catch { /* netstat indispo : on tente quand même le spawn */ }
}

async function restartService(workspaceRoot: string, svc: string): Promise<boolean> {
    if (svc === 'comfyui') await killPort(8188);
    if (svc === 'n8n') { await killPort(5678); await killPort(5680); }
    return ensureService(workspaceRoot, svc);
}

export function activate(context: vscode.ExtensionContext): void {
    extensionRoot = context.extensionPath;
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
        vscode.commands.registerCommand('hephaistosChats.openComfyUI', () => ComfyUIPanel.open(context)),
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
            openSession(data.sessionId, true);
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
    // sessions.json, elles vivent dans les conversations de l'IDE.
    // openCascadeIdInChatPanel révèle la conversation existante — jamais
    // vscode.open sur vscode-cascade-editor (onglet vide + crash IDE).
    // Le nœud d'entrée est résolu vers la session live du provider : le
    // référent du schéma = l'agent Devin actif, pas un ID persisté périmé.
    async function openAcpSession(sessionId: string, opts?: { isEntry?: boolean }): Promise<void> {
        let target = sessionId;
        const providerId = sessionId.split('/')[1] || 'devin-cli';
        if (providerId === 'antigravity-acp' || providerId === 'agy') {
            try {
                await vscode.commands.executeCommand('antigravity.panel.focus');
            } catch { /* ignore */ }
            return;
        }
        if (opts?.isEntry && workspaceRoot) {
            const providerId = sessionId.split('/')[1] || 'devin-cli';
            try {
                const live = await ideAgentSessions(providerId, workspaceRoot);
                const stillLive = live.some((s) => s.sessionId === sessionId
                    || s.sessionId === sessionId.split('/').pop());
                if (!stillLive && live.length) {
                    const focused = live.find((s) => s.focused) || live[0];
                    target = focused.sessionId;
                }
            } catch { /* bridge indisponible : cible inchangée */ }
        }
        try {
            await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                actionType: 'openCascadeIdInChatPanel',
                payload: [Buffer.from(target, 'utf8').toString('base64')],
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
                void (async () => {
                    const isEntry = workflowStore?.load(store.list()).entrySessionId === sessionId;
                    void openAcpSession(sessionId, { isEntry });
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

            // 1. Si la cible est Antigravity ou si nous sommes dans l'IDE Antigravity avec la commande disponible :
            if (providerId === 'antigravity-acp' || providerId === 'agy') {
                try {
                    const cmds = await vscode.commands.getCommands(true);
                    if (cmds.includes('antigravity.addContext')) {
                        await vscode.commands.executeCommand('antigravity.addContext', draftText);
                        sent = true;
                    }
                } catch { /* pas dans l'instance locale Antigravity */ }
            }

            // 2. Si la cible est Devin ou si nous sommes dans Devin avec sendChatActionMessage :
            if (!sent && (providerId === 'devin-cli' || !providerId)) {
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
            }

            // 3. Si l'action locale n'a pas pu s'appliquer (ex. inter-IDE via bridge ws), passer par injectIdeAgentText avec draft: true :
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
        // Cartes préconfigurées : .agent/cards/*.json, un fichier par carte.
        const cards: NonNullable<WorkflowCatalog['cards']> = [];
        try {
            const cardsDir = workspaceRoot ? path.join(workspaceRoot, '.agent', 'cards') : '';
            for (const f of fs.readdirSync(cardsDir).filter((n) => n.endsWith('.json')).sort()) {
                try { cards.push(JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8'))); } catch { /* carte invalide : ignorée */ }
            }
        } catch { /* pas de dossier cards */ }
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
            // Les blocs cartes vides (card-*) ne sont pas des agents : ils
            // vivent dans la palette CARTES, pas ici.
            if (sessionId.startsWith('card-')) continue;
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
        // Tri : référent en tête, puis les agents non placés (à ajouter),
        // puis ceux déjà sur le canvas — alphabétique dans chaque groupe.
        agents.sort((a, b) =>
            Number(b.referent || false) - Number(a.referent || false)
            || Number(a.placed || false) - Number(b.placed || false)
            || a.title.localeCompare(b.title, 'fr'));
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
            // Dropdown "+ Bloc" : types de blocs créables, pas les transports.
            // L'ordre est volontaire — Devin, AGY, Bleubite, puis les ServerOS.
            providers: [
                { id: 'devin-cli', label: 'Devin' },
                { id: 'antigravity-acp', label: 'Antigravity' },
                { id: 'bleubite', label: 'Bleubite' },
                { id: 'cerberos', label: 'Cerber — HeraldOS' },
                { id: 'd2r2', label: 'CerberOS — D2R2' },
            ],
            agents,
            cards,
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

        if (message.type === 'add_card') {
            // Carte préconfigurée (.agent/cards) : crée un bloc avec son rôle,
            // ses compétences et son provider. Sans session liée, le bloc reçoit
            // un identifiant de carte ; il sera rattaché à une fenêtre ensuite.
            const card = (message as { card?: { id?: string; kind?: string; title?: string; role?: string; provider?: string; sessionId?: string; skills?: string[]; mcps?: string[] } }).card;
            if (card?.id) {
                try {
                    const graph = workflowStore.load(store.list());
                    // Carte vide : sessionId generique card-* pour qu'elle reste
                    // un bloc en attente de liaison (bouton bind), jamais un bleubite.
                    const sessionId = `card-${card.id}-${Date.now().toString(36)}`;
                    if (!graph.nodes.some((n) => n.sessionId === sessionId)) {
                        const idx = graph.nodes.length;
                        graph.nodes.push({
                            sessionId,
                            role: card.role || card.title || card.id,
                            task: '',
                            skills: [...(card.skills || [])],
                            mcps: [...(card.mcps || [])],
                            title: card.title || card.id,
                            provider: card.provider || '',
                            cardKind: (card.kind as 'devin' | 'agy' | 'bleubite' | 'serveros') || 'bleubite',
                            position: { x: 120 + (idx % 4) * 260, y: 120 + Math.floor(idx / 4) * 160 },
                        });
                    }
                    FlowWorkspacePanel.update(view(workflowStore.save(graph)));
                } catch (error) {
                    FlowWorkspacePanel.error(String(error));
                }
            }
            return;
        }

        if (message.type === 'add_svc') {
            // Cartes service : bloc svc/<kind>/carte-<ts>. n8n se configure
            // ensuite dans le panneau (sessionId = svc/n8n/<workflowId>).
            const svc = (message as { svc?: { kind?: string } }).svc;
            const svcTypes: Record<string, { role: string; title: string; provider: string; task: string }> = {
                n8n: {
                    role: 'Service n8n', title: 'Service n8n (a configurer)', provider: 'n8n',
                    task: 'Decris ce que ce workflow fournit (contexte outil) ou execute (etape).',
                },
                comfyui: {
                    role: 'Service ComfyUI', title: 'Service ComfyUI', provider: 'comfyui',
                    task: 'Decris ce que ce service fournit (contexte outil) ou execute (etape).',
                },
            };
            const t = svc?.kind ? svcTypes[svc.kind] : undefined;
            if (t) {
                try {
                    const graph = workflowStore.load(store.list());
                    const sessionId = `svc/${svc!.kind}/carte-${Date.now().toString(36)}`;
                    const idx = graph.nodes.length;
                    graph.nodes.push({
                        sessionId,
                        role: t.role,
                        task: t.task,
                        skills: [],
                        title: t.title,
                        provider: t.provider,
                        position: { x: 120 + (idx % 4) * 260, y: 120 + Math.floor(idx / 4) * 160 },
                    });
                    FlowWorkspacePanel.update(view(workflowStore.save(graph)));
                } catch (error) {
                    FlowWorkspacePanel.error(String(error));
                }
            }
            return;
        }

        if (message.type === 'n8n_workflows') {
            // Inventaire live des workflows via la bridge :7478 — la clé reste
            // côté serveur, le webview ne fait que relire la liste.
            const token = (() => {
                try { return fs.readFileSync(path.join(workspaceRoot || '', '.agent', 'ws-bridge.token'), 'utf8').trim(); }
                catch { return ''; }
            })();
            void fetch('http://127.0.0.1:7478/n8n/workflows', {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(15000),
            })
                .then(async (r) => {
                    const data = await r.json().catch(() => ({})) as { workflows?: unknown[]; error?: string };
                    FlowWorkspacePanel.post({ type: 'n8n_workflows', workflows: data.workflows || [], error: data.error });
                })
                .catch((error) => {
                    FlowWorkspacePanel.post({ type: 'n8n_workflows', workflows: [], error: String(error) });
                });
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
            // Dropdown "+ Bloc" : crée un bloc VIDE du type choisi — jamais de
            // fenêtre chat (un openNew ici spawnait un bleubite fantôme). Le
            // bloc attend ensuite le bouton ⤓ pour être rattaché.
            const provider = String((message as { provider?: string }).provider || 'bleubite');
            const blockTypes: Record<string, { kind: 'devin' | 'agy' | 'bleubite' | 'serveros'; label: string; role: string }> = {
                'devin-cli': { kind: 'devin', label: 'Devin', role: 'Devin' },
                'antigravity-acp': { kind: 'agy', label: 'Antigravity', role: 'Antigravity' },
                'cerberos': { kind: 'serveros', label: 'Cerber — HeraldOS', role: 'Server OS' },
                'd2r2': { kind: 'serveros', label: 'CerberOS — D2R2', role: 'Server OS' },
            };
            const t = blockTypes[provider] || { kind: 'bleubite' as const, label: 'Bleubite', role: 'Bleubite' };
            try {
                const graph = workflowStore.load(store.list());
                const sessionId = `card-${provider}-${Date.now().toString(36)}`;
                const idx = graph.nodes.length;
                graph.nodes.push({
                    sessionId,
                    role: (message as { role?: string }).role || t.role,
                    task: '',
                    skills: [],
                    title: t.label,
                    provider,
                    cardKind: t.kind,
                    position: { x: 120 + (idx % 4) * 260, y: 120 + Math.floor(idx / 4) * 160 },
                });
                FlowWorkspacePanel.update(view(workflowStore.save(graph)));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
            return;
        }

        if (message.type === 'bind_active' && message.sessionId) {
            // Bouton ⤓ d'un bloc : rattache la fenêtre du BON type au bloc.
            // La carte décide de la cible — agy -> conversation Antigravity
            // live, devin -> session Devin ACP live — et PAS seulement la
            // fenêtre focalisée : sinon une carte AGY héritait du chat Devin
            // qui avait le focus (bug d'association croisée).
            try {
                const oldId = String(message.sessionId);
                const labels: Record<string, string> = { devin: 'Devin', agy: 'Antigravity', bleubite: 'Bleubite', serveros: 'Server OS' };
                const wsRoot = workspaceRoot || '';
                const graph = workflowStore.load(store.list());
                const node = graph.nodes.find((n) => n.sessionId === oldId);
                if (!node) return;
                // Le kind voulu : cardKind persisté, sinon le kind envoyé par le
                // webview, sinon déduit du provider/titre/role — les vieilles
                // cartes ont perdu cardKind+provider avant le fix et ne portent
                // plus que leur titre (« Antigravity », « Devin »…).
                const stored = (node as { cardKind?: 'devin' | 'agy' | 'bleubite' | 'serveros' }).cardKind;
                const hintOf = (...texts: (string | undefined)[]): 'devin' | 'agy' | 'bleubite' | 'serveros' | undefined => {
                    const t = texts.filter(Boolean).join(' ').toLowerCase();
                    if (/antigravity|\bagy\b/.test(t)) return 'agy';
                    if (/\bdevin\b/.test(t)) return 'devin';
                    if (/cerber|herald|d2r2|server/.test(t)) return 'serveros';
                    return undefined;
                };
                const want = (stored && stored !== 'bleubite' ? stored : undefined)
                    || hintOf((node as { provider?: string }).provider,
                        node.title, node.role,
                        (message as { kind?: string }).kind)
                    || stored;
                const acp = (await vscode.commands.executeCommand<any>('workbench.action.getAcpState'))?.reduxStore?.acp;
                const focused = String(acp?.focusedSessionId || '');
                // Le kind vient du provider de la fenêtre focalisée —
                // acp/<provider>/<id>. local-* = session HeraldOS (serveros).
                const kindOf = (id: string): 'devin' | 'agy' | 'bleubite' | 'serveros' => {
                    if (id.startsWith('acp/antigravity-acp/')) return 'agy';
                    if (id.startsWith('acp/devin-cli/')) return 'devin';
                    if (id.startsWith('acp/cerberos/') || id.startsWith('acp/d2r2/') || id.startsWith('local-')) return 'serveros';
                    if (id.startsWith('acp/')) return 'bleubite';
                    return 'devin';
                };
                const pickLive = async (providerId: string): Promise<string> => {
                    try {
                        const live = await ideAgentSessions(providerId, wsRoot);
                        return focusedIdeSessionId(providerId, live);
                    } catch { return ''; }
                };
                const pickIdeSession = async (providerId: string): Promise<string> => {
                    // La fenêtre active prime ; sinon proposer les conversations
                    // live plutôt que deviner une session persistée.
                    const focusedId = await pickLive(providerId);
                    if (focusedId) return focusedId;
                    const live = await ideAgentSessions(providerId, wsRoot);
                    const choices = ideSessionChoices(providerId, live);
                    if (!choices.length) return '';
                    if (choices.length === 1) return choices[0].sessionId;
                    const picked = await vscode.window.showQuickPick(
                        choices.map((session) => ({
                            label: session.title || session.sessionId.split('/').pop() || session.sessionId,
                            description: session.sessionId,
                            detail: session.focused ? 'Fenêtre active' : undefined,
                            sessionId: session.sessionId,
                        })),
                        { placeHolder: 'Fenêtre agent à associer à ce bloc' },
                    );
                    return picked?.sessionId || '';
                };
                let kind: 'devin' | 'agy' | 'bleubite' | 'serveros';
                let newId = '';
                if (want === 'agy') {
                    // Carte Antigravity -> la conversation AGY live, même si un
                    // chat Devin a le focus.
                    newId = focused.startsWith('acp/antigravity-acp/')
                        ? focused
                        : await pickIdeSession('antigravity-acp');
                    if (!newId) {
                        // Repli historique : la cascade AGY active via le hub
                        // (agy-hub.js lit le daemon — indépendant du monitor).
                        try {
                            const cur = require('child_process').execFileSync('node', [
                                path.join(wsRoot, '.agent', 'agent-bridge', 'agy-hub.js'), 'current',
                            ], { encoding: 'utf8', timeout: 20000 }).trim();
                            if (cur) newId = `acp/antigravity-acp/${cur}`;
                        } catch { /* hub AGY indisponible */ }
                    }
                    kind = 'agy';
                } else if (want === 'devin') {
                    // Carte Devin -> la session Devin live, même si c'est une
                    // conversation Antigravity qui a le focus.
                    newId = focused.startsWith('acp/devin-cli/')
                        ? focused
                        : await pickIdeSession('devin-cli');
                    kind = 'devin';
                } else {
                    // Sans type imposé : la fenêtre focalisée, puis repli AGY.
                    kind = kindOf(focused);
                    newId = focused;
                    if (!focused) {
                        kind = 'agy';
                        newId = await pickIdeSession('antigravity-acp');
                        if (!newId) {
                            try {
                                const cur = require('child_process').execFileSync('node', [
                                    path.join(wsRoot, '.agent', 'agent-bridge', 'agy-hub.js'), 'current',
                                ], { encoding: 'utf8', timeout: 20000 }).trim();
                                if (cur) newId = `acp/antigravity-acp/${cur}`;
                            } catch { /* hub AGY indisponible */ }
                        }
                    }
                    // Garde : une carte typée n'accepte que la fenêtre du bon
                    // type (ex. CerberOS refuse une conversation Devin).
                    if (want && want !== kind) {
                        FlowWorkspacePanel.error(`La carte « ${node.title || 'bloc'} » attend une fenêtre ${labels[want]}, pas ${labels[kind]}. Focalise la bonne conversation.`);
                        return;
                    }
                }
                if (!newId) {
                    FlowWorkspacePanel.error(`Aucune fenêtre ${labels[want || kind] || 'agent'} ouverte à attacher.`);
                    return;
                }
                // Fenêtre déjà portée par un autre bloc : on la détache de cet
                // ancien bloc (il garde ses arêtes, sans identité) au lieu de refuser.
                const previous = graph.nodes.find((n) => n.sessionId === newId && n.sessionId !== oldId);
                if (previous) {
                    previous.sessionId = `card-detached-${Date.now().toString(36)}`;
                    delete (previous as { bound?: unknown }).bound;
                }
                node.sessionId = newId;
                (node as { bound?: { at: number; kind: string } }).bound = { at: Date.now(), kind };
                if (kind === 'devin') {
                    // Confirmation locale dans le composer Devin : saisie, JAMAIS soumise.
                    const note = `Carte associée : ${node.title || 'bloc'} est rattachée à cette conversation (message local, à supprimer).`;
                    try {
                        const encVarint = (n: number): number[] => { const out: number[] = []; while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return out; };
                        const lenField = (no: number, d: Buffer) => Buffer.concat([Buffer.from([(no << 3) | 2]), Buffer.from(encVarint(d.length)), d]);
                        const payload = lenField(1, lenField(1, Buffer.from(note, 'utf8'))).toString('base64');
                        await vscode.commands.executeCommand('devin.sendChatActionMessage',
                            JSON.stringify({ actionType: 'addCascadeInput', payload: [payload] }));
                    } catch { /* composer indisponible : pas de confirmation */ }
                }
                if (kind === 'agy') {
                    // Confirmation locale : saisie dans le composer, JAMAIS soumise.
                    const note = `Carte associée : ${node.title || 'bloc'} est rattachée à cette conversation (message local, à supprimer).`;
                    try {
                        const cmds = await vscode.commands.getCommands(true);
                        if (cmds.includes('antigravity.addContext')) {
                            await vscode.commands.executeCommand('antigravity.addContext', note);
                        }
                    } catch { /* composer indisponible : pas de message */ }
                }
                for (const edge of graph.edges) {
                    if (edge.source === oldId) edge.source = newId;
                    if (edge.target === oldId) edge.target = newId;
                }
                graph.edges = graph.edges.filter((edge) => edge.source !== edge.target);
                if (graph.entrySessionId === oldId) graph.entrySessionId = newId;
                FlowWorkspacePanel.update(view(workflowStore.save(graph)));
            } catch (error) {
                FlowWorkspacePanel.error(String(error));
            }
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
                const saveId = typeof (message as { id?: string }).id === 'string' && (message as { id?: string }).id ? { id: String((message as { id?: string }).id) } : undefined;
                workflowStore.saveSchema(String((message as { name?: string }).name || graphToSave.name || 'Schema'), graphToSave, saveId);
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

        if (message.type === 'open_comfyui') {
            await vscode.commands.executeCommand('hephaistosChats.openComfyUI');
            return;
        }

        if (message.type === 'kaggle_push') {
            const ws = workspaceRoot || process.cwd();
            const kaggleDir = process.env.HPHE_KAGGLE_DIR
                || path.join(ws, '..', 'Video_automatisation', 'kaggle-kernels', 'hephaistos-import', 'kaggle');
            const script = fs.existsSync(path.join(kaggleDir, 'patch_tunnel.py'))
                ? path.join(kaggleDir, 'patch_tunnel.py')
                : path.join(ws, '.agent', 'kaggle', 'patch_tunnel.py');
            const t = vscode.window.createTerminal('Kaggle Push');
            t.show(true);
            t.sendText('python "' + script + '"', true);
            FlowWorkspacePanel.post({ type: 'service_state', service: 'kaggle', ok: true, checking: true });
            return;
        }

        if (message.type === 'ensure_service') {
            const svc = String((message as { service?: string }).service || '');
            ensureService(workspaceRoot || process.cwd(), svc)
                .then((ok) => FlowWorkspacePanel.post({ type: 'service_state', service: svc, ok }))
                .catch(() => FlowWorkspacePanel.post({ type: 'service_state', service: svc, ok: false }));
            return;
        }

        if (message.type === 'restart_service') {
            const svc = String((message as { service?: string }).service || '');
            FlowWorkspacePanel.post({ type: 'service_state', service: svc, ok: false, checking: true });
            restartService(workspaceRoot || process.cwd(), svc)
                .then((ok) => FlowWorkspacePanel.post({ type: 'service_state', service: svc, ok }))
                .catch(() => FlowWorkspacePanel.post({ type: 'service_state', service: svc, ok: false }));
            return;
        }

        if (message.type === 'refresh_state') {
            try {
                FlowWorkspacePanel.update(view(workflowStore.load(store.list())), true);
                FlowWorkspacePanel.post({ type: 'schemas_state', schemas: workflowStore.listSchemas(true) });
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
                const deletedSchemaId = String((message as { id?: string }).id || '');
                const res = workflowStore.deleteSchema(deletedSchemaId);
                if (res && res.protected) {
                    FlowWorkspacePanel.error(`Le schema "${res.name || deletedSchemaId}" est un schema standard du kit : sa suppression est refusee (restauration via les gabarits).`);
                }
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
