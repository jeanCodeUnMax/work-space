import * as vscode from 'vscode';
import { getPanelHtml } from './panelHtml';
import { handlePanelMessage } from './messages';

/**
 * Gestionnaire du panneau Webview pour le moniteur de l'orchestrateur MCP.
 * Rend le même HTML que la vue sidebar (panelHtml partagé).
 */
export class OrchestratorPanel {
    public static currentPanel: OrchestratorPanel | undefined;
    public static readonly viewType = 'orchestratorMonitor.panel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    /**
     * Crée ou affiche le panneau Webview singleton.
     */
    public static createOrShow(extensionUri: vscode.Uri): OrchestratorPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (OrchestratorPanel.currentPanel) {
            OrchestratorPanel.currentPanel._panel.reveal(column);
            return OrchestratorPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            OrchestratorPanel.viewType,
            'Orchestrator Monitor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'resources')
                ]
            }
        );

        OrchestratorPanel.currentPanel = new OrchestratorPanel(panel, extensionUri);
        return OrchestratorPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Définition du contenu HTML initial
        this._panel.webview.html = this.getHtml(this._panel.webview);

        // Nettoyage lors de la fermeture du panneau
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Écoute des messages émis par le script de la Webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                await handlePanelMessage(message, { onDispose: () => this.dispose() });
            },
            null,
            this._disposables
        );
    }

    /**
     * Envoie un message à la Webview (snapshot, task_update, etc.).
     */
    public postMessageToWebview(msg: any): Thenable<boolean> {
        return this._panel.webview.postMessage(msg);
    }

    /**
     * Génère le balisage HTML de la Webview (partagé avec la vue sidebar).
     */
    public getHtml(webview: vscode.Webview): string {
        return getPanelHtml(webview, this._extensionUri, { compact: false });
    }

    /**
     * Libère les ressources du panneau.
     */
    public dispose(): void {
        OrchestratorPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
