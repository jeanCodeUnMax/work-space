"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPanelHtml = getPanelHtml;
exports.getNonce = getNonce;
const vscode = require("vscode");
const GROUPS = [
    { status: "in_progress", collapsed: false },
    { status: "pending", collapsed: false },
    { status: "failed", collapsed: true },
    { status: "completed", collapsed: true },
];
// Colonnes : ordre + largeurs pilotés par panel.js (drag & drop + resize).
// Toutes les colonnes ont une largeur explicite : le resize n'agit que sur la
// colonne visée (pas de redistribution), le dépassement passe en scroll.
const COL_DEFAULT_W = {
    id: 44,
    title: 280,
    priority: 82,
    type: 92,
    model: 165,
    agent: 105,
    created: 122,
    actions: 34,
    statuslight: 30,
    session: 110,
};
const COLS = [
    "statuslight",
    "id",
    "title",
    "priority",
    "type",
    "model",
    "agent",
    "session",
    "created",
    "actions",
];
function taskGroupHtml(status, collapsed) {
    const colgroup = COLS.map((c) => `<col data-col="${c}"${COL_DEFAULT_W[c] ? ` style="width:${COL_DEFAULT_W[c]}px"` : ""}`).join("");
    const headers = COLS.map((c) => c === "actions"
        ? `<th data-col="actions" class="col-actions" draggable="true"><span class="th-text th-actions-icon">&#8679;</span><span class="col-resizer"></span></th>`
        : `<th data-col="${c}" draggable="true"><span class="th-text" data-i18n="th.${c}"></span><span class="col-resizer"></span></th>`).join("");
    return `
                <div class="task-group${collapsed ? " collapsed" : ""}" data-status="${status}">
                    <div class="task-group-header" role="button" tabindex="0">
                        <span class="group-chevron">&#9662;</span>
                        <span class="group-label" data-i18n="group.${status}"></span>
                        <button class="group-action-btn" data-copy-group="${status}" data-i18n-title="tasks.sendGroup" title="">&#8679;</button>
                        <button class="group-action-btn group-purge-btn" data-purge-group="${status}" data-i18n-title="tasks.purgeGroup" title="">&#128465;</button>
                        <span class="group-count" id="gcount-${status}">0</span>
                    </div>
                    <div class="task-group-body">
                        <table class="tasks-table">
                            <colgroup>${colgroup}</colgroup>
                            <thead>
                                <tr>${headers}</tr>
                            </thead>
                            <tbody id="tbody-${status}"></tbody>
                        </table>
                    </div>
                    <div class="group-resizer" data-resize="${status}" title=""></div>
                </div>`;
}
/**
 * Génère le HTML partagé (panneau éditeur ET vue sidebar identiques).
 * Toutes les chaînes passent par data-i18n + media/i18n.js (fr/en/de/es).
 */
function getPanelHtml(webview, extensionUri, opts = {}) {
    const i18nUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "i18n.js"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.css"));
    const bannerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "hephaistos-banderole.jpg"));
    const commsFeedJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "comms-feed.js"));
    const commsFeedCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "comms-feed.css"));
    const nonce = getNonce();
    const expandBtn = opts.compact
        ? `<button id="btn-expand" class="btn btn-icon-only" data-i18n-title="btn.expand" title="">&#10530;</button>`
        : "";
    return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${commsFeedCssUri}">
    <title>Orchestrator Monitor</title>
</head>
<body class="${opts.compact ? "compact" : ""}">
    <div class="monitor-container">
        <!-- Banderole Hephaistos-Kit -->
        <div class="brand-banner">
            <img src="${bannerUri}" alt="Hephaistos-Kit — The Developer's Forge" />
            <div class="brand-overlay">
                <span class="brand-title">Hephaistos Orchestrator Monitor</span>
                <span class="brand-subtitle">Extension du Hephaistos-Kit — supervision de l'orchestrateur multi-agents</span>
            </div>
        </div>

        <!-- En-tête principal -->
        <header class="monitor-header">
            <div class="header-left">
                <h1>Tâches & Agents</h1>
                <div class="connection-status" id="ws-indicator" title="WebSocket">
                    <span class="status-dot disconnected" id="ws-dot"></span>
                    <span class="status-label" id="ws-status-text" data-i18n="conn.disconnected"></span>
                </div>
            </div>
            <div class="header-right">
                <span class="last-update" id="last-update-text" data-i18n="sync.waiting"></span>
                ${expandBtn}
                <div class="settings-wrap">
                    <button id="btn-settings" class="btn btn-icon-only" data-i18n-title="btn.settings" title="">&#9881;</button>
                    <div id="settings-menu" class="settings-menu hidden">
                        <div class="settings-label" data-i18n="menu.language"></div>
                        <button class="settings-item settings-lang" data-lang="fr">Français</button>
                        <button class="settings-item settings-lang" data-lang="en">English</button>
                        <button class="settings-item settings-lang" data-lang="de">Deutsch</button>
                        <button class="settings-item settings-lang" data-lang="es">Español</button>
                        <div class="settings-sep"></div>
                        <button class="settings-item" data-action="refresh" data-i18n="menu.refresh"></button>
                        <button class="settings-item" data-action="restart-bridge" data-i18n="menu.restart"></button>
                    </div>
                </div>
            </div>
        </header>

        <!-- Feed comms inter-agents (Devin ⇄ AGY ⇄ CLIs) — temps réel -->
        <section class="comms-section" id="comms-section">
            <div class="section-header" id="comms-toggle" role="button" tabindex="0">
                <span class="group-chevron">&#9662;</span>
                <span data-i18n="comms.title">Comms inter-agents</span>
            </div>
            <div id="comms-feed" class="comms-feed" aria-live="polite"></div>
            <div class="group-resizer" data-resize="comms" title=""></div>
        </section>

        <!-- Cartes synthétiques (KPIs) -->
        <section class="summary-section">
            <div class="summary-card card-in-progress">
                <div class="summary-value" id="kpi-in-progress">0</div>
                <div class="summary-label" data-i18n="kpi.inprogress"></div>
            </div>
            <div class="summary-card card-pending">
                <div class="summary-value" id="kpi-pending">0</div>
                <div class="summary-label" data-i18n="kpi.pending"></div>
            </div>
            <div class="summary-card card-completed">
                <div class="summary-value" id="kpi-completed">0</div>
                <div class="summary-label" data-i18n="kpi.completed"></div>
            </div>
            <div class="summary-card card-failed">
                <div class="summary-value" id="kpi-failed">0</div>
                <div class="summary-label" data-i18n="kpi.failed"></div>
            </div>
            <div class="summary-card card-agents">
                <div class="summary-value" id="kpi-agents">0</div>
                <div class="summary-label" data-i18n="kpi.agents"></div>
            </div>
        </section>

        <!-- Section des tâches : 4 groupes dépliables -->
        <section class="tasks-section">
            <div class="section-toolbar">
                <h2><span data-i18n="tasks.title"></span> (<span id="tasks-count">0</span>)</h2>
                <div class="toolbar-filters">
                    <input type="text" id="task-search-input" class="input-search" data-i18n-ph="tasks.search" placeholder="" />
                </div>
            </div>

            <div class="task-groups" id="task-groups">
${GROUPS.map((g) => taskGroupHtml(g.status, g.collapsed)).join("\n")}
            </div>
        </section>

        <!-- Section des agents (dépliable, comme les groupes de tâches) -->
        <section class="agents-section task-group" id="agents-group">
            <div class="task-group-header" role="button" tabindex="0">
                <span class="group-chevron">&#9662;</span>
                <h2 class="group-title-h2"><span data-i18n="agents.title"></span> (<span id="agents-count">0</span>)</h2>
            </div>
            <div class="task-group-body">
                <div class="agents-grid" id="agents-grid-container"></div>
            </div>
        </section>
    </div>
    <script nonce="${nonce}" src="${i18nUri}"></script>
    <script nonce="${nonce}" src="${commsFeedJsUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
function getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=panelHtml.js.map