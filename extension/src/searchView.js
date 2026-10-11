// Sidebar WebviewViewProvider: hosts media/panel.{js,css} and bridges
// postMessage traffic between the webview UI and the MCP client.
'use strict';

const { execFile } = require('child_process');
const vscode = require('vscode');
const { McpClient } = require('./mcpClient'); // eslint-disable-line no-unused-vars -- JSDoc type

class SearchViewProvider {
  static viewType = 'everything-search.searchView';

  /**
   * @param {vscode.ExtensionContext} context
   * @param {McpClient} client
   * @param {vscode.OutputChannel} output
   */
  constructor(context, client, output) {
    this.context = context;
    this.client = client;
    this.output = output;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    this.lastDragged = undefined; // fallback for dragstart postMessage
  }

  /** Focus the activity-bar container + this view (command entry point). */
  reveal() {
    vscode.commands.executeCommand(`${SearchViewProvider.viewType}.focus`);
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = this._html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this._onMessage(msg), undefined, this.context.subscriptions);
    view.onDidDispose(() => { this.view = undefined; });
  }

  _onMessage(msg) {
    switch (msg && msg.type) {
      case 'search':
        this._search(msg);
        break;
      case 'open':
        this._open(msg.path, !!msg.dir);
        break;
      case 'reveal':
        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.path));
        break;
      case 'copyPath':
        vscode.env.clipboard.writeText(msg.path);
        break;
      case 'openContaining':
        this._openContaining(msg.path);
        break;
      case 'dragStart':
        // dataTransfer already carries the file; this is a bookkeeping fallback.
        this.lastDragged = msg.path;
        break;
      case 'ready':
        break;
    }
  }

  async _search(msg) {
    const cfg = vscode.workspace.getConfiguration('everythingSearch');
    const args = {
      query: msg.query || '',
      max_results: cfg.get('maxResults', 500),
      sort: msg.sort || 'name',
      descending: !!msg.descending,
    };
    try {
      const payload = await this.client.callTool('everything_search', args);
      this._post({ type: 'results', seq: msg.seq, payload, renderCap: cfg.get('renderCap', 500) });
    } catch (e) {
      this._post({ type: 'error', seq: msg.seq, message: String(e && e.message || e) });
    }
  }

  _open(p, isDir) {
    const uri = vscode.Uri.file(p);
    if (isDir) {
      // Light touch: select the dir in the Explorer rather than openFolder.
      vscode.commands.executeCommand('revealInExplorer', uri);
    } else {
      vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  _openContaining(p) {
    // explorer.exe exits nonzero even on success — fire and forget.
    execFile('explorer.exe', [`/select,${p}`], () => {});
  }

  _post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  _html(webview) {
    const media = (f) => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = String(Date.now()) + String(Math.random()).slice(2);
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('panel.css')}">
<title>Everything Search</title>
</head>
<body>
  <div id="toolbar">
    <input id="q" type="text" autocomplete="off" spellcheck="false"
           placeholder="Search everything&hellip; (ext:py;txt, size:&gt;10mb, dm:today, folder:)">
  </div>
  <div id="status">Type to search&hellip;</div>
  <div id="resultsWrap">
    <table id="results">
      <thead>
        <tr>
          <th class="icon"></th>
          <th data-sort="name">Name <span class="arrow"></span></th>
          <th data-sort="path">Path <span class="arrow"></span></th>
          <th data-sort="size" class="num">Size <span class="arrow"></span></th>
          <th data-sort="date">Modified <span class="arrow"></span></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div id="ctxMenu" class="hidden">
    <div class="item" data-act="open">Open</div>
    <div class="item" data-act="copyPath">Copy Path</div>
    <div class="item" data-act="openContaining">Open Containing Folder</div>
    <div class="item" data-act="reveal">Reveal in Explorer</div>
  </div>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { SearchViewProvider };
