import * as vscode from 'vscode';

export function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
    const stamp = Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css')) + `?v=${stamp}`;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js')) + `?v=${stamp}`;
    const agentsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'agents'));
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
</head>
<body>
<header class="top">
  <button type="button" id="providerBtn" class="top-provider-btn" title="Cliquer pour copier l'identifiant du chat (Protocole Binôme)">
    <strong id="providerName">Fournisseur</strong>
  </button>
  <span class="spacer"></span>
  <button type="button" id="historyBtn" class="history-pill" title="Historique des conversations">
    <span>🕒 Historique</span>
    <span class="chevron">▾</span>
  </button>
  <div id="historyMenu" class="dropdown-menu history-dropdown" hidden>
    <div class="history-dropdown-header">Historique des sessions</div>
    <div id="historyList" class="history-scroll-list"></div>
  </div>
</header>

<main id="transcript" class="transcript-container"></main>

<div class="composer-container">
  <!-- Menu auto-complétion commandes slash -->
  <div id="slashMenu" class="slash-suggestions" hidden>
    <div class="slash-item" data-cmd="/help"><strong>/help</strong> <span>Aide et liste des commandes</span></div>
    <div class="slash-item" data-cmd="/chat-id"><strong>/chat-id</strong> <span>Afficher et copier l'ID de session binôme</span></div>
    <div class="slash-item" data-cmd="/jointes"><strong>/jointes &lt;agent&gt;</strong> <span>Protocole binôme (rejoindre un agent)</span></div>
    <div class="slash-item" data-cmd="/plan"><strong>/plan</strong> <span>Basculer en mode Plan</span></div>
    <div class="slash-item" data-cmd="/ask"><strong>/ask</strong> <span>Basculer en mode Ask</span></div>
    <div class="slash-item" data-cmd="/agent"><strong>/agent</strong> <span>Basculer en mode Agent</span></div>
    <div class="slash-item" data-cmd="/debug"><strong>/debug</strong> <span>Basculer en mode Debug</span></div>
    <div class="slash-item" data-cmd="/skills"><strong>/skills</strong> <span>Lister les compétences Hephaistos</span></div>
    <div class="slash-item" data-cmd="/clear"><strong>/clear</strong> <span>Effacer l'historique du fil</span></div>
    <div class="slash-item" data-cmd="/status"><strong>/status</strong> <span>État de l'orchestrateur et modèles</span></div>
  </div>

  <div class="composer-box">
    <textarea id="draft" rows="1" placeholder="Tape un message ou '/' pour les commandes..."></textarea>
    <div class="composer-toolbar">
      <div class="selector-group">
        <button type="button" class="pill-btn mode-pill" id="modeBtn" title="Changer le mode opérationnel">
          <span class="mode-dot"></span>
          <span id="modeLabel">Agent</span>
        </button>
        <button type="button" class="pill-btn model-pill" id="modelBtn" title="Changer de modèle">
          <span id="modelLabel">Modèle</span>
        </button>
      </div>
      <span class="spacer"></span>
      <div class="composer-actions">
        <span class="composer-hint">Entrée ↵ pour envoyer</span>
        <button type="button" id="send" class="send-btn" aria-label="Envoyer" disabled>
          <span class="send-icon">↑</span>
        </button>
      </div>
    </div>
  </div>

  <div id="modeMenu" class="dropdown-menu mode-dropdown" hidden></div>

  <div id="modelMenu" class="dropdown-menu model-dropdown" hidden>
    <div class="search-box">
      <input type="text" id="modelSearch" placeholder="🔍 Rechercher un modèle..." autocomplete="off">
    </div>
    <div id="modelList" class="model-scroll-list"></div>
  </div>
</div>

<script nonce="${nonce}">
window.addEventListener('error', function (e) {
  var t = e && e.target;
  if (t && t.tagName === 'SCRIPT') {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#e8d9c0;background:#161311;font-family:monospace;font-size:13px;padding:24px;text-align:center;z-index:9999';
    d.textContent = 'Le script du chat n\'a pas pu se charger — recharge la fenêtre (Developer: Reload Window).';
    document.body.appendChild(d);
  }
}, true);
</script>
<script nonce="${nonce}">window.__agentsUri="${agentsUri}";</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
