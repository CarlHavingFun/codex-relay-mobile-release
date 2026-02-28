#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  clampInt,
  nowIso,
  parseBool,
} = require('./lib/common');
const {
  workspaceFromRepo,
  buildSubAgentPrompt,
  mapRelayStatusToWorkerStatus,
} = require('./lib/bridge_helpers');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'config', '.env');
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

const CONFIG = {
  controlPlaneBaseUrl: String(process.env.CONTROL_PLANE_BASE_URL || 'http://127.0.0.1:8790').trim().replace(/\/$/, ''),
  controlPlaneToken: process.env.CONTROL_PLANE_TOKEN || process.env.RELAY_TOKEN || '',
  relayBaseUrl: String(process.env.RELAY_BASE_URL || 'http://127.0.0.1:8787').trim().replace(/\/$/, ''),
  relayToken: process.env.RELAY_TOKEN || process.env.CONTROL_PLANE_TOKEN || '',
  workerId: process.env.CONTROL_PLANE_WORKER_ID || `cp_bridge_${os.hostname()}`,
  maxConcurrentJobs: clampInt(process.env.CONTROL_PLANE_WORKER_MAX_CONCURRENT_JOBS, 1, 8, 2),
  pollSeconds: clampInt(process.env.CONTROL_PLANE_WORKER_POLL_SECONDS, 1, 10, 2),
  jobStatusPollMs: clampInt(process.env.CONTROL_PLANE_WORKER_JOB_STATUS_POLL_MS, 500, 10_000, 1500),
  requestTimeoutMs: clampInt(process.env.CONTROL_PLANE_WORKER_REQUEST_TIMEOUT_MS, 2_000, 180_000, 20_000),
  defaultWorkspace: String(
    process.env.CONTROL_PLANE_WORKER_DEFAULT_WORKSPACE
      || process.env.CONNECTOR_WORKSPACE
      || process.env.DEFAULT_WORKSPACE
      || 'default',
  ).trim(),
  approvalPolicy: String(process.env.CONTROL_PLANE_WORKER_APPROVAL_POLICY || 'never').trim(),
  sandbox: String(process.env.CONTROL_PLANE_WORKER_SANDBOX || 'danger-full-access').trim(),
  personality: String(process.env.CONTROL_PLANE_WORKER_PERSONALITY || 'pragmatic').trim(),
  model: String(process.env.CONTROL_PLANE_WORKER_MODEL || '').trim(),
  stateDir: process.env.STATE_DIR || path.join(ROOT, 'state'),
  dryRun: parseBool(process.env.CONTROL_PLANE_WORKER_DRY_RUN, false),
};

const FILES = {
  log: path.join(CONFIG.stateDir, 'control_plane_bridge.log'),
  state: path.join(CONFIG.stateDir, 'control_plane_bridge_state.json'),
};

let shuttingDown = false;
const inFlight = new Set();
const activeJobs = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLine(message) {
  const line = `${nowIso()} [cp-bridge] ${message}`;
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  fs.appendFileSync(FILES.log, `${line}\n`);
  console.log(line);
}

function writeState(statusOverride = null) {
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  const state = {
    worker_id: CONFIG.workerId,
    updated_at: nowIso(),
    control_plane_base_url: CONFIG.controlPlaneBaseUrl,
    relay_base_url: CONFIG.relayBaseUrl,
    current_status: statusOverride || (shuttingDown ? 'stopping' : (inFlight.size > 0 ? 'running' : 'idle')),
    max_concurrent_jobs: CONFIG.maxConcurrentJobs,
    active_jobs: Array.from(activeJobs.entries()).map(([jobId, item]) => ({
      job_id: jobId,
      relay_thread_id: item.relayThreadId,
      relay_job_id: item.relayJobId,
      started_at: item.startedAt,
    })),
  };
  fs.writeFileSync(FILES.state, JSON.stringify(state, null, 2));
}

function headersForToken(token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestJson(baseUrl, token, method, endpoint, body = null) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const headers = headersForToken(token);
  if (hasBody) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body || {}) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${method} ${endpoint} failed (${response.status}): ${text || 'empty_response'}`);
    }
    if (payload && typeof payload === 'object' && payload.ok === false) {
      throw new Error(`${method} ${endpoint} api_error: ${String(payload.error || 'unknown_error')}`);
    }
    return payload || {};
  } finally {
    clearTimeout(timeout);
  }
}

async function cpJson(method, endpoint, body = null) {
  return requestJson(CONFIG.controlPlaneBaseUrl, CONFIG.controlPlaneToken, method, endpoint, body);
}

async function relayJson(method, endpoint, body = null) {
  return requestJson(CONFIG.relayBaseUrl, CONFIG.relayToken, method, endpoint, body);
}

function buildPolicy(payload = {}) {
  const cwdCandidate = String(payload.repo || '').trim();
  const out = {
    approvalPolicy: CONFIG.approvalPolicy,
    sandbox: CONFIG.sandbox,
    personality: CONFIG.personality,
  };
  if (cwdCandidate.startsWith('/')) out.cwd = cwdCandidate;
  if (CONFIG.model) out.model = CONFIG.model;
  return out;
}

function localThreadIdForJob(job) {
  return `cp_${String(job.job_id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function titleForJob(job) {
  return `CP ${String(job.task_id || '').slice(0, 18)} ${String(job.node_id || '').slice(0, 30)}`.trim();
}

async function upsertRelayThread(threadId, workspace, title) {
  await relayJson('POST', '/codex-iphone-connector/chat/threads', {
    workspace,
    thread_id: threadId,
    title,
    source: 'control-plane',
    status: 'queued',
    updated_at: nowIso(),
  });
}

function relayTerminalStatus(status) {
  return ['completed', 'failed', 'interrupted', 'timeout', 'canceled', 'cancelled'].includes(String(status || '').toLowerCase());
}

async function waitForRelayJobTerminal(threadId, relayJobId, timeoutMs) {
  const deadline = Date.now() + Math.max(10_000, timeoutMs);
  let last = { status: 'queued', job: null, thread: null };

  while (Date.now() < deadline) {
    const detail = await relayJson('GET', `/codex-iphone-connector/chat/threads/${encodeURIComponent(threadId)}`);
    const jobs = Array.isArray(detail.jobs) ? detail.jobs : [];
    const thread = detail.thread || null;
    const job = jobs.find((item) => item && item.job_id === relayJobId) || null;
    if (job) {
      const status = String(job.status || '').toLowerCase();
      last = { status, job, thread };
      if (relayTerminalStatus(status)) return last;
    }
    await sleep(CONFIG.jobStatusPollMs);
  }

  return {
    ...last,
    status: 'timeout',
    timed_out: true,
  };
}

async function reportResult(payload) {
  return cpJson('POST', '/agent-control-plane/v1/events/worker-result', payload);
}

async function processJob(job) {
  const jobId = String(job.job_id || '').trim();
  const startMs = Date.now();
  const payload = job && typeof job.payload === 'object' ? job.payload : {};
  const workspace = workspaceFromRepo(payload.repo, CONFIG.defaultWorkspace);
  const relayThreadId = localThreadIdForJob(job);
  const prompt = buildSubAgentPrompt(job);

  activeJobs.set(jobId, {
    relayThreadId,
    relayJobId: null,
    startedAt: nowIso(),
  });
  writeState('running');

  let relayJobId = null;

  try {
    if (CONFIG.dryRun) {
      logLine(`dry-run claim job=${jobId} node=${job.node_id} role=${job.role}`);
      await reportResult({
        worker_id: CONFIG.workerId,
        job_id: jobId,
        status: 'completed',
        artifacts: {
          dry_run: true,
          prompt_preview: prompt.slice(0, 500),
        },
        logs: [{ ts: nowIso(), line: 'dry-run completed' }],
        metrics: { duration_ms: Date.now() - startMs },
      });
      return;
    }

    await upsertRelayThread(relayThreadId, workspace, titleForJob(job));

    const messageResp = await relayJson(
      'POST',
      `/codex-iphone-connector/chat/threads/${encodeURIComponent(relayThreadId)}/messages`,
      {
        workspace,
        input_text: prompt,
        input_items: [],
        idempotency_key: `cp_bridge_${jobId}`,
        replace_running: false,
        policy: buildPolicy(payload),
      },
    );

    relayJobId = String(messageResp?.job?.job_id || '').trim();
    if (!relayJobId) throw new Error('relay_message_missing_job_id');

    const active = activeJobs.get(jobId);
    if (active) {
      active.relayJobId = relayJobId;
      activeJobs.set(jobId, active);
      writeState('running');
    }

    const timeoutMs = Math.max(10_000, (Number(job.timeout_s || 0) || 30 * 60) * 1000);
    const terminal = await waitForRelayJobTerminal(relayThreadId, relayJobId, timeoutMs);
    const mapped = mapRelayStatusToWorkerStatus(terminal.status);
    const durationMs = Date.now() - startMs;

    if (mapped.workerStatus === 'completed') {
      await reportResult({
        worker_id: CONFIG.workerId,
        job_id: jobId,
        status: 'completed',
        artifacts: {
          relay_thread_id: relayThreadId,
          relay_job_id: relayJobId,
          relay_status: terminal.status,
          task_id: job.task_id,
          node_id: job.node_id,
          role: job.role,
        },
        logs: [{ ts: nowIso(), line: `relay completed status=${terminal.status}` }],
        metrics: { duration_ms: durationMs },
      });
      logLine(`job completed job=${jobId} relay_job=${relayJobId}`);
      return;
    }

    const relayError = terminal.job?.error_message || terminal.job?.error_code || `relay status=${terminal.status}`;
    await reportResult({
      worker_id: CONFIG.workerId,
      job_id: jobId,
      status: mapped.workerStatus,
      error: relayError,
      artifacts: {
        relay_thread_id: relayThreadId,
        relay_job_id: relayJobId,
        relay_status: terminal.status,
        task_id: job.task_id,
        node_id: job.node_id,
        role: job.role,
      },
      logs: [{ ts: nowIso(), line: `relay terminal status=${terminal.status}` }],
      metrics: { duration_ms: durationMs },
    });
    logLine(`job terminal non-success job=${jobId} relay_status=${terminal.status} mapped=${mapped.workerStatus}`);
  } catch (err) {
    const message = String(err.message || err);
    logLine(`job failed job=${jobId} error=${message}`);
    try {
      await reportResult({
        worker_id: CONFIG.workerId,
        job_id: jobId,
        status: 'failed',
        error: message,
        artifacts: {
          relay_thread_id: relayThreadId,
          relay_job_id: relayJobId,
          task_id: job.task_id,
          node_id: job.node_id,
          role: job.role,
        },
        logs: [{ ts: nowIso(), line: message.slice(0, 500) }],
        metrics: { duration_ms: Date.now() - startMs },
      });
    } catch (reportErr) {
      logLine(`worker-result report failed job=${jobId} error=${String(reportErr.message || reportErr)}`);
    }
  } finally {
    activeJobs.delete(jobId);
    writeState();
  }
}

async function waitForInFlightOrPoll(ms) {
  if (!inFlight.size) {
    await sleep(ms);
    return;
  }
  await Promise.race([
    Promise.race(Array.from(inFlight)),
    sleep(ms),
  ]);
}

async function mainLoop() {
  writeState('starting');
  logLine(
    `starting worker_id=${CONFIG.workerId} cp=${CONFIG.controlPlaneBaseUrl} relay=${CONFIG.relayBaseUrl} max_concurrent=${CONFIG.maxConcurrentJobs} dry_run=${CONFIG.dryRun}`,
  );

  while (!shuttingDown) {
    try {
      const slots = Math.max(0, CONFIG.maxConcurrentJobs - inFlight.size);
      if (slots <= 0) {
        await waitForInFlightOrPoll(CONFIG.pollSeconds * 1000);
        continue;
      }

      const claimResp = await cpJson('POST', '/agent-control-plane/v1/worker/jobs/claim', {
        worker_id: CONFIG.workerId,
        limit: slots,
      });
      const jobs = Array.isArray(claimResp.jobs) ? claimResp.jobs : [];

      if (!jobs.length) {
        writeState('idle');
        await waitForInFlightOrPoll(CONFIG.pollSeconds * 1000);
        continue;
      }

      for (const job of jobs) {
        let p = null;
        p = processJob(job)
          .catch((err) => {
            logLine(`unexpected processJob error job=${String(job?.job_id || '')} error=${String(err.message || err)}`);
          })
          .finally(() => {
            inFlight.delete(p);
          });
        inFlight.add(p);
      }
      writeState('running');
    } catch (err) {
      logLine(`main loop error: ${String(err.message || err)}`);
      writeState('error');
      await waitForInFlightOrPoll(Math.max(2, CONFIG.pollSeconds) * 1000);
    }
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  writeState('stopping');
  await Promise.allSettled(Array.from(inFlight));
  writeState('stopped');
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

mainLoop().catch(async (err) => {
  logLine(`fatal: ${String(err.message || err)}`);
  await shutdown();
  process.exit(1);
});
