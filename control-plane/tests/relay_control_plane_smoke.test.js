const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function startNodeService(scriptPath, extraEnv) {
  const proc = spawn(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const append = (chunk) => {
    logs += String(chunk);
    if (logs.length > 24_000) {
      logs = logs.slice(-24_000);
    }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);

  return {
    proc,
    getLogs() {
      return logs;
    },
  };
}

async function stopNodeService(service) {
  if (!service) return;
  const { proc } = service;
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const exited = await Promise.race([
    once(proc, 'exit').then(() => true).catch(() => true),
    delay(1200).then(() => false),
  ]);
  if (!exited && proc.exitCode === null) {
    proc.kill('SIGKILL');
    await once(proc, 'exit').catch(() => {});
  }
}

async function waitForHttp(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15_000);
  const headers = options.headers || {};
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) return;
      lastError = `status=${res.status}`;
    } catch (err) {
      lastError = String(err?.message || err);
    }
    await delay(120);
  }

  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

async function httpJson(url, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };
  const init = { method, headers };

  if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return {
    status: res.status,
    body,
    raw: text,
  };
}

test(
  'task can be created from relay gateway and canceled from control API',
  { timeout: 45_000 },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cp-smoke-'));
    const token = 'relay-control-plane-smoke-token';
    const cpPort = await freePort();
    const relayPort = await freePort();

    const controlPlane = startNodeService('control-plane/server.js', {
      CONTROL_PLANE_PORT: String(cpPort),
      CONTROL_PLANE_DB_PATH: path.join(tempDir, 'control_plane.db'),
      CONTROL_PLANE_TOKEN: token,
      CONTROL_PLANE_LOOP_MS: '250',
      RELAY_TOKEN: token,
    });

    let relay = null;

    try {
      await waitForHttp(`http://127.0.0.1:${cpPort}/healthz`);

      relay = startNodeService('relay/server.js', {
        RELAY_PORT: String(relayPort),
        RELAY_TOKEN: token,
        RELAY_DB_PATH: path.join(tempDir, 'relay.db'),
        CONTROL_PLANE_ENABLED: '1',
        CONTROL_PLANE_BASE_URL: `http://127.0.0.1:${cpPort}`,
        CODEX_HOME: path.join(tempDir, 'codex_home'),
      });
      await waitForHttp(`http://127.0.0.1:${relayPort}/healthz`);

      const create = await httpJson(`http://127.0.0.1:${relayPort}/agent-control-plane/v1/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          goal: 'Relay + ControlPlane smoke test task',
          repo: ROOT,
          branch: 'main',
          acceptance_criteria: [
            'task can be created from relay gateway',
            'task can be canceled from control API',
          ],
          priority: 'P1',
          risk_profile: 'low',
        },
      });

      assert.equal(create.status, 200, `unexpected create status body=${JSON.stringify(create.body)}`);
      assert.equal(create.body?.ok, true);
      const taskId = String(create.body?.task_id || '').trim();
      assert.ok(taskId, `missing task_id body=${JSON.stringify(create.body)}`);

      const cancel = await httpJson(
        `http://127.0.0.1:${cpPort}/agent-control-plane/v1/tasks/${encodeURIComponent(taskId)}/control`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: {
            action: 'cancel',
            requested_by: 'control-plane-smoke-test',
            reason: 'cancel after running',
          },
        },
      );

      assert.equal(cancel.status, 200, `unexpected cancel status body=${JSON.stringify(cancel.body)}`);
      assert.equal(cancel.body?.ok, true);

      let status = String(cancel.body?.task?.status || '').toLowerCase();
      if (status !== 'canceled') {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const detail = await httpJson(
            `http://127.0.0.1:${cpPort}/agent-control-plane/v1/tasks/${encodeURIComponent(taskId)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          );
          status = String(detail.body?.task?.status || '').toLowerCase();
          if (status === 'canceled') break;
          await delay(150);
        }
      }
      assert.equal(status, 'canceled', `expected canceled status for task=${taskId}`);
    } catch (err) {
      const cpLogs = controlPlane.getLogs();
      const relayLogs = relay?.getLogs() || '';
      throw new Error(
        `${String(err?.message || err)}\ncontrol-plane logs:\n${cpLogs}\nrelay logs:\n${relayLogs}`,
      );
    } finally {
      await stopNodeService(relay);
      await stopNodeService(controlPlane);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
