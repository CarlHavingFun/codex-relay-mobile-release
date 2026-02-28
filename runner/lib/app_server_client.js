const { spawn } = require('node:child_process');
const readline = require('node:readline');

class AppServerRPCError extends Error {
  constructor(method, rpcError) {
    super(`app-server ${method} failed: ${rpcError?.message || 'unknown error'}`);
    this.name = 'AppServerRPCError';
    this.method = method;
    this.code = rpcError?.code;
    this.data = rpcError?.data;
  }
}

class AppServerClient {
  constructor(options = {}) {
    this.codexBin = options.codexBin || 'codex';
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.env = options.env || {};
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 120_000);
    this.clientInfo = options.clientInfo || {
      name: 'codex_relay_connector',
      title: 'Codex Relay Connector',
      version: '0.1.0',
    };

    this.proc = null;
    this.stdoutRl = null;
    this.stderrRl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.requestListeners = new Set();
    this.stderrListeners = new Set();
    this.started = false;
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener) {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onStderr(listener) {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  isStarted() {
    return this.started && !!this.proc;
  }

  async start() {
    if (this.proc) return;
    const args = ['app-server', '--listen', 'stdio://', ...this.extraArgs];
    this.proc = spawn(this.codexBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.stdoutRl = readline.createInterface({ input: this.proc.stdout });
    this.stderrRl = readline.createInterface({ input: this.proc.stderr });

    this.stdoutRl.on('line', (line) => this.handleLine(line, 'stdout'));
    this.stderrRl.on('line', (line) => this.handleLine(line, 'stderr'));
    this.proc.on('error', (err) => this.failAllPending(err));
    this.proc.on('exit', (code, signal) => {
      this.started = false;
      this.proc = null;
      const err = new Error(`app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.failAllPending(err);
    });

    await this.request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized', {});
    this.started = true;
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.started = false;

    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }

    this.failAllPending(new Error('app-server stopped'));

    if (this.stdoutRl) this.stdoutRl.close();
    if (this.stderrRl) this.stderrRl.close();
    this.stdoutRl = null;
    this.stderrRl = null;
  }

  notify(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('app-server is not running');
    }
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result = {}) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  respondError(id, code, message, data = null) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const error = {
      code: Number.isFinite(Number(code)) ? Number(code) : -32000,
      message: String(message || 'request failed'),
    };
    if (data !== null && data !== undefined) error.data = data;
    this.proc.stdin.write(`${JSON.stringify({ id, error })}\n`);
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('app-server is not running');
    }
    const id = this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`app-server ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(String(id), {
        method,
        resolve,
        reject,
        timer,
      });

      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  handleLine(line, source) {
    const text = String(line || '').trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      if (source === 'stderr') {
        for (const listener of this.stderrListeners) {
          try { listener(text); } catch {}
        }
      }
      return;
    }

    if (message && message.id != null && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new AppServerRPCError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message && message.id != null && typeof message.method === 'string') {
      void this.handleServerRequest(message);
      return;
    }

    if (message && typeof message.method === 'string') {
      const params = message.params || {};
      for (const listener of this.notificationListeners) {
        try { listener(message.method, params); } catch {}
      }
      return;
    }

    if (source === 'stderr') {
      for (const listener of this.stderrListeners) {
        try { listener(text); } catch {}
      }
    }
  }

  failAllPending(error) {
    for (const [key, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  async handleServerRequest(message) {
    const id = message.id;
    const method = String(message.method || '');
    const params = message.params || {};

    if (!this.requestListeners.size) {
      this.respondError(id, -32601, `Unhandled server request: ${method}`);
      return;
    }

    for (const listener of this.requestListeners) {
      try {
        const result = await listener({ id, method, params });
        if (result === undefined) continue;
        this.respond(id, result);
        return;
      } catch (err) {
        const messageText = String(err?.message || err || 'request handling failed');
        this.respondError(id, -32000, messageText);
        return;
      }
    }

    this.respondError(id, -32601, `Unhandled server request: ${method}`);
  }
}

module.exports = {
  AppServerClient,
  AppServerRPCError,
};
