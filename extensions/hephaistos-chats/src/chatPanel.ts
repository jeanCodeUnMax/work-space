import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { acpDispose } from './acpClient';
import { chatHtml } from './chatHtml';
import { completeTurn, loadProviderFlags, logRuntime, pingModels } from './runtime';
import { SessionStore } from './sessionStore';
import { AcpProvider, ChatMode, ChatSession, DEFAULT_ICON_THEME, iconThemeFiles, ListedModel, normalizeIconTheme, sessionTitle } from './types';

interface ReadyState {
    type: 'state';
    session: ChatSession;
    providers: AcpProvider[];
    models: ListedModel[];
    status: string;
    isGenerating: boolean;
    allSessions: { id: string; title: string; model: string; provider: string; updatedAt: string }[];
}

export class ChatPanel {
    static readonly viewType = 'hephaistosChat';
    private static readonly openById = new Map<string, ChatPanel>();
    private readonly disposables: vscode.Disposable[] = [];
    private providers: AcpProvider[] = [];
    private models: ListedModel[] = [];
    private status = '';
    private isGenerating = false;
    private currentAbortController: AbortController | null = null;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly store: SessionStore,
        private session: ChatSession,
        private readonly onChange: () => void,
    ) {
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((message) => { void this.onMessage(message); }, null, this.disposables);
        this.render();
    }

    static open(
        context: vscode.ExtensionContext,
        store: SessionStore,
        sessionId: string,
        onChange: () => void,
    ): ChatPanel | undefined {
        const session = store.get(sessionId);
        if (!session) {
            return undefined;
        }
        const existing = ChatPanel.openById.get(sessionId);
        if (existing) {
            existing.session = session;
            existing.panel.reveal(existing.panel.viewColumn);
            existing.push();
            return existing;
        }
        const panel = vscode.window.createWebviewPanel(
            ChatPanel.viewType,
            sessionTitle(session),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            },
        );
        const chat = new ChatPanel(panel, context.extensionUri, context, store, session, onChange);
        ChatPanel.openById.set(sessionId, chat);
        return chat;
    }

    /** Thème d'icônes persisté (workspaceState) — lu au render et après set_icon_theme. */
    static iconTheme(context: vscode.ExtensionContext): string {
        return normalizeIconTheme(context.workspaceState.get('hephaistosChats.iconTheme'));
    }

    /** Pré-remplit la saisie d'une fenêtre chat ouverte (puce de pointage ⌖). */
    static prefill(sessionId: string, text: string): void {
        const chat = ChatPanel.openById.get(sessionId);
        if (chat) void chat.panel.webview.postMessage({ type: 'prefill', text });
    }

    /** Rebascule les URI d'icônes des chats ouverts sans recharger le HTML. */
    static refreshIcons(context: vscode.ExtensionContext): void {
        const theme = ChatPanel.iconTheme(context);
        for (const chat of ChatPanel.openById.values()) {
            // Thème non peuplé → commando ; la liste des fichiers suit l'URI car
            // chaque thème nomme ses PNG différemment (pX-cYY vs icon-NN).
            let dir = theme;
            let files = iconThemeFiles(chat.extensionUri.fsPath, dir);
            if (!files.length) {
                dir = DEFAULT_ICON_THEME;
                files = iconThemeFiles(chat.extensionUri.fsPath, dir);
            }
            const agentsUri = chat.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(chat.extensionUri, 'media', 'agents', dir));
            const fallbackUri = chat.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(chat.extensionUri, 'media', 'agents', DEFAULT_ICON_THEME));
            void chat.panel.webview.postMessage({
                type: 'icon_theme',
                theme,
                agentsUri: agentsUri.toString(),
                iconFiles: files,
                fallbackUri: fallbackUri.toString(),
                fallbackFiles: iconThemeFiles(chat.extensionUri.fsPath, DEFAULT_ICON_THEME),
            });
        }
    }

    /** Re-pousse toutes les fenêtres ouvertes après un changement externe du store. */
    static refreshOpen(store: SessionStore): void {
        for (const [id, chat] of ChatPanel.openById) {
            const fresh = store.get(id);
            if (!fresh) {
                chat.panel.dispose();
                continue;
            }
            chat.session = fresh;
            chat.push();
        }
    }

    static revive(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        store: SessionStore,
        sessionId: string,
        onChange: () => void,
    ): void {
        const session = store.get(sessionId);
        if (!session) {
            panel.dispose();
            return;
        }
        const chat = new ChatPanel(panel, context.extensionUri, context, store, session, onChange);
        ChatPanel.openById.set(sessionId, chat);
    }

    private async onMessage(message: {
        type: string;
        mode?: ChatMode;
        provider?: string;
        model?: string;
        text?: string;
        title?: string;
        id?: string;
        enabled?: boolean;
    }): Promise<void> {
        if (message.type === 'switch_session' && message.id) {
            const nextSession = this.store.get(message.id);
            if (nextSession && nextSession.id !== this.session.id) {
                const previousId = this.session.id;
                acpDispose(previousId);
                ChatPanel.openById.delete(previousId);
                this.session = nextSession;
                ChatPanel.openById.set(nextSession.id, this);
                this.panel.title = sessionTitle(this.session);
                this.push();
            }
            return;
        }
        if (message.type === 'ready' || message.type === 'ping') {
            await this.reload(message.type === 'ping');
            return;
        }
        if (message.type === 'point_agent') {
            void vscode.commands.executeCommand('hephaistosChats.pointAgent', this.session.id);
            return;
        }
        if (message.type === 'meta' && message.mode && message.provider && message.model) {
            const providerChanged = message.provider !== this.session.provider;
            if (providerChanged) {
                acpDispose(this.session.id);
                this.session.acpSessionId = undefined;
            }
            this.session = { ...this.session, mode: message.mode, provider: message.provider, model: message.model };
            this.store.save(this.session);
            this.panel.title = sessionTitle(this.session);
            this.onChange();
            this.push();
            return;
        }
        if (message.type === 'rename' && message.title) {
            this.session.title = message.title.trim();
            this.store.save(this.session);
            this.panel.title = sessionTitle(this.session);
            this.onChange();
            this.push();
            return;
        }
        if (message.type === 'clear') {
            this.session.messages = [];
            this.store.save(this.session);
            this.onChange();
            this.push();
            return;
        }
        if (message.type === 'get_chat_id') {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            let bridgeResult: any = null;
            if (root) {
                const bridgeScript = path.join(root, '.agent', 'agent-bridge', 'chat-id.js');
                if (fs.existsSync(bridgeScript)) {
                    try {
                        const raw = execFileSync(process.execPath, [bridgeScript], {
                            cwd: root,
                            encoding: 'utf8',
                            timeout: 5000,
                            windowsHide: true,
                        });
                        bridgeResult = JSON.parse(raw);
                    } catch {
                        /* ignorer */
                    }
                }
            }
            void this.panel.webview.postMessage({
                type: 'chat_id_response',
                sessionIdentity: {
                    sessionId: this.session.id,
                    providerId: this.session.provider,
                    transport: 'hephaistos-chat',
                    model: this.session.model,
                    mode: this.session.mode,
                    title: sessionTitle(this.session),
                    userMessageCount: this.session.messages.filter((m) => m.role === 'user').length,
                    createdAt: this.session.updatedAt,
                    workspace: root,
                },
                workspaceSession: bridgeResult,
            });
            return;
        }
        if (message.type === 'delete') {
            this.store.delete(this.session.id);
            this.onChange();
            this.panel.dispose();
            return;
        }
        if (message.type === 'abort') {
            if (this.currentAbortController) {
                this.currentAbortController.abort();
                this.currentAbortController = null;
            }
            this.isGenerating = false;
            this.push();
            return;
        }
        if (message.type === 'send' && message.text?.trim()) {
            await this.send(message.text.trim());
        }
    }

    private async reload(refresh: boolean): Promise<void> {
        this.status = refresh ? 'Interrogation des fournisseurs…' : this.status;
        this.push();
        try {
            this.providers = await loadProviderFlags(this.context);
            const enabled = new Set(this.providers.filter((provider) => provider.enabled).map((provider) => provider.id));
            if (refresh || this.models.length === 0) {
                this.models = await pingModels(enabled);
                this.status = `${this.models.length} modèles répondent.`;
            } else {
                this.models = this.models.filter((model) => enabled.has(model.provider));
            }
        } catch (error: any) {
            this.status = error?.message || String(error);
        }
        this.push();
    }

    private async send(text: string): Promise<void> {
        if (this.isGenerating) {
            logRuntime(`send ignoré (génération en cours) session=${this.session.id}`);
            return;
        }
        logRuntime(`send session=${this.session.id} provider=${this.session.provider} model=${this.session.model}`);

        const now = new Date().toISOString();
        const session: ChatSession = {
            ...this.session,
            messages: [...this.session.messages, { role: 'user', text, at: now }],
        };
        this.session = session;
        this.store.save(session);
        this.panel.title = sessionTitle(session);
        this.onChange();

        // Préparer un placeholder assistant pour le streaming
        const assistantIndex = session.messages.length;
        session.messages.push({
            role: 'assistant',
            text: '',
            at: new Date().toISOString(),
        });

        this.isGenerating = true;
        this.currentAbortController = new AbortController();
        this.push();

        try {
            const finalReply = await completeTurn(
                session.provider,
                session.model,
                session.mode,
                session.messages.slice(0, assistantIndex),
                (accumulated) => {
                    const msg = session.messages[assistantIndex];
                    if (msg) {
                        msg.text = accumulated;
                        this.push();
                    }
                },
                this.currentAbortController.signal,
                (thinking) => {
                    const msg = session.messages[assistantIndex];
                    if (msg) {
                        msg.thinking = thinking;
                        this.push();
                    }
                },
                {
                    chatSessionId: session.id,
                    acpSessionId: session.acpSessionId,
                    onAcpSessionId: (id) => {
                        session.acpSessionId = id;
                        this.store.save(session);
                    },
                    onTools: (tools) => {
                        const msg = session.messages[assistantIndex];
                        if (msg) {
                            msg.tools = tools;
                            this.push();
                        }
                    },
                },
            );

            session.messages[assistantIndex].text = finalReply;
            session.messages[assistantIndex].isError = false;
        } catch (error: any) {
            const msg = session.messages[assistantIndex];
            if (this.currentAbortController?.signal.aborted) {
                msg.text += '\n\n*(Génération interrompue)*';
            } else {
                const errMsg = error?.message || String(error);
                msg.text = `⚠️ **Erreur :** ${errMsg}`;
                msg.isError = true;
            }
        } finally {
            this.isGenerating = false;
            this.currentAbortController = null;
            // Ré-ancrer le panneau sur la session complétée : même si un watcher
            // externe a permuté this.session en cours de route, le tour complet
            // (user + assistant) est persisté et ré-affiché.
            this.session = session;
            this.store.save(session);
            this.onChange();
            this.push();
            logRuntime(`persisté session=${session.id} msgs=${session.messages.length}`);
        }
    }

    private push(): void {
        // Historique : uniquement les sessions du MÊME provider et du MÊME workspace
        // que la fenêtre courante. Les sessions legacy sans workspace sont rattachées
        // au workspace courant (le fichier sessions.json est déjà par-projet).
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const allSessions = this.store.list()
            .filter((s) => s.provider === this.session.provider && (s.workspace || ws) === ws)
            .map((s) => ({
                id: s.id,
                title: sessionTitle(s),
                model: s.model,
                provider: s.provider,
                updatedAt: s.updatedAt,
            }));
        const payload: ReadyState = {
            type: 'state',
            session: this.session,
            providers: this.providers,
            models: this.models,
            status: this.status,
            isGenerating: this.isGenerating,
            allSessions,
        };
        void this.panel.webview.postMessage(payload);
    }

    private render(): void {
        const nonce = Math.random().toString(36).slice(2);
        this.panel.title = sessionTitle(this.session);
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        this.panel.webview.html = chatHtml(this.panel.webview, this.extensionUri, nonce, ChatPanel.iconTheme(this.context));
    }

    private dispose(): void {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        acpDispose(this.session.id);
        // Purge toute clé pointant encore vers ce panneau (ex. session permutée)
        for (const [id, chat] of ChatPanel.openById) {
            if (chat === this) ChatPanel.openById.delete(id);
        }
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
