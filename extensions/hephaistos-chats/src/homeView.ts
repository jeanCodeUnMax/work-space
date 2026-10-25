import * as vscode from 'vscode';
import { AcpProvider, ChatSession, sessionTitle } from './types';

export interface HomeState {
    sessions: ChatSession[];
    providers: AcpProvider[];
    status: string;
    orchConnected?: boolean;
    orchStats?: { agents: number; tasks: number };
}

export class HomeView implements vscode.WebviewViewProvider {
    static readonly viewId = 'hephaistosChats.list';
    private view: vscode.WebviewView | undefined;
    private state: HomeState = { sessions: [], providers: [], status: '' };

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly onMessage: (message: { type: string; id?: string; enabled?: boolean; provider?: string }) => void,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.onDidReceiveMessage((message) => this.onMessage(message));
        this.paint();
    }

    show(state: HomeState): void {
        this.state = state;
        this.paint();
    }

    private paint(): void {
        if (!this.view) {
            return;
        }
        try {
            this.paintInner();
        } catch (e: any) {
            // Une donnée corrompue ne doit plus jamais laisser la vue grise :
            // on affiche l'erreur dans le panneau lui-même.
            const msg = String(e?.message || e).replace(/</g, '&lt;');
            this.view.webview.html = `<!DOCTYPE html><html><body style="font-family:monospace;padding:12px;color:#f88"><b>Hephaistos Chats — erreur de rendu</b><pre>${msg}</pre></body></html>`;
        }
    }

    private paintInner(): void {
        const view = this.view!;
        const nonce = Math.random().toString(36).slice(2);
        const bannerUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'hephaistos-banderole.jpg'));

        const sessionsJson = JSON.stringify(this.state.sessions.map((s) => ({
            id: s.id,
            title: sessionTitle(s),
            mode: s.mode,
            model: s.model || '',
            provider: s.provider,
            updatedAt: s.updatedAt,
            msgCount: Array.isArray(s.messages) ? s.messages.length : 0,
        })));

        const providersJson = JSON.stringify(this.state.providers);
        const isConnected = !!this.state.orchConnected;
        const orchAgents = this.state.orchStats?.agents ?? 0;
        const orchTasks = this.state.orchStats?.tasks ?? 0;

        view.webview.html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
  --bg-color: var(--vscode-editor-background, #1e1e1e);
  --text-color: var(--vscode-editor-foreground, #cccccc);
  --border-color: var(--vscode-editorWidget-border, #333333);
  --header-bg: var(--vscode-sideBar-background, #252526);
  --card-bg: var(--vscode-editorWidget-background, #252526);
  --hover-bg: var(--vscode-list-hoverBackground, #2a2d2e);
  --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  margin: 0; padding: 10px;
  background-color: var(--bg-color);
  color: var(--text-color);
  font-family: var(--font-family);
  font-size: var(--vscode-font-size, 12px);
  line-height: 1.4;
  overflow-x: hidden;
}
button, input, select { font: inherit; color: inherit; }

/* Banderole Hephaistos2-Kit style Orchestrator Monitor */
.brand-banner {
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  line-height: 0;
  width: 100%;
  margin-bottom: 10px;
}
.brand-banner img {
  width: 100%;
  height: auto;
  display: block;
}
.brand-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 6px 10px;
  background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.75) 100%);
  line-height: 1.25;
}
.brand-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #ffd9a0;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.brand-subtitle {
  font-size: 10px;
  color: #e8e8e8;
  opacity: 0.88;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
}

/* En-tête statut orchestrateur */
.orch-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 8px; border-radius: 5px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-color);
  margin-bottom: 10px; font-size: 11px;
}
.orch-status {
  display: flex; align-items: center; gap: 6px; font-weight: 500;
}
.status-dot {
  width: 7px; height: 7px; border-radius: 50%; display: inline-block;
}
.status-dot.connected { background-color: #3fb950; box-shadow: 0 0 6px rgba(63, 185, 80, 0.6); }
.status-dot.disconnected { background-color: #f85149; box-shadow: 0 0 6px rgba(248, 81, 73, 0.6); }
.orch-info {
  font-size: 10px; color: var(--vscode-descriptionForeground, #888);
}

.workspace-card {
  margin: 0 auto 12px;
  width: 96%;
  max-width: 320px;
  padding: 9px;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  background: linear-gradient(145deg, rgba(200, 133, 64, 0.12), var(--card-bg) 58%);
}
.workspace-card-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px; font-size: 11px; font-weight: 600;
}
.workspace-card-head span:last-child {
  color: var(--vscode-descriptionForeground, #888); font-size: 9px; font-weight: 400;
}
.workspace-preview {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  min-height: 58px; padding: 6px; margin-bottom: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 5px;
  background-color: var(--vscode-editor-background, #1e1e1e);
  background-image: radial-gradient(rgba(255, 255, 255, 0.13) 0.7px, transparent 0.7px);
  background-size: 10px 10px;
}
.workspace-preview-node {
  flex: 1; min-width: 0; padding: 5px 3px;
  border: 1px solid rgba(221, 172, 111, 0.45); border-radius: 4px;
  background: var(--card-bg); color: var(--vscode-foreground, #ddd);
  text-align: center; font-size: 8px; white-space: nowrap;
}
.workspace-preview-link {
  width: 9px; height: 1px; flex: 0 0 9px; background: #d99b52;
}
.workspace-open {
  width: 100%; padding: 5px 8px; border: 0; border-radius: 4px;
  background: var(--vscode-button-background, #9c6128);
  color: var(--vscode-button-foreground, #fff); cursor: pointer;
  font-size: 11px; font-weight: 600;
}
.workspace-open:hover { background: var(--vscode-button-hoverBackground, #b97536); }

/* Zone Nouveau Chat Recadrée (Largeur contrôlée et centrée) */
.new-chat-wrapper {
  margin: 0 auto 12px;
  width: 96%;
  max-width: 320px;
  background-color: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 7px;
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
}
.new-chat-label {
  font-size: 11px; font-weight: 600; color: var(--vscode-foreground, #eee);
  display: flex; align-items: center; gap: 5px;
}
.provider-select-wrap {
  width: 100%;
}
.provider-select {
  width: 100%; padding: 5px 8px; border-radius: 4px;
  background: var(--vscode-dropdown-background, #1f1f1f);
  color: var(--vscode-dropdown-foreground, #fff);
  border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
  outline: none; cursor: pointer; font-size: 11px;
}
.provider-select:focus {
  border-color: var(--vscode-focusBorder, #007acc);
}
.btn-create-chat {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  background: var(--vscode-button-background, #007acc);
  color: var(--vscode-button-foreground, #ffffff);
  border: 0; border-radius: 4px; padding: 6px 10px;
  font-weight: 600; font-size: 11px; cursor: pointer;
  transition: background 0.15s, transform 0.05s;
}
.btn-create-chat:hover {
  background: var(--vscode-button-hoverBackground, #0062a3);
}
.btn-create-chat:active {
  transform: scale(0.99);
}

/* Titres de sections */
.section-header {
  margin: 10px 0 5px; font-size: 11px; font-weight: 600;
  letter-spacing: .05em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground, #888);
  display: flex; justify-content: space-between; align-items: center;
}
.badge-count {
  font-size: 10px; font-weight: normal; opacity: 0.7;
}

/* Recherche */
.search-input {
  width: 100%; padding: 5px 8px; border-radius: 4px;
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  background: var(--vscode-input-background, #252526);
  color: var(--vscode-input-foreground, #ccc);
  margin-bottom: 6px; outline: none; font-size: 11px;
}
.search-input:focus { border-color: var(--vscode-focusBorder, #007acc); }

/* Liste des sessions */
.session-list {
  display: flex; flex-direction: column; gap: 3px;
  max-height: 200px; overflow-y: auto; padding-right: 2px;
}
.session-card {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; border: 1px solid transparent; border-radius: 5px; padding: 5px 7px;
  background: rgba(255, 255, 255, 0.02); color: inherit; text-align: left; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.session-card:hover {
  background: var(--hover-bg);
  border-color: var(--border-color);
}
.session-info {
  display: flex; flex-direction: column; gap: 1px; overflow: hidden; max-width: 86%;
}
.session-title {
  font-weight: 500; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--vscode-foreground, #eee);
}
.session-meta {
  display: flex; align-items: center; gap: 5px; font-size: 10px;
  color: var(--vscode-descriptionForeground, #888);
}
.badge-mode {
  padding: 1px 4px; border-radius: 3px; font-size: 8px; font-weight: 600; text-transform: uppercase;
}
.badge-mode.agent { background: rgba(14, 99, 156, 0.3); color: #58a6ff; }
.badge-mode.plan { background: rgba(137, 87, 229, 0.3); color: #bc8cff; }
.badge-mode.ask { background: rgba(46, 160, 67, 0.3); color: #7ee787; }
.badge-mode.debug { background: rgba(210, 153, 34, 0.3); color: #d29922; }

.session-del-btn {
  background: transparent; border: 0; opacity: 0; cursor: pointer; padding: 2px 4px;
  border-radius: 3px; font-size: 10px; transition: opacity 0.15s, background 0.15s;
}
.session-card:hover .session-del-btn { opacity: 0.7; }
.session-del-btn:hover { opacity: 1 !important; background: rgba(248, 81, 73, 0.2); }

/* Liste Fournisseurs Actifs (inchangée pour toggler les providers) */
.providers-box {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;
}
.provider-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--border-color);
  color: var(--vscode-descriptionForeground, #999);
  font-size: 10px; cursor: pointer; user-select: none;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.provider-chip:hover {
  background: rgba(255, 255, 255, 0.04);
}
.provider-chip:has(input:checked) {
  color: var(--vscode-foreground, #eee);
  border-color: var(--vscode-focusBorder, #007acc);
  background: rgba(0, 122, 204, 0.1);
}
.provider-chip input { margin: 0; cursor: pointer; }

/* Pied de page et barre de statut */
.bottom-bar {
  margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border-color);
  display: flex; flex-direction: column; gap: 5px;
}
.btn-refresh {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 5px;
  background: transparent; border: 1px solid var(--border-color);
  border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer;
  color: var(--vscode-descriptionForeground, #aaa);
}
.btn-refresh:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.08));
  color: var(--vscode-foreground, #fff);
}
.status-text {
  font-size: 10px; color: var(--vscode-descriptionForeground, #888);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.empty-msg {
  color: var(--vscode-descriptionForeground, #888); margin: 6px 0; font-size: 11px;
}
</style>
</head>
<body>

<!-- Banderole officielle Hephaistos2-Kit -->
<div class="brand-banner">
  <img src="${bannerUri}" alt="Hephaistos2-Kit — The Developer's Forge" />
  <div class="brand-overlay">
    <span class="brand-title">Hephaistos Chats</span>
    <span class="brand-subtitle">The Developer's Forge — Dialogues Multi-Agents</span>
  </div>
</div>

<!-- Bannière statut Orchestrateur Hephaistos -->
<div class="orch-banner">
  <div class="orch-status">
    <span class="status-dot ${isConnected ? 'connected' : 'disconnected'}"></span>
    <span>${isConnected ? 'Orchestrateur relié' : 'Orchestrateur hors ligne'}</span>
  </div>
  <div class="orch-info">
    ${isConnected ? `${orchAgents} agents · ${orchTasks} tâches` : 'Port 7477'}
  </div>
</div>

<!-- Sélecteur de Fournisseur & Bouton Nouveau Chat Recadré -->
<div class="new-chat-wrapper">
  <label for="providerSelect" class="new-chat-label">
    <span>⚡ Fournisseur pour le chat :</span>
  </label>
  <div class="provider-select-wrap">
    <select id="providerSelect" class="provider-select">
      <!-- Options générées dynamiquement -->
    </select>
  </div>
  <button type="button" class="btn-create-chat" id="createChatBtn">
    <span>+ Nouveau Chat sur ce fournisseur</span>
  </button>
</div>

<section class="workspace-card" aria-label="Espace de travail visuel">
  <div class="workspace-card-head">
    <span>Espace de travail</span>
    <span>React Flow</span>
  </div>
  <div class="workspace-preview" aria-hidden="true">
    <span class="workspace-preview-node">Départ</span>
    <span class="workspace-preview-link"></span>
    <span class="workspace-preview-node">Agent IA</span>
    <span class="workspace-preview-link"></span>
    <span class="workspace-preview-node">Résultat</span>
  </div>
  <button type="button" class="workspace-open" id="openWorkspaceBtn">
    Ouvrir l’espace de travail
  </button>
</section>

<!-- Section Chats Récents -->
<div class="section-header">
  <span>Chats Récents</span>
  <span id="sessionCount" class="badge-count"></span>
</div>
<input type="text" class="search-input" id="search" placeholder="🔍 Filtrer les conversations...">
<div id="sessions" class="session-list"></div>

<!-- Section Fournisseurs Actifs (inchangée pour toggler les providers) -->
<div class="section-header">
  <span>Fournisseurs Actifs</span>
  <span id="providerCount" class="badge-count"></span>
</div>
<div id="providers" class="providers-box"></div>

<!-- Pied de page -->
<div class="bottom-bar">
  <button type="button" class="btn-refresh" id="pingBtn">
    <span>🔄 Actualiser modèles &amp; orchestrateur</span>
  </button>
  <div class="status-text" id="status">${(this.state.status || '').replace(/</g, '&lt;')}</div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const sessionsData = ${sessionsJson};
const providersData = ${providersJson};

function renderProviderSelect() {
  const select = document.getElementById('providerSelect');
  select.innerHTML = providersData.map(p => {
    return \`<option value="\${p.id}">\${escapeHtml(p.label)}\${p.enabled ? '' : ' (inactif)'}</option>\`;
  }).join('');
}

function renderSessions(filter = '') {
  const container = document.getElementById('sessions');
  const term = filter.toLowerCase().trim();
  const filtered = sessionsData.filter(s =>
    !term || s.title.toLowerCase().includes(term) || s.model.toLowerCase().includes(term) || (s.provider && s.provider.toLowerCase().includes(term))
  );

  document.getElementById('sessionCount').textContent = filtered.length ? '(' + filtered.length + ')' : '';

  if (!filtered.length) {
    container.innerHTML = '<p class="empty-msg">Aucun chat enregistré.</p>';
    return;
  }

  container.innerHTML = filtered.map(s => {
    const timeStr = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return \`
      <div class="session-card" data-id="\${s.id}" title="Ouvrir cette conversation (\${escapeHtml(s.provider || '')})">
        <div class="session-info">
          <span class="session-title">\${escapeHtml(s.title)}</span>
          <span class="session-meta">
            <span class="badge-mode \${s.mode}">\${s.mode}</span>
            <span>\${escapeHtml(s.model)}</span>
            <span>· \${timeStr}</span>
          </span>
        </div>
        <button type="button" class="session-del-btn" title="Supprimer la conversation" data-del="\${s.id}">🗑️</button>
      </div>
    \`;
  }).join('');
}

function renderProvidersList() {
  const container = document.getElementById('providers');
  const activeCount = providersData.filter(p => p.enabled).length;
  document.getElementById('providerCount').textContent = '(' + activeCount + '/' + providersData.length + ')';

  container.innerHTML = providersData.map(p => {
    const checked = p.enabled ? 'checked' : '';
    return \`
      <label class="provider-chip" title="Activer / Désactiver \${escapeHtml(p.label)}">
        <input type="checkbox" data-provider="\${p.id}" \${checked}>
        <span>\${escapeHtml(p.label)}</span>
      </label>
    \`;
  }).join('');
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('createChatBtn').onclick = () => {
  const sel = document.getElementById('providerSelect');
  const provider = sel ? sel.value : 'openrouter';
  vscode.postMessage({ type: 'new', provider });
};

document.getElementById('openWorkspaceBtn').onclick = () => {
  vscode.postMessage({ type: 'open_workspace' });
};

document.getElementById('pingBtn').onclick = () => {
  vscode.postMessage({ type: 'ping' });
};

document.getElementById('search').oninput = (e) => {
  renderSessions(e.target.value);
};

document.getElementById('sessions').onclick = (e) => {
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) {
    e.stopPropagation();
    vscode.postMessage({ type: 'delete', id: delBtn.dataset.del });
    return;
  }
  const card = e.target.closest('.session-card');
  if (card && card.dataset.id) {
    vscode.postMessage({ type: 'open', id: card.dataset.id });
  }
};

document.getElementById('providers').onchange = (e) => {
  const input = e.target;
  if (input && input.dataset && input.dataset.provider) {
    vscode.postMessage({ type: 'provider', id: input.dataset.provider, enabled: input.checked });
  }
};

renderProviderSelect();
renderSessions();
renderProvidersList();
</script>
</body>
</html>`;
    }
}
