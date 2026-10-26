import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { DEFAULT_ICON_THEME, iconThemeFiles, normalizeIconTheme } from './types';
import { WorkflowGraph, WorkflowRunStatus, WorkflowView } from './workflow';

export interface FlowPanelMessage {
    type: string;
    workflow?: WorkflowView;
    graph?: WorkflowGraph;
    sessionId?: string;
}

type MessageHandler = (message: FlowPanelMessage) => void;

export class FlowWorkspacePanel {
    private static current: FlowWorkspacePanel | undefined;
    private static iconTheme: string = DEFAULT_ICON_THEME;
    private workflow: WorkflowView;
    private handler: MessageHandler;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        workflow: WorkflowView,
        handler: MessageHandler,
    ) {
        this.workflow = workflow;
        this.handler = handler;
        panel.webview.onDidReceiveMessage((message: FlowPanelMessage) => {
            if (message.type === 'ready') {
                this.sendWorkflow();
                return;
            }
            this.handler(message);
        });
        panel.onDidDispose(() => {
            if (FlowWorkspacePanel.current === this) FlowWorkspacePanel.current = undefined;
        });
        panel.webview.html = this.render(panel.webview, this.extensionUri);
    }

    static open(
        context: vscode.ExtensionContext,
        workflow: WorkflowView,
        handler: MessageHandler,
    ): void {
        if (FlowWorkspacePanel.current) {
            FlowWorkspacePanel.current.handler = handler;
            FlowWorkspacePanel.current.update(workflow);
            FlowWorkspacePanel.current.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const assetsUri = vscode.Uri.joinPath(context.extensionUri, 'out', 'webview');
        const panel = vscode.window.createWebviewPanel(
            'hephaistosFlowWorkspace',
            'Espace de travail',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [assetsUri, vscode.Uri.joinPath(context.extensionUri, 'media', 'agents')],
            },
        );
        FlowWorkspacePanel.current = new FlowWorkspacePanel(panel, context.extensionUri, workflow, handler);
    }

    static update(workflow: WorkflowView): void {
        FlowWorkspacePanel.current?.update(workflow);
    }

    /** Thème d'icônes courant — posé avant open() puis poussé au webview ouvert. */
    static setIconTheme(theme: string): void {
        FlowWorkspacePanel.iconTheme = normalizeIconTheme(theme);
        FlowWorkspacePanel.current?.sendIconTheme();
    }

    /** Dev : recharge le HTML du panneau ouvert après rebuild du bundle webview. */
    static reload(): void {
        const current = FlowWorkspacePanel.current;
        if (!current) return;
        current.panel.webview.html = current.render(current.panel.webview, current.extensionUri);
    }

    static progress(status: WorkflowRunStatus): void {
        void FlowWorkspacePanel.current?.panel.webview.postMessage({
            type: 'workflow_progress',
            status,
        });
    }

    static finished(runId: string, success: boolean, message: string): void {
        void FlowWorkspacePanel.current?.panel.webview.postMessage({
            type: 'workflow_run_finished',
            runId,
            success,
            message,
        });
    }

    static post(message: unknown): void {
        void FlowWorkspacePanel.current?.panel.webview.postMessage(message);
    }

    static error(message: string): void {
        void FlowWorkspacePanel.current?.panel.webview.postMessage({
            type: 'workflow_error',
            message,
        });
    }

    private update(workflow: WorkflowView): void {
        this.workflow = workflow;
        this.sendWorkflow();
    }

    private sendWorkflow(): void {
        void this.panel.webview.postMessage({ type: 'workflow_state', workflow: this.workflow });
        this.sendIconTheme();
    }

    /**
     * Résout le dossier d'icônes effectif : thème non peuplé → commando.
     * La liste des fichiers accompagne l'URI (chaque thème nomme ses PNG
     * différemment : pX-cYY.png vs icon-NN.png) — le webview pioche par hash.
     */
    private iconThemeAssets(): { dir: string; files: string[]; agentsUri: string; fallbackUri: string; fallbackFiles: string[] } {
        const theme = FlowWorkspacePanel.iconTheme;
        let dir = theme;
        let files = iconThemeFiles(this.extensionUri.fsPath, dir);
        if (!files.length) {
            dir = DEFAULT_ICON_THEME;
            files = iconThemeFiles(this.extensionUri.fsPath, dir);
        }
        return {
            dir,
            files,
            agentsUri: this.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'agents', dir)).toString(),
            fallbackUri: this.panel.webview.asWebviewUri(
                vscode.Uri.joinPath(this.extensionUri, 'media', 'agents', DEFAULT_ICON_THEME)).toString(),
            fallbackFiles: iconThemeFiles(this.extensionUri.fsPath, DEFAULT_ICON_THEME),
        };
    }

    /** Rebascule window.__agentsUri côté webview (media/agents/<theme>/). */
    private sendIconTheme(): void {
        const assets = this.iconThemeAssets();
        void this.panel.webview.postMessage({
            type: 'icon_theme',
            theme: FlowWorkspacePanel.iconTheme,
            agentsUri: assets.agentsUri,
            iconFiles: assets.files,
            fallbackUri: assets.fallbackUri,
            fallbackFiles: assets.fallbackFiles,
        });
    }

    private render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const nonce = randomBytes(16).toString('hex');
        const assetsUri = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
        // Le webview cache les URI vscode-resource par URL : sans ?v=, un vieux
        // workspace.js survit aux rebuilds du watcher et le panneau reste noir.
        const bust = { query: `v=${Date.now().toString(36)}` };
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, 'workspace.js')).with(bust);
        // Les icônes vivent dans media/agents/<theme>/ ; le fallback repointe sur commando.
        const iconAssets = this.iconThemeAssets();
        const agentsUri = iconAssets.agentsUri;
        const agentsFallbackUri = iconAssets.fallbackUri;
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, 'workspace.css')).with(bust);

        return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Espace de travail Hephaistos</title>
</head>
<body>
  <div id="root">
    <div class="workspace-boot" role="status">
      <strong>Hephaistos · Espace de travail</strong>
      <span>Chargement du canvas React Flow…</span>
    </div>
  </div>
  <script nonce="${nonce}">
        window.__agentsUri = "${agentsUri}";
        window.__agentsFallbackUri = "${agentsFallbackUri}";
        window.__agentIcons = ${JSON.stringify(iconAssets.files)};
        window.__agentsFallbackIcons = ${JSON.stringify(iconAssets.fallbackFiles)};
    (() => {
      const showBootError = (detail) => {
        const root = document.getElementById('root');
        if (!root || root.querySelector('.workspace-shell')) return;
        const message = document.createElement('pre');
        message.className = 'workspace-boot-error';
        message.textContent = 'Le canvas n’a pas démarré.\\n' + String(detail || 'Erreur Webview inconnue');
        root.replaceChildren(message);
      };
      window.addEventListener('error', (event) => showBootError(event.message));
      window.addEventListener('unhandledrejection', (event) => showBootError(event.reason?.message || event.reason));
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
