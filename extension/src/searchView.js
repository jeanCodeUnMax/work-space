// Sidebar WebviewViewProvider: hosts media/panel.{js,css} and bridges
// postMessage traffic between the webview UI and the MCP client.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
      case 'submitToAgent':
        this._submitToAgent(msg.paths || []);
        break;
      case 'fsCreate':
        this._fsCreate(msg);
        break;
      case 'preview':
        this._preview(msg);
        break;
      case 'browse':
        this._browse(msg);
        break;
      case 'statPath':
        try {
          this._post({ type: 'stat', path: msg.path, dir: fs.statSync(msg.path).isDirectory() });
        } catch { this._post({ type: 'stat', path: msg.path, dir: false }); }
        break;
      case 'ready':
        break;
    }
  }

  /* Devin chat injection — protobuf payload built like the
     orchestrator-monitor extension:
       TextOrScopeItem{text} -> field 1 len-delimited
       request{items}        -> field 1 len-delimited -> base64
     actionType 'sendCascadeInput' sends a real user turn to the agent;
     'addCascadeInput' fills the composer as a draft. */
  _encodeVarint(n) {
    const out = [];
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return Buffer.from(out);
  }

  _lenField(fieldNo, data) {
    return Buffer.concat([
      Buffer.from([(fieldNo << 3) | 2]),
      this._encodeVarint(data.length),
      data,
    ]);
  }

  _chatPayload(text) {
    const item = this._lenField(1, Buffer.from(text, 'utf8'));
    return this._lenField(1, item).toString('base64');
  }

  /* Native file-mention item — same proto as Devin's drag-to-Cascade:
       TextOrScopeItem { oneof chunk: item = field2 -> ContextScopeItem {
         oneof scope_item: file = field1 | directory = field2 -> {
           absolute_uri = field1 } } }
     Sent via actionType 'fileMention' (routed "lastActive"), one
     serialized item per payload entry — produces real file chips in
     the composer, exactly like dropping files on the chat panel. */
  _scopeItemMention(absolutePath, isDir) {
    const uri = vscode.Uri.file(absolutePath).toString();
    const fileMsg = this._lenField(1, Buffer.from(uri, 'utf8'));   // {absolute_uri}
    const scope = this._lenField(isDir ? 2 : 1, fileMsg);          // CSI{file|directory}
    return this._lenField(2, scope).toString('base64');            // TSI{item}
  }

  async _submitToAgent(paths) {
    if (!paths.length) return;
    const sendAction = (actionType, payload) => vscode.commands.executeCommand(
      'devin.sendChatActionMessage',
      JSON.stringify({ actionType, payload: payload || [] }));
    // Routing map (workbench 2026-10): sendCascadeInput is NOT routed for
    // extensions — silently dropped. fileMention -> lastActive chat client
    // (native drag-to-Cascade path); addCascadeInput -> main composer;
    // sendCascadeInputNewConversation -> real turn in a fresh conv.
    try {
      // Each mention is paired with a text TSI carrying the exact absolute
      // path — the chip label alone can hide the drive (D: vs G:) and leaves
      // the agent guessing between same-name entries.
      const items = paths.flatMap((p) => {
        let dir = false;
        try { dir = fs.statSync(p).isDirectory(); } catch { /* */ }
        const pathText = this._lenField(1, Buffer.from(p + '\n', 'utf8')).toString('base64');
        return [pathText, this._scopeItemMention(p, dir)];
      });
      try { await sendAction('openChatPanel'); } catch { /* already open */ }
      await new Promise((r) => setTimeout(r, 400));
      await sendAction('fileMention', items);
      this._post({ type: 'status', message: `${paths.length} file(s) attached to chat — press Enter to send` });
      return;
    } catch { /* fall through */ }
    try {
      const text = `[Everything Search] ${paths.length} item(s) submitted for review:\n`
        + paths.join('\n');
      await sendAction('addCascadeInput', [this._chatPayload(text)]);
      this._post({ type: 'status', message: `${paths.length} path(s) in chat composer — press Enter to submit` });
      return;
    } catch { /* not routed either */ }
    try {
      const text = `[Everything Search] ${paths.length} item(s) submitted for review:\n`
        + paths.join('\n');
      await sendAction('sendCascadeInputNewConversation', [this._chatPayload(text)]);
      this._post({ type: 'status', message: `${paths.length} path(s) submitted (new conversation)` });
      return;
    } catch { /* */ }
    // last resort: clipboard + focus whatever chat panel exists
    vscode.env.clipboard.writeText(paths.join('\n'));
    this._post({ type: 'status', message: `${paths.length} path(s) copied — paste into agent chat (Ctrl+V)` });
    const candidates = [
      'devin.focusChat', 'windsurf.openChat', 'aichat.newchataction',
      'workbench.panel.chat.view.copilot.focus',
    ];
    for (const cmd of candidates) {
      try { await vscode.commands.executeCommand(cmd); return; } catch { /* unknown */ }
    }
  }

  _fsCreate(msg) {
    const parent = msg.parent;
    const name = String(msg.name || '').trim();
    const bad = /[\\/:*?"<>|]/;
    if (!parent || !name || bad.test(name)) {
      this._post({ type: 'fsCreated', error: 'invalid name or target', parent, name });
      return;
    }
    const target = path.join(parent, name);
    try {
      if (msg.kind === 'dir') fs.mkdirSync(target);
      else fs.writeFileSync(target, '', { flag: 'wx' }); // no clobber
      this._post({ type: 'fsCreated', path: target });
    } catch (e) {
      this._post({ type: 'fsCreated', error: String(e && e.message || e), path: target });
    }
  }

  _preview(msg) {
    const p = msg.path;
    const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
    try {
      const st = fs.statSync(p);
      const e = (msg.ext || '').toLowerCase();
      if (IMG_MIME[e]) {
        if (st.size > 8 * 1024 * 1024) { this._post({ type: 'preview', path: p, size: st.size, error: 'image too large (>8 MB)' }); return; }
        const b64 = fs.readFileSync(p).toString('base64');
        this._post({ type: 'preview', path: p, size: st.size, kind: 'image', data: `data:${IMG_MIME[e]};base64,${b64}` });
      } else {
        const buf = Buffer.alloc(Math.min(64 * 1024, st.size));
        const fd = fs.openSync(p, 'r');
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        this._post({ type: 'preview', path: p, size: st.size, kind: 'text', data: buf.toString('utf8') });
      }
    } catch (e) {
      this._post({ type: 'preview', path: p, error: String(e && e.message || e) });
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

  _browse(msg) {
    const p = msg.path || '';
    try {
      if (!p) {
        // PC level: drive letters (fixed, USB, network-mapped) + cloud/shell dirs
        const results = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
          .filter((L) => fs.existsSync(L + ':\\'))
          .map((L) => ({ name: L + ':', path: L + ':\\', dir: true, size: 0, ico: '💾' }));
        try {
          const home = os.homedir();
          for (const n of fs.readdirSync(home)) {
            const fp = path.join(home, n);
            if (/^(onedrive|google drive|dropbox|icloud)/i.test(n) && fs.statSync(fp).isDirectory()) {
              results.push({ name: n, path: fp, dir: true, size: 0, ico: '☁' });
            }
          }
        } catch { /* */ }
        this._post({ type: 'browse', seq: msg.seq, payload: { results, total: results.length } });
        return;
      }
      const results = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
        const fp = path.join(p, e.name);
        let size = 0;
        let mtime = null;
        try {
          const st = fs.statSync(fp);
          size = st.size;
          mtime = st.mtimeMs / 1000;
        } catch { /* locked/gone */ }
        return { name: e.name, path: fp, dir: e.isDirectory(), size: e.isDirectory() ? 0 : size, mtime };
      }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      this._post({ type: 'browse', seq: msg.seq, payload: { results, total: results.length } });
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
    // Shared DOM fragment — single source with dev/preview.html
    const body = fs.readFileSync(
      path.join(this.context.extensionUri.fsPath, 'media', 'panel.html'), 'utf8');
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
${body}
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { SearchViewProvider };
