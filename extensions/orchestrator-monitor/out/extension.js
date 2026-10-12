"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.wakeDevin = wakeDevin;
exports.wakeAntigravity = wakeAntigravity;
exports.sendToDevinChat = sendToDevinChat;
exports.deactivate = deactivate;
const vscode = require("vscode");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const child_process_1 = require("child_process");
const OrchestratorPanel_1 = require("./panel/OrchestratorPanel");
const panelHtml_1 = require("./panel/panelHtml");
const messages_1 = require("./panel/messages");
const client_1 = require("./data/client");
let wsClient;
let bridgeProcess;
let bridgeAutoStarted = false;
let lastSnapshot = undefined;
const knownTaskStatus = new Map();
let sidebarView;
function activate(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('orchestratorMonitor.tasks', new TasksWebviewProvider(context)), vscode.commands.registerCommand('orchestratorMonitor.openPanel', () => OrchestratorPanel_1.OrchestratorPanel.createOrShow(context.extensionUri)), vscode.commands.registerCommand('orchestratorMonitor.refresh', () => refresh()), vscode.commands.registerCommand('orchestratorMonitor.startBridge', () => startBridge(context)), vscode.commands.registerCommand('orchestratorMonitor.restartBridge', () => restartBridge(context)), vscode.commands.registerCommand('orchestratorMonitor.clearCompleted', () => clearTasks(['completed'])), vscode.commands.registerCommand('orchestratorMonitor.clearFailed', () => clearTasks(['failed'])), vscode.commands.registerCommand('orchestratorMonitor.clearPending', () => clearTasks(['pending'])), vscode.commands.registerCommand('orchestratorMonitor.clearTasks', (statuses) => clearTasks(statuses)), vscode.commands.registerCommand('orchestratorMonitor.clearComms', () => {
        try {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (root) {
                fs.writeFileSync(path.join(root, '.agent', 'comms.jsonl'), '');
            }
        }
        catch { /* best-effort */ }
    }), vscode.commands.registerCommand('orchestratorMonitor.providerToggle', (provider, enabled) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'provider_toggle', provider, enabled });
    }), vscode.commands.registerCommand('orchestratorMonitor.providerOrder', (order) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'provider_order', order });
    }), vscode.commands.registerCommand('orchestratorMonitor.deleteTask', (id) => {
        if (!wsClient) {
            vscode.window.showErrorMessage(L('bridge.off'));
            return;
        }
        wsClient.send({ command: 'delete_task', id });
    }), vscode.commands.registerCommand('orchestratorMonitor.sendToChat', (text, label) => sendToDevinChat(text, label)), vscode.commands.registerCommand('orchestratorMonitor.panelReady', () => {
        forwardToWebviews({ type: 'config', lang: vscode.env.language });
        if (lastSnapshot) {
            forwardToWebviews(lastSnapshot);
        }
    }));
    wsClient = new client_1.OrchestratorWS();
    wsClient.on('connected', () => {
        forwardToWebviews({ type: 'ws_status', connected: true });
        refresh();
    });
    wsClient.on('disconnected', () => {
        forwardToWebviews({ type: 'ws_status', connected: false });
        if (!bridgeAutoStarted) {
            bridgeAutoStarted = true;
            startBridge(context);
        }
    });
    wsClient.on('message', (msg) => {
        if (msg && msg.type === 'snapshot') {
            lastSnapshot = msg;
            for (const t of msg.tasks ?? []) {
                knownTaskStatus.set(t.id, t.status);
            }
        }
        if (msg && msg.type === 'task_update' && msg.task) {
            const prev = knownTaskStatus.get(msg.task.id);
            knownTaskStatus.set(msg.task.id, msg.task.status);
            if (prev !== msg.task.status) {
                onTaskTerminalWake(msg.task);
            }
        }
        if (msg && msg.type === 'clear_result') {
            if (msg.error) {
                vscode.window.showErrorMessage(L('purge.err', { err: msg.error }));
            }
            else {
                vscode.window.showInformationMessage(L('purge.ok', { n: String(msg.deleted) }));
            }
        }
        forwardToWebviews(msg);
    });
    wsClient.connect();
    context.subscriptions.push({ dispose: () => deactivate() });
}
function forwardToWebviews(msg) {
    OrchestratorPanel_1.OrchestratorPanel.currentPanel?.postMessageToWebview(msg);
    sidebarView?.webview.postMessage(msg);
}
function refresh() {
    if (wsClient) {
        wsClient.send({ command: 'refresh' });
    }
    if (lastSnapshot) {
        forwardToWebviews(lastSnapshot);
    }
}
/* ===== Chaînes localisées côté extension (toasts, confirmations) ===== */
const EXT_STRINGS = {
    fr: {
        'purge.confirm': "Supprimer définitivement les tâches {list} de l'orchestrateur ?",
        'purge.ok': '{n} tâche(s) purgée(s).', 'purge.err': 'Purge impossible : {err}',
        'purge.btn': 'Supprimer', 'status.completed': 'terminées', 'status.failed': 'échouées',
        'status.pending': 'en attente', 'status.in_progress': 'en cours', 'status.and': ' et ',
        'bridge.off': 'Bridge non connecté.', 'chat.sent': '{label} envoyé dans le chat Devin.',
        'chat.copied': '{label} copié — collez-le dans le chat Devin (Ctrl+V).', 'chat.default': 'Texte'
    },
    en: {
        'purge.confirm': 'Permanently delete {list} tasks from the orchestrator?',
        'purge.ok': '{n} task(s) purged.', 'purge.err': 'Purge failed: {err}',
        'purge.btn': 'Delete', 'status.completed': 'completed', 'status.failed': 'failed',
        'status.pending': 'pending', 'status.in_progress': 'in progress', 'status.and': ' and ',
        'bridge.off': 'Bridge not connected.', 'chat.sent': '{label} sent to the Devin chat.',
        'chat.copied': '{label} copied — paste it into the Devin chat (Ctrl+V).', 'chat.default': 'Text'
    },
    de: {
        'purge.confirm': '{list} Aufgaben endgültig aus dem Orchestrator löschen?',
        'purge.ok': '{n} Aufgabe(n) gelöscht.', 'purge.err': 'Löschen fehlgeschlagen: {err}',
        'purge.btn': 'Löschen', 'status.completed': 'abgeschlossene', 'status.failed': 'fehlgeschlagene',
        'status.pending': 'wartende', 'status.in_progress': 'laufende', 'status.and': ' und ',
        'bridge.off': 'Bridge nicht verbunden.', 'chat.sent': '{label} an den Devin-Chat gesendet.',
        'chat.copied': '{label} kopiert — im Devin-Chat einfügen (Strg+V).', 'chat.default': 'Text'
    },
    es: {
        'purge.confirm': '¿Eliminar permanentemente las tareas {list} del orquestador?',
        'purge.ok': '{n} tarea(s) purgada(s).', 'purge.err': 'Error de purga: {err}',
        'purge.btn': 'Eliminar', 'status.completed': 'completadas', 'status.failed': 'fallidas',
        'status.pending': 'en espera', 'status.in_progress': 'en curso', 'status.and': ' y ',
        'bridge.off': 'Bridge no conectado.', 'chat.sent': '{label} enviado al chat de Devin.',
        'chat.copied': '{label} copiado — péguelo en el chat de Devin (Ctrl+V).', 'chat.default': 'Texto'
    }
};
function uiLang() {
    const l = (vscode.env.language || 'en').split('-')[0].toLowerCase();
    return EXT_STRINGS[l] ? l : 'en';
}
function L(key, vars) {
    let s = EXT_STRINGS[uiLang()][key] || EXT_STRINGS.en[key] || key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            s = s.replace(`{${k}}`, v);
        }
    }
    return s;
}
async function clearTasks(statuses) {
    const human = statuses.map((s) => L('status.' + s)).join(L('status.and'));
    const btn = L('purge.btn');
    const choice = await vscode.window.showWarningMessage(L('purge.confirm', { list: human }), { modal: true }, btn);
    if (choice !== btn) {
        return;
    }
    if (!wsClient) {
        vscode.window.showErrorMessage(L('bridge.off'));
        return;
    }
    wsClient.send({ command: 'clear_tasks', statuses });
}
/* ===== Encodage protobuf minimal pour l'injection chat =====
 * Noms ci-dessous = identifiants internes du protocole fil de Devin
 * (exa.codeium_common_pb / exa.chat_client_server_pb / exa.language_server_pb).
 * Ils sont obligatoires tels quels — ce ne sont PAS des agents ni du vocabulaire
 * métier : juste le schéma binaire attendu par devin.sendChatActionMessage.
 *   TextOrScopeItem { no:1 text:string (oneof chunk) }
 *   AddCascadeInputRequest { no:1 items:[TextOrScopeItem] }   ← draft
 *   SendCascadeInputRequest { no:1 items:[TextOrScopeItem] }  ← envoi réel
 *   SendActionToChatPanelRequest { no:1 action_type, no:2 payload:bytes[] }
 */
function encodeVarint(n) {
    const out = [];
    while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
}
function lenField(fieldNo, data) {
    return Buffer.concat([
        Buffer.from([(fieldNo << 3) | 2]),
        Buffer.from(encodeVarint(data.length)),
        data
    ]);
}
function buildChatInputPayload(text) {
    const item = lenField(1, Buffer.from(text, 'utf8')); // TextOrScopeItem{text}
    const request = lenField(1, item); // {items} — même schéma pour les actions draft et send
    return request.toString('base64');
}
/**
 * La conversation <cascadeId> est-elle déjà celle affichée ?
 * Heuristique (même que agent-ws-bridge/current-cascade.js) : le store
 * ~/.codeium/windsurf/cascade/<id>.pb est réécrit à chaque tour — le plus
 * récent correspond à la conversation en cours d'utilisation.
 */
function isActiveCascade(cascadeId) {
    try {
        const dir = path.join(os.homedir(), '.codeium', 'windsurf', 'cascade');
        const files = fs.readdirSync(dir)
            .filter((f) => f.endsWith('.pb') && !f.endsWith('.archived'));
        let newest = '';
        let newestM = -1;
        for (const f of files) {
            const m = fs.statSync(path.join(dir, f)).mtimeMs;
            if (m > newestM) {
                newestM = m;
                newest = f;
            }
        }
        return newest === `${cascadeId}.pb`;
    }
    catch {
        return false;
    }
}
/**
 * Réveil réel : soumet un message au chat Devin (nouveau tour), pas un brouillon.
 * PAS de repli addCascadeInput : un draft non sollicité laisse un bouton
 * « envoyer » dans le composer et se mélange au texte que l'utilisateur tape.
 */
async function wakeDevin(text, cascadeId) {
    const payload = buildChatInputPayload(text);
    if (cascadeId && !isActiveCascade(cascadeId)) {
        // Basculer la conversation cible au premier plan AVANT d'envoyer —
        // sinon la réponse atterrit dans la conversation active du moment
        // (ou une nouvelle) et l'historique question/réponse se perd.
        // Si la cible est déjà la conv affichée, on saute le focus : la
        // réouverture forcerait un rechargement de vue qui masque le scrollback.
        // openCascadeIdInChatPanel attend l'id en UTF-8 brut (pas de protobuf).
        try {
            await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({
                actionType: 'openCascadeIdInChatPanel',
                payload: [Buffer.from(cascadeId, 'utf8').toString('base64')],
            }));
            await new Promise((r) => setTimeout(r, 600));
        }
        catch { /* cible introuvable → on envoie quand même dans l'actif */ }
    }
    try {
        await vscode.commands.executeCommand('devin.sendChatActionMessage', JSON.stringify({ actionType: 'sendCascadeInput', payload: [payload] }));
        commsLog('orchestrator', 'devin', 'wake', text, cascadeId);
        return 'sent';
    }
    catch {
        commsLog('orchestrator', 'devin', 'wake-failed', text, cascadeId);
        return 'failed';
    }
}
const CASCADE_TAG = /(?:cascade|conv)[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const AGY_CASCADE_TAG = /agycascade[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
/* ===== Bus comms inter-agents (feed temps réel du panneau) =====
 * Append-only JSONL : <workspace>/.agent/comms.jsonl — même format que
 * extensions/agent-ws-bridge/comms.js ; le ws-bridge tail et broadcast.
 */
function commsLog(src, dst, kind, text, convId, taskId) {
    try {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            return;
        }
        const p = path.join(root, '.agent', 'comms.jsonl');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify({
            ts: new Date().toISOString(), src, dst, kind,
            text: String(text ?? '').slice(0, 4000),
            ...(convId ? { convId } : {}),
            ...(taskId !== undefined ? { taskId } : {})
        }) + '\n');
    }
    catch { /* le feed est best-effort */ }
}
function agyHub() {
    const ext = vscode.extensions.getExtension('google.google-antigravity');
    const api = ext?.exports;
    if (api?.csrfToken && api?.port) {
        return { port: api.port, csrfToken: api.csrfToken };
    }
    return undefined;
}
function agyRpc(hub, method, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: hub.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-codeium-csrf-token': hub.csrfToken,
                'connect-protocol-version': '1'
            },
            timeout: timeoutMs
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                try {
                    const j = d ? JSON.parse(d) : {};
                    if (res.statusCode !== 200 || j.code) {
                        reject(new Error(`${method}: ${res.statusCode} ${d.slice(0, 300)}`));
                    }
                    else {
                        resolve(j);
                    }
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`${method}: timeout`)); });
        req.end(JSON.stringify(body || {}));
    });
}
let agyModelCache;
async function agyDefaultModel(hub) {
    if (agyModelCache !== undefined) {
        return agyModelCache;
    }
    try {
        const d = await agyRpc(hub, 'GetCascadeModelConfigData', {});
        agyModelCache = (d?.defaultOverrideModelConfig?.modelOrAlias?.model
            ?? (d?.clientModelConfigs || []).find((c) => !c.disabled)?.modelOrAlias?.model
            ?? null);
    }
    catch {
        agyModelCache = null;
    }
    return agyModelCache;
}
/**
 * Injecte un message dans la conversation Antigravity <agyCascadeId> (panneau
 * de l'extension dans Devin). Si `replyToCascadeId` (Devin) est fourni, attend
 * la fin de l'exécution puis renvoie la réponse de l'agent dans cette
 * conversation Devin — aller-retour complet sans nouvelle fenêtre.
 */
async function wakeAntigravity(text, agyCascadeId, replyToCascadeId) {
    const hub = agyHub();
    if (!hub) {
        return 'failed';
    }
    try {
        // Focus côté hub — best effort, non bloquant si refusé
        await agyRpc(hub, 'SetBrowserOpenConversation', {
            cascadeId: agyCascadeId,
            expiresAt: new Date(Date.now() + 3600e3).toISOString()
        }).catch(() => undefined);
        const planModel = await agyDefaultModel(hub);
        const body = { cascadeId: agyCascadeId, items: [{ text }] };
        if (planModel) {
            body.cascadeConfig = { plannerConfig: { planModel } };
        }
        const before = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId: agyCascadeId })
            .then((r) => (r.steps || []).length).catch(() => 0);
        await agyRpc(hub, 'SendUserCascadeMessage', body);
        commsLog('orchestrator', 'agy', 'prompt', text, agyCascadeId);
        if (replyToCascadeId) {
            relayAgyReply(hub, agyCascadeId, before, replyToCascadeId)
                .catch((e) => console.error('[agy] relay:', e?.message || e));
        }
        return 'sent';
    }
    catch (e) {
        console.error('[agy] send:', e?.message || e);
        return 'failed';
    }
}
/** Attend l'idle de la conv AGY puis injecte ses réponses dans le chat Devin. */
async function relayAgyReply(hub, agyCascadeId, sinceStep, devinCascadeId) {
    await agyRpc(hub, 'WaitForConversationFullyIdle', {
        conversationId: agyCascadeId,
        inactivityTimeoutSeconds: 300,
        stabilizationDurationSeconds: 2,
        returnOnExecutorError: true
    }, 10 * 60 * 1000);
    const r = await agyRpc(hub, 'GetCascadeTrajectorySteps', { cascadeId: agyCascadeId });
    const steps = r.steps || [];
    const texts = [];
    for (let i = sinceStep; i < steps.length; i++) {
        const s = steps[i];
        if (s.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const p = s.plannerResponse || {};
            const t = p.modifiedResponse || p.response || '';
            if (t) {
                texts.push(t);
            }
        }
        else if (s.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
            texts.push(`[agy-error] ${s.errorMessage?.error?.shortError || 'erreur'}`);
        }
    }
    if (texts.length) {
        commsLog('agy', 'devin', 'reply', texts.join('\n\n'), agyCascadeId);
        await wakeDevin(`[AGY↩ ${agyCascadeId.slice(0, 8)}] ${texts.join('\n\n')}`, devinCascadeId);
    }
}
function onTaskTerminalWake(task) {
    if (!vscode.workspace.getConfiguration('orchestratorMonitor').get('autoWake', true)) {
        return;
    }
    const status = task?.status;
    if (status !== 'completed' && status !== 'failed') {
        return;
    }
    const blob = `${task?.title ?? ''} ${task?.description ?? ''}`;
    const cascadeId = blob.match(CASCADE_TAG)?.[1];
    const agyCascadeId = blob.match(AGY_CASCADE_TAG)?.[1];
    const title = String(task?.title ?? task?.description ?? '').slice(0, 140);
    const wake = `[WAKE] tâche #${task?.id ?? '?'} → ${status}${title ? ` — ${title}` : ''}`;
    if (!cascadeId && !agyCascadeId) {
        // Tâche sans tag de routage → JAMAIS d'injection chat : un
        // sendCascadeInput sans cible explicite atterrit dans la conversation
        // que l'utilisateur est en train de lire — tours [WAKE] parasites,
        // boutons « run » sur les réponses, perte du scrollback. Le passage
        // terminal reste visible dans le feed monitor et sur le bus comms.
        commsLog('orchestrator', 'devin', 'wake', `${wake} (non routé)`);
        return;
    }
    if (agyCascadeId) {
        // Tâche née dans une conversation Antigravity → la réponse retourne
        // dans CETTE conversation (et dans Devin si un tag cascade coexiste).
        wakeAntigravity(wake, agyCascadeId, cascadeId);
        if (!cascadeId) {
            return;
        }
    }
    wakeDevin(wake, cascadeId);
}
/** Envoie du texte dans le chat Devin actif, avec repli presse-papier. */
async function sendToDevinChat(text, label) {
    let injected = false;
    try {
        const payload = buildChatInputPayload(text);
        const action = JSON.stringify({ actionType: 'addCascadeInput', payload: [payload] });
        await vscode.commands.executeCommand('devin.sendChatActionMessage', action);
        injected = true;
    }
    catch { /* commande absente ou payload refusé → fallback */ }
    await vscode.env.clipboard.writeText(text);
    const lbl = label ?? L('chat.default');
    vscode.window.showInformationMessage(injected ? L('chat.sent', { label: lbl }) : L('chat.copied', { label: lbl }));
}
function startBridge(context) {
    if (bridgeProcess && !bridgeProcess.killed) {
        if (!bridgeAutoStarted) {
            vscode.window.showInformationMessage('Orchestrator bridge already running.');
        }
        return;
    }
    bridgeAutoStarted = true;
    const bridgePath = path.join(context.extensionPath, 'ws-bridge', 'bridge.js');
    const bridgeCwd = path.dirname(bridgePath);
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || bridgeCwd;
    bridgeProcess = (0, child_process_1.spawn)('node', [bridgePath], {
        cwd: bridgeCwd,
        env: { ...process.env, HEPHAISTOS_WORKSPACE: wsRoot }
    });
    bridgeProcess.stdout?.on('data', (d) => console.log(`[bridge] ${d}`));
    bridgeProcess.stderr?.on('data', (d) => console.error(`[bridge:err] ${d}`));
    bridgeProcess.on('close', (code) => {
        bridgeProcess = undefined;
        vscode.window.showWarningMessage(`Orchestrator bridge stopped (code ${code}).`);
    });
    vscode.window.showInformationMessage('Orchestrator bridge started.');
}
function restartBridge(context) {
    if (bridgeProcess) {
        try {
            bridgeProcess.kill();
        }
        catch { /* noop */ }
        bridgeProcess = undefined;
    }
    startBridge(context);
}
/**
 * Vue sidebar : exactement le même dashboard webview que le panneau éditeur,
 * avec un bouton d'agrandissement vers le panneau plein écran.
 */
class TasksWebviewProvider {
    constructor(_context) {
        this._context = _context;
    }
    resolveWebviewView(view) {
        sidebarView = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                vscode.Uri.joinPath(this._context.extensionUri, 'resources')
            ]
        };
        try {
            view.webview.html = (0, panelHtml_1.getPanelHtml)(view.webview, this._context.extensionUri, { compact: true });
        }
        catch (err) {
            console.error('[orchestrator-monitor] resolveWebviewView:', err);
            view.webview.html = `<html><body style="color:#f66;font:12px monospace;padding:12px">resolveWebviewView error:<br>${String(err?.message || err)}<br>${String(err?.stack || '')}</body></html>`;
        }
        view.webview.onDidReceiveMessage((message) => (0, messages_1.handlePanelMessage)(message));
        view.onDidDispose(() => {
            if (sidebarView === view) {
                sidebarView = undefined;
            }
        });
        // Pousser immédiatement le dernier état connu
        if (lastSnapshot) {
            view.webview.postMessage(lastSnapshot);
        }
    }
}
function deactivate() {
    wsClient?.dispose();
    wsClient = undefined;
    if (bridgeProcess) {
        try {
            bridgeProcess.kill();
        }
        catch { /* noop */ }
        bridgeProcess = undefined;
    }
}
//# sourceMappingURL=extension.js.map