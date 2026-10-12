"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePanelMessage = handlePanelMessage;
const vscode = require("vscode");
/**
 * Traite les commandes émises par les webviews (panneau éditeur et vue sidebar).
 */
async function handlePanelMessage(message, hooks = {}) {
    if (!message || typeof message !== 'object') {
        return;
    }
    switch (message.command) {
        case 'ready':
            await vscode.commands.executeCommand('orchestratorMonitor.panelReady');
            break;
        case 'refresh':
            await vscode.commands.executeCommand('orchestratorMonitor.refresh');
            break;
        case 'openFile':
            if (typeof message.path === 'string') {
                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                    await vscode.window.showTextDocument(doc);
                }
                catch (err) {
                    vscode.window.showErrorMessage(`Impossible d'ouvrir le fichier : ${err?.message || err}`);
                }
            }
            break;
        case 'clear_tasks':
            if (Array.isArray(message.statuses)) {
                await vscode.commands.executeCommand('orchestratorMonitor.clearTasks', message.statuses);
            }
            break;
        case 'provider_toggle':
            if (typeof message.provider === 'string') {
                await vscode.commands.executeCommand('orchestratorMonitor.providerToggle', message.provider, !!message.enabled);
            }
            break;
        case 'provider_order':
            if (Array.isArray(message.order)) {
                await vscode.commands.executeCommand('orchestratorMonitor.providerOrder', message.order);
            }
            break;
        case 'delete_task':
            if (typeof message.id === 'number' && Number.isFinite(message.id)) {
                await vscode.commands.executeCommand('orchestratorMonitor.deleteTask', message.id);
            }
            break;
        case 'comms-clear':
            await vscode.commands.executeCommand('orchestratorMonitor.clearComms');
            break;
        case 'restart_bridge':
            await vscode.commands.executeCommand('orchestratorMonitor.restartBridge');
            break;
        case 'copy_to_clipboard':
            if (typeof message.text === 'string' && message.text.length) {
                await vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage(message.note || 'Copié dans le presse-papier — collez-le dans le chat.');
            }
            break;
        case 'send_to_chat':
            if (typeof message.text === 'string' && message.text.length) {
                await vscode.commands.executeCommand('orchestratorMonitor.sendToChat', message.text, message.note);
            }
            break;
        case 'open_full_panel':
            await vscode.commands.executeCommand('orchestratorMonitor.openPanel');
            break;
        case 'dispose':
            hooks.onDispose?.();
            break;
    }
}
//# sourceMappingURL=messages.js.map