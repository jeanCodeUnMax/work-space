"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestratorPanel = void 0;
const vscode = require("vscode");
const panelHtml_1 = require("./panelHtml");
const messages_1 = require("./messages");
/**
 * Gestionnaire du panneau Webview pour le moniteur de l'orchestrateur MCP.
 * Rend le même HTML que la vue sidebar (panelHtml partagé).
 */
class OrchestratorPanel {
    /**
     * Crée ou affiche le panneau Webview singleton.
     */
    static createOrShow(extensionUri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        if (OrchestratorPanel.currentPanel) {
            OrchestratorPanel.currentPanel._panel.reveal(column);
            return OrchestratorPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(OrchestratorPanel.viewType, 'Orchestrator Monitor', column || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'media'),
                vscode.Uri.joinPath(extensionUri, 'resources')
            ]
        });
        OrchestratorPanel.currentPanel = new OrchestratorPanel(panel, extensionUri);
        return OrchestratorPanel.currentPanel;
    }
    constructor(panel, extensionUri) {
        this._disposables = [];
        this._panel = panel;
        this._extensionUri = extensionUri;
        // Définition du contenu HTML initial
        this._panel.webview.html = this.getHtml(this._panel.webview);
        // Nettoyage lors de la fermeture du panneau
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        // Écoute des messages émis par le script de la Webview
        this._panel.webview.onDidReceiveMessage(async (message) => {
            await (0, messages_1.handlePanelMessage)(message, { onDispose: () => this.dispose() });
        }, null, this._disposables);
    }
    /**
     * Envoie un message à la Webview (snapshot, task_update, etc.).
     */
    postMessageToWebview(msg) {
        return this._panel.webview.postMessage(msg);
    }
    /**
     * Génère le balisage HTML de la Webview (partagé avec la vue sidebar).
     */
    getHtml(webview) {
        return (0, panelHtml_1.getPanelHtml)(webview, this._extensionUri, { compact: false });
    }
    /**
     * Libère les ressources du panneau.
     */
    dispose() {
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
exports.OrchestratorPanel = OrchestratorPanel;
OrchestratorPanel.viewType = 'orchestratorMonitor.panel';
//# sourceMappingURL=OrchestratorPanel.js.map