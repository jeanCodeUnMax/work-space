// Minimal stdio MCP client: spawns `python -u server.py`, speaks NDJSON
// JSON-RPC (one object per line), maps request ids to pending promises.
// On process death the client goes "dead" and lazily respawns on the next
// request with exponential backoff so a crash loop can't spin.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const PROTOCOL_VERSION = '2024-11-05';
const MAX_BACKOFF_MS = 30_000;

class McpClient {
  /**
   * @param {vscode.OutputChannel} output
   * @param {string} [extensionPath] install dir — used to locate the bundled server
   */
  constructor(output, extensionPath) {
    this.output = output;
    this.extensionPath = extensionPath || '';
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
      serverPath: c.get('serverPath', ''),
      pythonPath: c.get('pythonPath', ''),
      hpheBinaryPath: c.get('hpheBinaryPath', ''),
      preferHphe: c.get('preferHphe', true), // Rust binary preferred by default
      timeoutMs: c.get('requestTimeoutMs', 30_000),
    };
  }

  /**
   * Detect platform-specific hphe-mcp.exe bundled with the extension.
   * The Rust binary eliminates the Python dependency and solves the
   * 'spawn python ENOENT' error on machines without Python installed.
   */
  _hpheBinaryPath() {
    const cfg = this._cfg().hpheBinaryPath;
    if (cfg) {
      if (fs.existsSync(cfg)) return cfg;
      this._log(`configured hpheBinaryPath missing: ${cfg} — falling back to bundled binary`);
    }
    const bundled = path.join(this.extensionPath, 'server', 'hphe-mcp.exe');
    if (fs.existsSync(bundled)) return bundled;
    return null;
  }

  /**
   * Resolve server.py: configured path first, then the copy bundled in the
   * extension so the VSIX works on machines without the repo checkout.
   */
  _serverPath() {
    const cfg = this._cfg().serverPath;
    if (cfg) {
      if (fs.existsSync(cfg)) return cfg;
      this._log(`configured serverPath missing: ${cfg} — falling back to bundled server`);
    }
    const bundled = path.join(this.extensionPath, 'server', 'server.py');
    if (fs.existsSync(bundled)) return bundled;
    if (cfg) return cfg; // let the error surface for a clearer message
    throw new Error(
      'MCP server introuvable : configurez everythingSearch.serverPath ' +
      'ou réinstallez l\'extension (server/server.py absent)'
    );
  }

  /**
   * Python interpreters to try, in order. A configured pythonPath wins;
   * otherwise we probe python / python3 / py (Windows launcher).
   */
  _pythonCandidates() {
    const cfg = this._cfg().pythonPath;
    const list = cfg ? [cfg] : [];
    for (const exe of ['python', 'python3', 'py']) {
      if (!list.includes(exe)) list.push(exe);
    }
    return list;
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

  async _spawn() {
    // Strategy: try hphe-mcp.exe (Rust, no dependencies) first, fallback to Python.
    // The Rust binary eliminates 'spawn python ENOENT' entirely.
    const cfg = this._cfg();
    if (cfg.preferHphe) {
      const hphePath = this._hpheBinaryPath();
      if (hphePath) {
        try {
          this._log(`trying hphe-mcp.exe (Rust, no Python needed): ${hphePath}`);
          await this._trySpawn(hphePath, [], hphePath);
          return;
        } catch (e) {
          this._log(`hphe-mcp.exe failed: ${e.message} — falling back to Python`);
        }
      } else {
        this._log('hphe-mcp.exe not found — falling back to Python');
      }
    }

    const serverPath = this._serverPath();
    const tried = [];
    let lastErr;
    for (const exe of this._pythonCandidates()) {
      // `py` is the Windows launcher: it needs `-3` to pick a Python 3.
      const args = exe === 'py' ? ['-3', '-u', serverPath] : ['-u', serverPath];
      try {
        await this._trySpawn(exe, args, serverPath);
        return;
      } catch (e) {
        lastErr = e;
        tried.push(exe);
        if (!/ENOENT/.test(e.message)) throw e; // real failure, not "not found"
        this._log(`${exe} not found, trying next candidate`);
      }
    }
    throw new Error(
      `Python introuvable (essayé : ${tried.join(', ')}). ` +
      'Installez Python 3.11+ ou définissez everythingSearch.pythonPath. ' +
      `Dernière erreur : ${lastErr && lastErr.message}`
    );
  }

  _trySpawn(exe, args, serverPath) {
    const cwd = path.dirname(serverPath);
    this._log(`spawning: ${exe} ${args.join(' ')} (cwd=${cwd})`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(exe, args, {
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
