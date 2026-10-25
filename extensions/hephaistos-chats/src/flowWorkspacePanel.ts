import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { WorkflowGraph, WorkflowRunStatus, WorkflowView } from './workflow';

export interface FlowPanelMessage {
    type: string;
    workflow?: WorkflowView;
    graph?: WorkflowGraph;
    sessionId?: string;
    provider?: string;
}

type MessageHandler = (message: FlowPanelMessage) => void;

export class FlowWorkspacePanel {
    private static current: FlowWorkspacePanel | undefined;
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
                localResourceRoots: [assetsUri],
            },
        );
        FlowWorkspacePanel.current = new FlowWorkspacePanel(panel, context.extensionUri, workflow, handler);
    }

    static update(workflow: WorkflowView): void {
        FlowWorkspacePanel.current?.update(workflow);
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
    }

    private render(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const nonce = randomBytes(16).toString('hex');
        const assetsUri = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, 'workspace.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, 'workspace.css'));

        return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Espace de travail Hephaistos</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
