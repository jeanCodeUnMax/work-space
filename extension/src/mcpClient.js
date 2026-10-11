// Minimal stdio MCP client: spawns `python -u server.py`, speaks NDJSON
// JSON-RPC (one object per line), maps request ids to pending promises.
// On process death the client goes "dead" and lazily respawns on the next
// request with exponential backoff so a crash loop can't spin.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const vscode = require('vscode');

const PROTOCOL_VERSION = '2024-11-05';
const MAX_BACKOFF_MS = 30_000;

class McpClient {
  /** @param {vscode.OutputChannel} output */
  constructor(output) {
    this.output = output;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    /** @type {Promise<void> | null} resolves once initialize handshake completed */
    this.readyPromise = null;
    this.crashCount = 0;
    this.lastCrashAt = 0;
    this.disposed = false;
  }

  _cfg() {
    const c = vscode.workspace.getConfiguration('everythingSearch');
    return {
      serverPath: c.get('serverPath', 'C:/Program Files/servers/everything-mcp/server.py'),
      pythonPath: c.get('pythonPath', 'python'),
      timeoutMs: c.get('requestTimeoutMs', 30_000),
    };
  }

  _log(msg) {
    this.output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  /** Best-effort pre-spawn; failures are only logged. */
  warmup() {
    this._ensureReady().catch((e) => this._log(`warmup failed: ${e.message}`));
  }

  /**
   * Call an MCP tool. Returns the `result` object of the JSON-RPC response
   * (i.e. { content, structuredContent, isError? }).
   */
  async callTool(name, args) {
    const res = await this._request('tools/call', { name, arguments: args || {} });
    // Server signals tool-level errors inside the result (isError + {error}).
    if (res && res.isError) {
      const sc = res.structuredContent;
      const msg = (sc && sc.error) ||
        (res.content && res.content[0] && res.content[0].text) ||
        'unknown tool error';
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    if (res && res.structuredContent) return res.structuredContent;
    // Fallback: content[0].text is a JSON string.
    const text = res && res.content && res.content[0] && res.content[0].text;
    if (text) {
      try { return JSON.parse(text); } catch { return { text }; }
    }
    return res;
  }

  async _request(method, params, { skipReadyCheck = false } = {}) {
    if (this.disposed) throw new Error('client disposed');
    if (!skipReadyCheck) await this._ensureReady();
    if (!this.proc) throw new Error('MCP server not running');

    const id = this.nextId++;
    const timeoutMs = this._cfg().timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${id} (${method}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('cannot send: MCP server process not writable');
    }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (e) {
      this._log(`stdin write failed: ${e.message}`);
    }
  }

  _ensureReady() {
    if (this.readyPromise) return this.readyPromise;

    const p = (async () => {
      // Backoff after crashes so we never tight-loop respawns.
      const wait = this.lastCrashAt + this._backoffMs() - Date.now();
      if (wait > 0) {
        this._log(`backing off ${wait}ms before respawn`);
        await new Promise((r) => setTimeout(r, wait));
      }
      await this._spawn();
      await this._handshake();
      this.crashCount = 0;
    })();

    this.readyPromise = p;
    // On failure, drop the cached promise so the next call retries fresh —
    // but only if no newer attempt already replaced it.
    p.catch(() => { if (this.readyPromise === p) this.readyPromise = null; });
    return p;
  }

  _backoffMs() {
    return Math.min(1000 * Math.pow(2, this.crashCount), MAX_BACKOFF_MS);
  }

  _spawn() {
    const { serverPath, pythonPath } = this._cfg();
    const cwd = path.dirname(serverPath);
    this._log(`spawning: ${pythonPath} -u "${serverPath}" (cwd=${cwd})`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(pythonPath, ['-u', serverPath], {
        cwd,
        // trusted local client -> pin the unrestricted [default] profile so a
        // stray EVERYTHING_MCP_AGENT in the env can never constrain the panel
        env: { ...process.env, EVERYTHING_MCP_AGENT: 'default' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.buf = '';

      proc.once('error', (err) => {
        this._log(`spawn error: ${err.message}`);
        this._markDead(err);
        if (!settled) { settled = true; reject(err); }
      });

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this._onStdout(chunk));

      proc.stderr.setEncoding('utf8');
      let errBuf = '';
      proc.stderr.on('data', (chunk) => {
        errBuf += chunk;
        let idx;
        while ((idx = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, idx).trimEnd();
          errBuf = errBuf.slice(idx + 1);
          if (line) this._log(`[server:stderr] ${line}`);
        }
      });

      proc.once('exit', (code, signal) => {
        this._log(`server exited: code=${code} signal=${signal}`);
        const err = new Error(`MCP server exited (code=${code}, signal=${signal})`);
        this._markDead(err);
        if (!settled) { settled = true; reject(err); }
      });

      // 'spawn' fires when the OS process is up; handshake does the real check.
      proc.once('spawn', () => {
        this._log(`server spawned, pid=${proc.pid}`);
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  async _handshake() {
    const res = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vscode-everything-search' },
    }, { skipReadyCheck: true });
    this._log(`initialized: ${JSON.stringify(res && res.serverInfo || {})}`);
    this._notify('notifications/initialized');
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this._log(`[server:stdout] non-JSON: ${line.slice(0, 200)}`);
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    // Only responses carry an id + result/error; notifications are ignored.
    if (msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) {
      this._log(`response for unknown id ${msg.id}`);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      p.resolve(msg.result);
    }
  }

  _markDead(err) {
    this.proc = null;
    this.readyPromise = null;
    this.crashCount += 1;
    this.lastCrashAt = Date.now();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  dispose() {
    this.disposed = true;
    if (this.proc) {
      try { this._notify('exit'); } catch { /* best effort */ }
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
    const err = new Error('client disposed');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { McpClient };
