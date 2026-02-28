#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { URL } = require('node:url');
const { StateStore } = require('./lib/state_store');
const { buildExecutionPlan } = require('./lib/planner');
const { processControlPlaneTick } = require('./lib/dispatcher');
const { decideDispatchLimit } = require('./lib/chief');
const { workerPayloadForJob } = require('./lib/worker_adapter');
const { summarizeTaskCounts } = require('./lib/metrics');
const { clampInt, nowIso } = require('./lib/common');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = process.env.CONFIG_ENV_FILE || path.join(ROOT, 'config', '.env');
if (fs.existsSync(ENV_FILE)) {
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const PORT = Number(process.env.CONTROL_PLANE_PORT || 8790);
const TOKEN = process.env.CONTROL_PLANE_TOKEN || process.env.RELAY_TOKEN || '';
const MAX_BODY_BYTES = Math.max(100_000, Number(process.env.CONTROL_PLANE_MAX_BODY_BYTES || 2_000_000));
const LOOP_MS = clampInt(process.env.CONTROL_PLANE_LOOP_MS, 250, 10_000, 1000);
const GLOBAL_PARALLELISM = clampInt(process.env.CONTROL_PLANE_GLOBAL_PARALLELISM, 1, 20, 10);
const DEFAULT_TASK_PARALLELISM = clampInt(process.env.CONTROL_PLANE_TASK_PARALLELISM, 1, 10, 8);
const CIRCUIT_THRESHOLD = clampInt(process.env.CONTROL_PLANE_CIRCUIT_THRESHOLD, 1, 20, 3);
const API_PREFIX = '/agent-control-plane/v1';

const DB_PATH = process.env.CONTROL_PLANE_DB_PATH
  ? path.resolve(process.env.CONTROL_PLANE_DB_PATH)
  : path.join(__dirname, 'data', 'control_plane.db');

const store = new StateStore({
  dbPath: DB_PATH,
  globalParallelism: GLOBAL_PARALLELISM,
  defaultTaskParallelism: DEFAULT_TASK_PARALLELISM,
  circuitThreshold: CIRCUIT_THRESHOLD,
});

let tickInFlight = false;
let lastTick = null;
let lastTickAt = null;
let lastTickError = null;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(body));
}

function badRequest(res, message) {
  json(res, 400, { ok: false, error: message });
}

function unauthorized(res) {
  json(res, 401, { ok: false, error: 'unauthorized' });
}

function isAuthorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (done) return;
      reject(err);
    });
  });
}

async function runTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const summary = await processControlPlaneTick({
      store,
      buildExecutionPlan,
      decideDispatchLimit,
      dispatcherId: 'control-plane-main',
      planningBatch: 10,
      dispatchUpperBound: GLOBAL_PARALLELISM,
    });
    lastTick = summary;
    lastTickAt = nowIso();
    lastTickError = null;
  } catch (err) {
    lastTickError = String(err.message || err);
  } finally {
    tickInFlight = false;
  }
}

setInterval(() => {
  void runTick();
}, LOOP_MS);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, {
      ok: true,
      ts: nowIso(),
      service: 'agent-control-plane',
      db_path: DB_PATH,
      loop_ms: LOOP_MS,
    });
    return;
  }

  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === `${API_PREFIX}/health`) {
      const tasks = store.listTasks(200);
      json(res, 200, {
        ok: true,
        ts: nowIso(),
        loop_ms: LOOP_MS,
        tick_in_flight: tickInFlight,
        last_tick_at: lastTickAt,
        last_tick: lastTick,
        last_tick_error: lastTickError,
        task_counts: summarizeTaskCounts(tasks),
        system: store.systemSnapshot(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === `${API_PREFIX}/tasks`) {
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 40);
      const tasks = store.listTasks(limit);
      json(res, 200, {
        ok: true,
        tasks,
        count: tasks.length,
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/tasks`) {
      const body = await parseBody(req);
      const task = store.createTask(body, {
        defaultTaskParallelism: DEFAULT_TASK_PARALLELISM,
      });
      json(res, 200, {
        ok: true,
        task_id: task.task_id,
        task,
        ts: nowIso(),
      });
      return;
    }

    const taskMatch = url.pathname.match(/^\/agent-control-plane\/v1\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const task = store.getTask(taskId);
      if (!task) {
        json(res, 404, { ok: false, error: 'task_not_found' });
        return;
      }
      json(res, 200, { ok: true, task, ts: nowIso() });
      return;
    }

    const taskControlMatch = url.pathname.match(/^\/agent-control-plane\/v1\/tasks\/([^/]+)\/control$/);
    if (req.method === 'POST' && taskControlMatch) {
      const taskId = decodeURIComponent(taskControlMatch[1]);
      const body = await parseBody(req);
      const action = String(body.action || '').trim().toLowerCase();
      if (!['pause', 'resume', 'cancel', 'emergency_stop', 'force_rollback'].includes(action)) {
        badRequest(res, 'action must be pause, resume, cancel, emergency_stop, or force_rollback');
        return;
      }
      const task = store.controlTask(taskId, action, {
        requested_by: body.requested_by || 'api',
        reason: body.reason || null,
      });
      json(res, 200, { ok: true, task, ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/control`) {
      const body = await parseBody(req);
      const action = String(body.action || '').trim().toLowerCase();
      if (!['emergency_stop_clear', 'circuit_reset'].includes(action)) {
        badRequest(res, 'action must be emergency_stop_clear or circuit_reset');
        return;
      }
      const result = store.controlGlobal(action, {
        requested_by: body.requested_by || 'api',
        reason: body.reason || null,
      });
      json(res, 200, { ok: true, result, ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/worker/jobs/claim`) {
      const body = await parseBody(req);
      const workerId = String(body.worker_id || '').trim();
      const limit = clampInt(body.limit, 1, 20, 1);
      if (!workerId) {
        badRequest(res, 'worker_id is required');
        return;
      }
      const jobs = store.claimDispatchedJobs(workerId, limit).map((job) => workerPayloadForJob(job));
      json(res, 200, {
        ok: true,
        worker_id: workerId,
        jobs,
        count: jobs.length,
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === `${API_PREFIX}/events/worker-result`) {
      const body = await parseBody(req);
      const result = store.applyWorkerResult(body);
      json(res, 200, {
        ok: true,
        job: result.job,
        task: result.task,
        duplicate: !!result.duplicate,
        ts: nowIso(),
      });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    const message = String(err.message || err);
    if (message.toLowerCase().includes('payload too large')) {
      json(res, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    if (message === 'task_not_found') {
      json(res, 404, { ok: false, error: message });
      return;
    }
    if (
      message === 'unsupported_action'
      || message === 'unsupported_global_action'
      || message === 'job_owned_by_other_worker'
      || message === 'job_not_found'
      || message === 'goal is required'
      || message === 'repo is required'
    ) {
      json(res, 400, { ok: false, error: message });
      return;
    }
    json(res, 500, { ok: false, error: message });
  }
});

server.listen(PORT, async () => {
  await runTick();
  console.log(`[control-plane] listening on :${PORT}`);
  console.log(`[control-plane] sqlite db: ${DB_PATH}`);
  console.log(`[control-plane] loop_ms=${LOOP_MS} global_parallelism=${GLOBAL_PARALLELISM}`);
});
