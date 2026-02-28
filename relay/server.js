#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

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

const PORT = Number(process.env.RELAY_PORT || 8787);
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE || 'default';
const LEGACY_RUNNER_API_PREFIX = '/legacy-runner';
const CONNECTOR_API_PREFIX = '/codex-iphone-connector';
const CONTROL_PLANE_API_PREFIX = '/agent-control-plane/v1';
const LEGACY_RUNNER_COMPAT_PREFIX = '/v1';
const CONNECTOR_COMPAT_PREFIX = '/v2';
const CONTROL_PLANE_ENABLED = String(process.env.CONTROL_PLANE_ENABLED || '0').trim().toLowerCase() === '1';
const CONTROL_PLANE_BASE_URL = String(process.env.CONTROL_PLANE_BASE_URL || 'http://127.0.0.1:8790')
  .trim()
  .replace(/\/$/, '');
const CONNECTOR_POLL_SECONDS = Math.max(1, Number(process.env.CONNECTOR_POLL_SECONDS || 2));
const RUNNER_STATUS_STALE_SECONDS = Math.max(20, Number(process.env.RUNNER_STATUS_STALE_SECONDS || 90));
const CONNECTOR_STATUS_STALE_SECONDS = Math.max(10, Number(process.env.CONNECTOR_STATUS_STALE_SECONDS || 45));
const MAX_BODY_BYTES = Math.max(200_000, Number(process.env.RELAY_MAX_BODY_BYTES || 10_000_000));
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME, 'archived_sessions');
const IOS_PLACEHOLDER_PRUNE_MINUTES = Math.max(
  5,
  Number(process.env.IOS_PLACEHOLDER_PRUNE_MINUTES || 20),
);

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.RELAY_DB_PATH
  ? path.resolve(process.env.RELAY_DB_PATH)
  : path.join(DATA_DIR, 'relay.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS runners (
  runner_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  online INTEGER NOT NULL DEFAULT 0,
  current_task_json TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  task_id TEXT,
  level TEXT,
  phase TEXT,
  message TEXT,
  payload_json TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_workspace_ts ON events(workspace, ts DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_text TEXT NOT NULL,
  risk_reason_json TEXT NOT NULL,
  state TEXT NOT NULL,
  decision_by TEXT,
  decision_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_workspace_state ON approvals(workspace, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks_current (
  workspace TEXT PRIMARY KEY,
  task_id TEXT,
  task_text TEXT,
  task_mode TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT,
  external_thread_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_updated ON chat_threads(workspace, updated_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_chat_threads_external ON chat_threads(external_thread_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_source_status ON chat_threads(source, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_jobs (
  job_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  input_text TEXT NOT NULL,
  input_items_json TEXT,
  policy_json TEXT,
  status TEXT NOT NULL,
  connector_id TEXT,
  turn_id TEXT,
  idempotency_key TEXT UNIQUE,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_jobs_workspace_status_created ON chat_jobs(workspace, status, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_jobs_thread_created ON chat_jobs(thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  workspace TEXT NOT NULL,
  job_id TEXT,
  turn_id TEXT,
  type TEXT NOT NULL,
  delta TEXT,
  payload_json TEXT,
  ts TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chat_events_thread_seq ON chat_events(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_chat_events_workspace_ts ON chat_events(workspace, ts DESC);

CREATE TABLE IF NOT EXISTS chat_user_input_requests (
  request_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  turn_id TEXT,
  item_id TEXT,
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user_input_requests_job_status_updated
  ON chat_user_input_requests(job_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_user_input_requests_thread_status_updated
  ON chat_user_input_requests(thread_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS connector_runners (
  connector_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT,
  capabilities_json TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_workspace_updated ON connector_runners(workspace, updated_at DESC);

CREATE TABLE IF NOT EXISTS connector_session_sync_requests (
  request_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  thread_id TEXT,
  requested_by TEXT,
  status TEXT NOT NULL,
  connector_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_sync_requests_status_workspace_created
  ON connector_session_sync_requests(status, workspace, created_at);

CREATE TABLE IF NOT EXISTS connector_auth_relogin_requests (
  request_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL,
  connector_id TEXT,
  auth_url TEXT,
  user_code TEXT,
  verification_uri_complete TEXT,
  expires_at TEXT,
  message TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_relogin_requests_status_workspace_created
  ON connector_auth_relogin_requests(status, workspace, created_at);

CREATE TABLE IF NOT EXISTS session_backfill_runs (
  run_id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  status TEXT NOT NULL,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_backfill_workspace_started ON session_backfill_runs(workspace, started_at DESC);
`);

function ensureTableColumn(table, column, sqlType) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = rows.some((row) => row.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }
}

ensureTableColumn('chat_jobs', 'input_items_json', 'TEXT');
ensureTableColumn('chat_jobs', 'stop_requested_at', 'TEXT');
ensureTableColumn('chat_jobs', 'stop_requested_by', 'TEXT');

const upsertRunnerStmt = db.prepare(`
INSERT INTO runners (runner_id, workspace, online, current_task_json, last_success_at, last_error, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(runner_id) DO UPDATE SET
  workspace=excluded.workspace,
  online=excluded.online,
  current_task_json=excluded.current_task_json,
  last_success_at=excluded.last_success_at,
  last_error=excluded.last_error,
  updated_at=excluded.updated_at
`);

const insertEventStmt = db.prepare(`
INSERT OR REPLACE INTO events (id, runner_id, workspace, task_id, level, phase, message, payload_json, ts)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertApprovalStmt = db.prepare(`
INSERT INTO approvals (id, runner_id, workspace, task_id, task_text, risk_reason_json, state, decision_by, decision_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  state=excluded.state,
  decision_by=excluded.decision_by,
  decision_at=excluded.decision_at,
  updated_at=excluded.updated_at,
  risk_reason_json=excluded.risk_reason_json
`);

const upsertTaskStmt = db.prepare(`
INSERT INTO tasks_current (workspace, task_id, task_text, task_mode, status, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace) DO UPDATE SET
  task_id=excluded.task_id,
  task_text=excluded.task_text,
  task_mode=excluded.task_mode,
  status=excluded.status,
  updated_at=excluded.updated_at
`);

const selectChatThreadStmt = db.prepare(`SELECT * FROM chat_threads WHERE thread_id = ?`);
const insertChatThreadStmt = db.prepare(`
INSERT INTO chat_threads (thread_id, workspace, title, external_thread_id, source, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateChatThreadStmt = db.prepare(`
UPDATE chat_threads
SET workspace = ?, title = ?, external_thread_id = ?, source = ?, status = ?, updated_at = ?
WHERE thread_id = ?
`);
const updateThreadStatusStmt = db.prepare(`
UPDATE chat_threads
SET status = ?, updated_at = ?
WHERE thread_id = ?
`);
const updateThreadExternalIdStmt = db.prepare(`
UPDATE chat_threads
SET external_thread_id = ?, source = 'codex', updated_at = ?
WHERE thread_id = ?
`);
const selectCodexThreadsAnyStmt = db.prepare(`
SELECT thread_id FROM chat_threads
WHERE source = 'codex' AND status != 'deleted'
`);
const selectCodexThreadsByWorkspaceStmt = db.prepare(`
SELECT thread_id FROM chat_threads
WHERE source = 'codex' AND status != 'deleted' AND workspace = ?
`);
const selectIdleIosPlaceholderThreadsAnyStmt = db.prepare(`
SELECT thread_id, updated_at FROM chat_threads
WHERE source = 'ios'
  AND status = 'idle'
  AND (external_thread_id IS NULL OR TRIM(external_thread_id) = '')
`);
const selectIdleIosPlaceholderThreadsByWorkspaceStmt = db.prepare(`
SELECT thread_id, updated_at FROM chat_threads
WHERE workspace = ?
  AND source = 'ios'
  AND status = 'idle'
  AND (external_thread_id IS NULL OR TRIM(external_thread_id) = '')
`);
const selectChatThreadByExternalPreferLocalStmt = db.prepare(`
SELECT * FROM chat_threads
WHERE external_thread_id = ? AND status != 'deleted'
ORDER BY CASE WHEN source IN ('ios', 'connector') THEN 0 ELSE 1 END, updated_at DESC
LIMIT 1
`);
const markThreadDeletedStmt = db.prepare(`
UPDATE chat_threads
SET status = 'deleted', updated_at = ?
WHERE thread_id = ? AND status != 'deleted'
`);

const insertChatJobStmt = db.prepare(`
INSERT INTO chat_jobs (job_id, thread_id, workspace, input_text, input_items_json, policy_json, status, connector_id, turn_id, idempotency_key, error_code, error_message, stop_requested_at, stop_requested_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectChatJobStmt = db.prepare(`SELECT * FROM chat_jobs WHERE job_id = ?`);
const selectChatJobByIdempotencyStmt = db.prepare(`SELECT * FROM chat_jobs WHERE idempotency_key = ?`);
const selectQueuedChatJobStmt = db.prepare(`
SELECT queued.*
FROM chat_jobs AS queued
WHERE queued.workspace = ?
  AND queued.status = 'queued'
  AND NOT EXISTS (
    SELECT 1
    FROM chat_jobs AS active
    WHERE active.thread_id = queued.thread_id
      AND active.status IN ('claimed', 'running')
  )
ORDER BY queued.created_at ASC
LIMIT 1
`);
const selectQueuedAnyChatJobStmt = db.prepare(`
SELECT queued.*
FROM chat_jobs AS queued
WHERE queued.status = 'queued'
  AND NOT EXISTS (
    SELECT 1
    FROM chat_jobs AS active
    WHERE active.thread_id = queued.thread_id
      AND active.status IN ('claimed', 'running')
  )
ORDER BY queued.created_at ASC
LIMIT 1
`);
const claimChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'claimed', connector_id = ?, updated_at = ?
WHERE job_id = ? AND status = 'queued'
`);
const markChatJobRunningStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'running', updated_at = ?
WHERE job_id = ? AND status IN ('claimed', 'running')
`);
const touchChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET updated_at = ?
WHERE job_id = ?
`);
const updateChatJobTurnStmt = db.prepare(`
UPDATE chat_jobs
SET turn_id = ?, updated_at = ?
WHERE job_id = ?
`);
const completeChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'completed', turn_id = ?, updated_at = ?, error_code = NULL, error_message = NULL, stop_requested_at = NULL, stop_requested_by = NULL
WHERE job_id = ?
`);
const interruptChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'interrupted', turn_id = ?, error_code = ?, error_message = ?, updated_at = ?, stop_requested_at = NULL, stop_requested_by = NULL
WHERE job_id = ?
`);
const timeoutChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'timeout', turn_id = ?, error_code = ?, error_message = ?, updated_at = ?, stop_requested_at = NULL, stop_requested_by = NULL
WHERE job_id = ?
`);
const failChatJobStmt = db.prepare(`
UPDATE chat_jobs
SET status = 'failed', turn_id = ?, error_code = ?, error_message = ?, updated_at = ?, stop_requested_at = NULL, stop_requested_by = NULL
WHERE job_id = ?
`);
const requestChatJobStopStmt = db.prepare(`
UPDATE chat_jobs
SET stop_requested_at = ?, stop_requested_by = ?, updated_at = ?
WHERE job_id = ? AND status IN ('claimed', 'running')
`);
const selectLatestActiveChatJobByThreadStmt = db.prepare(`
SELECT * FROM chat_jobs
WHERE thread_id = ? AND status IN ('queued', 'claimed', 'running')
ORDER BY created_at DESC
LIMIT 1
`);
const selectQueuedChatJobsByThreadStmt = db.prepare(`
SELECT * FROM chat_jobs
WHERE thread_id = ? AND status = 'queued'
ORDER BY created_at ASC
LIMIT 100
`);
const selectChatJobsByThreadStmt = db.prepare(`
SELECT * FROM chat_jobs
WHERE thread_id = ?
ORDER BY created_at DESC
LIMIT 50
`);

const nextChatSeqStmt = db.prepare(`
SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
FROM chat_events
WHERE thread_id = ?
`);
const insertChatEventStmt = db.prepare(`
INSERT INTO chat_events (thread_id, seq, workspace, job_id, turn_id, type, delta, payload_json, ts)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectChatEventsStmt = db.prepare(`
SELECT * FROM chat_events
WHERE thread_id = ? AND seq > ?
ORDER BY seq ASC
LIMIT ?
`);
const selectRecentTranscriptEventsByThreadStmt = db.prepare(`
SELECT seq, type, delta, payload_json, ts
FROM chat_events
WHERE thread_id = ?
  AND type IN ('user.message', 'assistant.message')
ORDER BY seq DESC
LIMIT 2000
`);
const countChatEventsByThreadStmt = db.prepare(`
SELECT COUNT(*) AS count
FROM chat_events
WHERE thread_id = ?
`);
const countChatJobsByThreadStmt = db.prepare(`
SELECT COUNT(*) AS count
FROM chat_jobs
WHERE thread_id = ?
`);
const insertChatUserInputRequestStmt = db.prepare(`
INSERT INTO chat_user_input_requests (
  request_id, job_id, thread_id, workspace, connector_id,
  turn_id, item_id, questions_json, answers_json, status,
  created_at, answered_at, completed_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, NULL, ?)
`);
const selectChatUserInputRequestStmt = db.prepare(`
SELECT * FROM chat_user_input_requests
WHERE request_id = ?
`);
const selectChatUserInputRequestByJobStmt = db.prepare(`
SELECT * FROM chat_user_input_requests
WHERE request_id = ? AND job_id = ?
`);
const selectLatestPendingChatUserInputRequestByThreadStmt = db.prepare(`
SELECT * FROM chat_user_input_requests
WHERE thread_id = ? AND status = 'pending'
ORDER BY created_at DESC
LIMIT 1
`);
const markChatUserInputRequestAnsweredStmt = db.prepare(`
UPDATE chat_user_input_requests
SET status = 'answered', answers_json = ?, answered_at = ?, updated_at = ?
WHERE request_id = ? AND thread_id = ? AND status = 'pending'
`);
const markChatUserInputRequestCompletedStmt = db.prepare(`
UPDATE chat_user_input_requests
SET status = 'completed', completed_at = ?, updated_at = ?
WHERE request_id = ? AND job_id = ? AND connector_id = ? AND status = 'answered'
`);

db.exec(`
UPDATE chat_threads
SET source = 'codex'
WHERE source = 'ios'
  AND external_thread_id IS NOT NULL
  AND TRIM(external_thread_id) != ''
`);

const upsertConnectorStmt = db.prepare(`
INSERT INTO connector_runners (connector_id, workspace, status, version, capabilities_json, last_error_code, last_error_message, last_heartbeat_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_id) DO UPDATE SET
  workspace=excluded.workspace,
  status=excluded.status,
  version=excluded.version,
  capabilities_json=excluded.capabilities_json,
  last_error_code=excluded.last_error_code,
  last_error_message=excluded.last_error_message,
  last_heartbeat_at=excluded.last_heartbeat_at,
  updated_at=excluded.updated_at
`);
const selectConnectorStmt = db.prepare(`SELECT * FROM connector_runners WHERE connector_id = ?`);
const insertSessionSyncRequestStmt = db.prepare(`
INSERT INTO connector_session_sync_requests (request_id, workspace, thread_id, requested_by, status, connector_id, error, created_at, claimed_at, completed_at)
VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)
`);
const selectSessionSyncRequestStmt = db.prepare(`
SELECT * FROM connector_session_sync_requests
WHERE request_id = ?
`);
const selectPendingSessionSyncForWorkspaceStmt = db.prepare(`
SELECT * FROM connector_session_sync_requests
WHERE status = 'pending'
  AND (workspace = '*' OR workspace = ?)
ORDER BY created_at ASC
LIMIT 1
`);
const selectPendingAnySessionSyncStmt = db.prepare(`
SELECT * FROM connector_session_sync_requests
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 1
`);
const claimSessionSyncRequestStmt = db.prepare(`
UPDATE connector_session_sync_requests
SET status = 'claimed', connector_id = ?, claimed_at = ?
WHERE request_id = ? AND status = 'pending'
`);
const completeSessionSyncRequestStmt = db.prepare(`
UPDATE connector_session_sync_requests
SET status = ?, completed_at = ?, error = ?
WHERE request_id = ? AND status = 'claimed' AND connector_id = ?
`);
const selectSessionSyncRequestsStmt = db.prepare(`
SELECT * FROM connector_session_sync_requests
WHERE workspace = ?
ORDER BY created_at DESC
LIMIT ?
`);

const insertAuthReloginRequestStmt = db.prepare(`
INSERT INTO connector_auth_relogin_requests (
  request_id, workspace, requested_by, status, connector_id,
  auth_url, user_code, verification_uri_complete, expires_at, message, error,
  created_at, claimed_at, completed_at, updated_at
)
VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
`);
const selectAuthReloginRequestStmt = db.prepare(`
SELECT * FROM connector_auth_relogin_requests
WHERE request_id = ?
`);
const selectPendingAuthReloginForWorkspaceStmt = db.prepare(`
SELECT * FROM connector_auth_relogin_requests
WHERE status = 'pending'
  AND (workspace = '*' OR workspace = ?)
ORDER BY created_at ASC
LIMIT 1
`);
const selectPendingAnyAuthReloginStmt = db.prepare(`
SELECT * FROM connector_auth_relogin_requests
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 1
`);
const claimAuthReloginRequestStmt = db.prepare(`
UPDATE connector_auth_relogin_requests
SET status = 'claimed', connector_id = ?, claimed_at = ?, updated_at = ?
WHERE request_id = ? AND status = 'pending'
`);
const updateAuthReloginRequestProgressStmt = db.prepare(`
UPDATE connector_auth_relogin_requests
SET status = ?, auth_url = ?, user_code = ?, verification_uri_complete = ?, expires_at = ?, message = ?, error = ?, updated_at = ?
WHERE request_id = ? AND connector_id = ? AND status IN ('claimed', 'awaiting_user', 'running')
`);
const completeAuthReloginRequestStmt = db.prepare(`
UPDATE connector_auth_relogin_requests
SET status = ?, message = ?, error = ?, completed_at = ?, updated_at = ?
WHERE request_id = ? AND connector_id = ? AND status IN ('claimed', 'awaiting_user', 'running')
`);

const insertBackfillRunStmt = db.prepare(`
INSERT INTO session_backfill_runs (run_id, workspace, status, scanned_count, imported_count, started_at, completed_at, error)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const completeBackfillRunStmt = db.prepare(`
UPDATE session_backfill_runs
SET status = ?, scanned_count = ?, imported_count = ?, completed_at = ?, error = ?
WHERE run_id = ?
`);
const selectBackfillRunStmt = db.prepare(`SELECT * FROM session_backfill_runs WHERE run_id = ?`);
const selectBackfillRunsStmt = db.prepare(`
SELECT * FROM session_backfill_runs
WHERE workspace = ?
ORDER BY started_at DESC
LIMIT ?
`);

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex')}`;
}

function hashText(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    Vary: 'Authorization',
  });
  res.end(JSON.stringify(body));
}

function badRequest(res, message) {
  json(res, 400, { ok: false, error: message });
}

function unauthorized(res) {
  json(res, 401, { ok: false, error: 'unauthorized' });
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
      if (!total) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
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

async function proxyToControlPlane(req, res, url) {
  if (!CONTROL_PLANE_ENABLED || !CONTROL_PLANE_BASE_URL) {
    json(res, 404, { ok: false, error: 'control_plane_disabled' });
    return;
  }

  const method = String(req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let body = null;
  if (hasBody) {
    body = await parseBody(req);
  }

  const targetUrl = `${CONTROL_PLANE_BASE_URL}${url.pathname}${url.search}`;
  const headers = {
    Accept: 'application/json',
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (req.headers.authorization) headers.Authorization = String(req.headers.authorization);

  const resp = await fetch(targetUrl, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body || {}) : undefined,
  });
  const raw = await resp.text();
  const contentType = resp.headers.get('content-type') || 'application/json; charset=utf-8';
  res.writeHead(resp.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    Vary: 'Authorization',
  });
  if (raw) {
    res.end(raw);
    return;
  }
  if (contentType.includes('application/json')) {
    res.end(JSON.stringify({ ok: resp.ok }));
    return;
  }
  res.end('');
}

function isAuthorized(req) {
  if (!RELAY_TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${RELAY_TOKEN}`;
}

function decodeJSON(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeApiPath(pathname) {
  let value = String(pathname || '').trim() || '/';
  if (value === LEGACY_RUNNER_COMPAT_PREFIX || value.startsWith(`${LEGACY_RUNNER_COMPAT_PREFIX}/`)) {
    value = `${LEGACY_RUNNER_API_PREFIX}${value.slice(LEGACY_RUNNER_COMPAT_PREFIX.length)}`;
  } else if (value === CONNECTOR_COMPAT_PREFIX || value.startsWith(`${CONNECTOR_COMPAT_PREFIX}/`)) {
    value = `${CONNECTOR_API_PREFIX}${value.slice(CONNECTOR_COMPAT_PREFIX.length)}`;
  }

  // Keep old nested runner endpoint working.
  if (value === `${LEGACY_RUNNER_API_PREFIX}/runner/heartbeat`) {
    value = `${LEGACY_RUNNER_API_PREFIX}/heartbeat`;
  }

  // Keep old nested connector endpoints working.
  const connectorCompatPrefix = `${CONNECTOR_API_PREFIX}/connector`;
  if (value.startsWith(`${connectorCompatPrefix}/`)) {
    value = `${CONNECTOR_API_PREFIX}${value.slice(connectorCompatPrefix.length)}`;
  }
  return value;
}

function workspaceFrom(value) {
  const s = String(value || '').trim();
  return s || DEFAULT_WORKSPACE;
}

function isAllWorkspaces(value) {
  const s = String(value || '').trim().toLowerCase();
  return !s || s === '*' || s === 'all';
}

function normalizeTimestamp(value, fallback = nowIso()) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function parseBoolQuery(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeToolRequestUserInputQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const out = [];
  for (const raw of rawQuestions.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim().slice(0, 120);
    const header = String(raw.header || '').trim().slice(0, 120);
    const question = String(raw.question || '').trim().slice(0, 400);
    if (!id || !header || !question) continue;
    const normalized = {
      id,
      header,
      question,
    };
    if (raw.isOther === true) normalized.isOther = true;
    if (raw.isSecret === true) normalized.isSecret = true;
    if (Array.isArray(raw.options)) {
      const options = [];
      for (const optionRaw of raw.options.slice(0, 8)) {
        if (!optionRaw || typeof optionRaw !== 'object') continue;
        const label = String(optionRaw.label || '').trim().slice(0, 120);
        const description = String(optionRaw.description || '').trim().slice(0, 260);
        if (!label || !description) continue;
        options.push({ label, description });
      }
      if (options.length > 0) normalized.options = options;
    }
    out.push(normalized);
  }
  return out;
}

function normalizeToolRequestUserInputAnswers(rawAnswers, allowedQuestionIds = null) {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) return null;
  const allowedSet = Array.isArray(allowedQuestionIds)
    ? new Set(allowedQuestionIds.map((value) => String(value || '').trim()).filter((value) => value.length > 0))
    : null;
  const out = {};
  for (const [rawQuestionId, rawAnswer] of Object.entries(rawAnswers).slice(0, 12)) {
    const questionId = String(rawQuestionId || '').trim().slice(0, 120);
    if (!questionId) continue;
    if (allowedSet && !allowedSet.has(questionId)) continue;

    let answerItems = [];
    if (rawAnswer && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) {
      answerItems = Array.isArray(rawAnswer.answers) ? rawAnswer.answers : [];
    } else if (Array.isArray(rawAnswer)) {
      answerItems = rawAnswer;
    } else if (typeof rawAnswer === 'string' || typeof rawAnswer === 'number' || typeof rawAnswer === 'boolean') {
      answerItems = [rawAnswer];
    }

    const answers = answerItems
      .slice(0, 8)
      .map((value) => String(value == null ? '' : value).trim().slice(0, 240))
      .filter((value) => value.length > 0);
    if (!answers.length) continue;
    out[questionId] = { answers };
  }
  return Object.keys(out).length ? out : null;
}

function threadVisibilityClause(includeDeleted, includeArchived) {
  const staleLocalPlaceholder = `(
    source = 'ios'
    AND status IN ('idle', 'failed')
    AND (external_thread_id IS NULL OR TRIM(external_thread_id) = '')
    AND julianday(updated_at) < julianday('now', '-${IOS_PLACEHOLDER_PRUNE_MINUTES} minutes')
  )`;
  if (includeDeleted && includeArchived) return '1=1';
  if (includeDeleted && !includeArchived) return `(status != 'archived' AND NOT ${staleLocalPlaceholder})`;
  if (!includeDeleted && includeArchived) return `(status NOT IN ('deleted', 'deleting') AND NOT ${staleLocalPlaceholder})`;
  return `(status NOT IN ('deleted', 'archived', 'deleting') AND NOT ${staleLocalPlaceholder})`;
}

function encodeCursor(updatedAt, threadId) {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, thread_id: threadId }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(text);
    if (!parsed.updated_at || !parsed.thread_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeApproval(row) {
  return {
    id: row.id,
    runner_id: row.runner_id,
    workspace: row.workspace,
    task_id: row.task_id,
    task_text: row.task_text,
    risk_reason: decodeJSON(row.risk_reason_json, []),
    state: row.state,
    decision_by: row.decision_by,
    decision_at: row.decision_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeChatThread(row) {
  return {
    thread_id: row.thread_id,
    workspace: row.workspace,
    title: row.title || '',
    external_thread_id: row.external_thread_id,
    source: row.source,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeChatJob(row) {
  return {
    job_id: row.job_id,
    thread_id: row.thread_id,
    workspace: row.workspace,
    input_text: row.input_text,
    input_items: decodeJSON(row.input_items_json, null),
    policy: decodeJSON(row.policy_json, null),
    status: row.status,
    connector_id: row.connector_id,
    turn_id: row.turn_id,
    idempotency_key: row.idempotency_key,
    error_code: row.error_code,
    error_message: row.error_message,
    stop_requested_at: row.stop_requested_at,
    stop_requested_by: row.stop_requested_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeChatEvent(row) {
  return {
    seq: row.seq,
    thread_id: row.thread_id,
    workspace: row.workspace,
    job_id: row.job_id,
    turn_id: row.turn_id,
    type: row.type,
    delta: row.delta,
    payload: decodeJSON(row.payload_json, null),
    ts: row.ts,
  };
}

function normalizeChatUserInputRequest(row) {
  return {
    request_id: row.request_id,
    job_id: row.job_id,
    thread_id: row.thread_id,
    workspace: row.workspace,
    connector_id: row.connector_id,
    turn_id: row.turn_id,
    item_id: row.item_id,
    questions: decodeJSON(row.questions_json, []),
    answers: decodeJSON(row.answers_json, null),
    status: row.status,
    created_at: row.created_at,
    answered_at: row.answered_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

function normalizeConnector(row) {
  return {
    connector_id: row.connector_id,
    workspace: row.workspace,
    status: row.status,
    version: row.version,
    capabilities: decodeJSON(row.capabilities_json, null),
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeSessionSyncRequest(row) {
  return {
    request_id: row.request_id,
    workspace: row.workspace,
    thread_id: row.thread_id,
    requested_by: row.requested_by,
    status: row.status,
    connector_id: row.connector_id,
    error: row.error,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
  };
}

function normalizeAuthReloginRequest(row) {
  return {
    request_id: row.request_id,
    workspace: row.workspace,
    requested_by: row.requested_by,
    status: row.status,
    connector_id: row.connector_id,
    auth_url: row.auth_url,
    user_code: row.user_code,
    verification_uri_complete: row.verification_uri_complete,
    expires_at: row.expires_at,
    message: row.message,
    error: row.error,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
  };
}

function normalizeBackfillRun(row) {
  return {
    run_id: row.run_id,
    workspace: row.workspace,
    status: row.status,
    scanned_count: row.scanned_count,
    imported_count: row.imported_count,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.error,
  };
}

function statusForWorkspace(workspace) {
  const row = db
    .prepare(`SELECT * FROM runners WHERE workspace = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(workspace);
  if (!row) return null;
  const runnerOnline = !!row.online;
  return {
    runner_id: row.runner_id,
    workspace: row.workspace,
    runner_online: runnerOnline,
    online: runnerOnline,
    current_task: row.current_task_json ? decodeJSON(row.current_task_json, null) : null,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function heartbeatIsStale(value, staleSeconds) {
  const ts = timestampMs(value);
  if (ts == null) return true;
  return (Date.now() - ts) > (Math.max(1, staleSeconds) * 1000);
}

function latestRunnerRowForScope(workspace, includeAll) {
  if (includeAll) {
    return db.prepare(`SELECT * FROM runners ORDER BY updated_at DESC LIMIT 1`).get() || null;
  }
  return db
    .prepare(`SELECT * FROM runners WHERE workspace = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(workspace) || null;
}

function latestConnectorRowForScope(workspace, includeAll) {
  if (includeAll) {
    return db
      .prepare(`SELECT * FROM connector_runners ORDER BY updated_at DESC LIMIT 1`)
      .get() || null;
  }
  return db.prepare(`
    SELECT * FROM connector_runners
    WHERE workspace = ? OR workspace = '*'
    ORDER BY CASE WHEN workspace = ? THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(workspace, workspace) || null;
}

function runtimeRunnerStatus(row) {
  if (!row) return null;
  const reportedOnline = !!row.online;
  const heartbeatStale = heartbeatIsStale(row.updated_at, RUNNER_STATUS_STALE_SECONDS);
  const online = reportedOnline && !heartbeatStale;
  const state = heartbeatStale
    ? 'stale'
    : (reportedOnline ? 'online' : 'offline');
  const currentTask = row.current_task_json ? decodeJSON(row.current_task_json, null) : null;
  return {
    runner_id: row.runner_id,
    workspace: row.workspace,
    reported_online: reportedOnline,
    runner_online: online,
    online,
    heartbeat_stale: heartbeatStale,
    current_task: currentTask,
    last_success_at: row.last_success_at,
    last_error: row.last_error,
    updated_at: row.updated_at,
    state,
    stale_after_seconds: RUNNER_STATUS_STALE_SECONDS,
  };
}

function runtimeConnectorStatus(row) {
  if (!row) return null;
  const reportedStatus = String(row.status || '').trim().toLowerCase() || 'unknown';
  const reportedOnline = reportedStatus === 'online' || reportedStatus === 'degraded';
  const heartbeatStale = heartbeatIsStale(row.last_heartbeat_at || row.updated_at, CONNECTOR_STATUS_STALE_SECONDS);
  const online = reportedOnline && !heartbeatStale;
  const state = heartbeatStale ? 'stale' : reportedStatus;
  return {
    connector_id: row.connector_id,
    workspace: row.workspace,
    status: state,
    reported_status: reportedStatus,
    connector_online: online,
    online,
    heartbeat_stale: heartbeatStale,
    last_heartbeat_at: row.last_heartbeat_at,
    updated_at: row.updated_at,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    version: row.version,
    stale_after_seconds: CONNECTOR_STATUS_STALE_SECONDS,
  };
}

function unifiedStatusForScope(workspace, includeAll) {
  const runner = runtimeRunnerStatus(latestRunnerRowForScope(workspace, includeAll));
  const connector = runtimeConnectorStatus(latestConnectorRowForScope(workspace, includeAll));
  const runnerOnline = !!runner?.online;
  const connectorOnline = !!connector?.online;

  if (connector) {
    return {
      source: 'codex-iphone-connector',
      connector_online: connectorOnline,
      runner_online: runnerOnline,
      online: connectorOnline,
      state: connector.status,
      message: connector.heartbeat_stale
        ? 'Connector heartbeat is stale.'
        : (connector.last_error_message || null),
      runner,
      connector,
    };
  }
  if (runner) {
    return {
      source: 'legacy-runner',
      connector_online: connectorOnline,
      runner_online: runnerOnline,
      online: runnerOnline,
      state: runner.state,
      message: runner.heartbeat_stale
        ? 'Runner heartbeat is stale.'
        : (runner.last_error || null),
      runner,
      connector: null,
    };
  }
  return {
    source: 'none',
    connector_online: false,
    runner_online: false,
    online: false,
    state: 'unknown',
    message: 'No runner or connector heartbeat yet.',
    runner: null,
    connector: null,
  };
}

function recordApprovalFromEvent(event) {
  const ticket = event.payload?.ticket;
  if (!ticket || !ticket.id || !ticket.task_id) return;
  const ts = nowIso();
  upsertApprovalStmt.run(
    ticket.id,
    ticket.runner_id || event.runner_id,
    ticket.workspace || event.workspace,
    ticket.task_id,
    ticket.task_text || '',
    JSON.stringify(ticket.risk_reason || []),
    ticket.state || 'pending',
    ticket.decision_by || null,
    ticket.decision_at || null,
    ticket.created_at || event.ts || ts,
    ts,
  );
}

function applyTaskStateEvent(event) {
  const p = event.payload || {};
  if (!p.task_id && !p.status) return;
  upsertTaskStmt.run(
    event.workspace,
    p.task_id || null,
    p.task_text || null,
    p.task_mode || null,
    p.status || null,
    p.updated_at || event.ts || nowIso(),
  );
}

function defaultChatPolicy() {
  return {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  };
}

const REASONING_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SUMMARY_VALUES = new Set(['auto', 'concise', 'detailed', 'none']);
const USER_INPUT_ITEM_TYPES = new Set(['text', 'image', 'localImage', 'skill', 'mention']);

function normalizeCollaborationMode(value) {
  if (!value || typeof value !== 'object') return null;
  const mode = String(value.mode || '').trim().toLowerCase();
  if (!['default', 'plan'].includes(mode)) return null;
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : null;
  if (!settings) return null;
  const model = typeof settings.model === 'string' ? settings.model.trim() : '';
  if (!model) return null;
  const effort = String(settings.reasoning_effort ?? settings.reasoningEffort ?? '').trim().toLowerCase();
  let normalizedEffort = null;
  if (effort && REASONING_EFFORT_VALUES.has(effort)) normalizedEffort = effort;
  let developerInstructions = null;
  if (settings.developer_instructions === null || settings.developer_instructions == null) {
    developerInstructions = null;
  } else if (typeof settings.developer_instructions === 'string') {
    developerInstructions = settings.developer_instructions;
  }
  return {
    mode,
    settings: {
      model,
      reasoning_effort: normalizedEffort,
      developer_instructions: developerInstructions,
    },
  };
}

function normalizeChatPolicy(policy) {
  const base = defaultChatPolicy();
  if (!policy || typeof policy !== 'object') return base;
  const out = { ...base };
  if (typeof policy.approvalPolicy === 'string' && policy.approvalPolicy) out.approvalPolicy = policy.approvalPolicy;
  if (typeof policy.sandbox === 'string' && policy.sandbox) out.sandbox = policy.sandbox;
  if (policy.sandboxPolicy && typeof policy.sandboxPolicy === 'object') out.sandboxPolicy = policy.sandboxPolicy;
  if (typeof policy.cwd === 'string' && policy.cwd) out.cwd = policy.cwd;
  if (typeof policy.model === 'string' && policy.model) out.model = policy.model;
  if (typeof policy.personality === 'string' && policy.personality) out.personality = policy.personality;
  if (typeof policy.mode === 'string' && policy.mode) out.mode = policy.mode;
  if (typeof policy.effort === 'string') {
    const effort = policy.effort.trim().toLowerCase();
    if (REASONING_EFFORT_VALUES.has(effort)) out.effort = effort;
  }
  if (typeof policy.summary === 'string') {
    const summary = policy.summary.trim().toLowerCase();
    if (REASONING_SUMMARY_VALUES.has(summary)) out.summary = summary;
  }
  const collaborationMode = normalizeCollaborationMode(policy.collaborationMode);
  if (collaborationMode) out.collaborationMode = collaborationMode;
  return out;
}

function normalizeInputItems(inputItems) {
  if (!Array.isArray(inputItems)) return [];
  const out = [];
  for (const raw of inputItems.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '').trim();
    if (!USER_INPUT_ITEM_TYPES.has(type)) continue;
    if (type === 'text') {
      const text = typeof raw.text === 'string' ? raw.text.trim() : '';
      if (!text) continue;
      out.push({ type: 'text', text });
      continue;
    }
    if (type === 'image') {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      if (!url) continue;
      out.push({ type: 'image', url });
      continue;
    }
    if (type === 'localImage') {
      const imagePath = typeof raw.path === 'string' ? raw.path.trim() : '';
      if (!imagePath) continue;
      out.push({ type: 'localImage', path: imagePath });
      continue;
    }
    if (type === 'skill' || type === 'mention') {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const itemPath = typeof raw.path === 'string' ? raw.path.trim() : '';
      if (!name || !itemPath) continue;
      out.push({ type, name, path: itemPath });
      continue;
    }
  }
  return out;
}

function summarizeInputText(inputText, inputItems) {
  const textParts = [];
  let imageCount = 0;
  for (const item of inputItems) {
    if (item.type === 'text' && item.text) textParts.push(item.text);
    if (item.type === 'image' || item.type === 'localImage') imageCount += 1;
  }
  if (textParts.length) return textParts.join('\n').trim().slice(0, 10_000);
  if (typeof inputText === 'string' && inputText.trim()) return inputText.trim().slice(0, 10_000);
  if (imageCount > 0) return imageCount > 1 ? `[${imageCount} images]` : '[Image]';
  return '';
}

function usageFromTokenUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
  const tokenUsage = params.tokenUsage && typeof params.tokenUsage === 'object' ? params.tokenUsage : {};
  const total = tokenUsage.total && typeof tokenUsage.total === 'object' ? tokenUsage.total : {};
  const getNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    total_tokens: getNum(total.totalTokens),
    input_tokens: getNum(total.inputTokens),
    cached_input_tokens: getNum(total.cachedInputTokens),
    output_tokens: getNum(total.outputTokens),
    reasoning_output_tokens: getNum(total.reasoningOutputTokens),
    model_context_window: getNum(tokenUsage.modelContextWindow),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegativeIntOrNull(value) {
  const n = numberOrNull(value);
  if (n == null || n < 0) return null;
  return Math.floor(n);
}

function pickValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function clampPercent(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Number(n.toFixed(2));
}

function normalizeRateLimitWindow(value, scopeHint, fallbackUpdatedAt) {
  if (!value || typeof value !== 'object') return null;
  const windowMinutes = nonNegativeIntOrNull(pickValue(value, [
    'window_minutes',
    'windowMinutes',
    'window_min',
    'window',
  ]));
  if (!windowMinutes || windowMinutes <= 0) return null;

  let usedPercent = clampPercent(pickValue(value, [
    'used_percent',
    'usedPercent',
    'used_pct',
  ]));
  let remainingPercent = clampPercent(pickValue(value, [
    'remaining_percent',
    'remainingPercent',
    'remaining_pct',
  ]));

  const usedTokens = nonNegativeIntOrNull(pickValue(value, [
    'used_tokens',
    'usedTokens',
    'consumed_tokens',
    'consumedTokens',
    'consumed',
    'used',
  ]));
  const limitTokens = nonNegativeIntOrNull(pickValue(value, [
    'limit_tokens',
    'limitTokens',
    'max_tokens',
    'maxTokens',
    'limit',
    'max',
  ]));

  if (usedPercent == null && remainingPercent != null) {
    usedPercent = clampPercent(100 - remainingPercent);
  }
  if (remainingPercent == null && usedPercent != null) {
    remainingPercent = clampPercent(100 - usedPercent);
  }
  if (usedPercent == null && usedTokens != null && limitTokens && limitTokens > 0) {
    usedPercent = clampPercent((usedTokens / limitTokens) * 100);
    remainingPercent = clampPercent(100 - usedPercent);
  }

  const scopeRaw = String(
    scopeHint
    || pickValue(value, ['scope', 'name', 'label', 'tier'])
    || '',
  ).trim();
  const scope = scopeRaw || null;
  const resetAt = (() => {
    const raw = pickValue(value, [
      'reset_at',
      'resetAt',
      'resets_at',
      'resetsAt',
      'next_reset_at',
      'nextResetAt',
    ]);
    if (raw == null) return null;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      if (/^\d{10,13}$/.test(trimmed)) {
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber)) {
          const ms = trimmed.length >= 13 ? asNumber : asNumber * 1000;
          return new Date(ms).toISOString();
        }
      }
      return trimmed;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const ms = raw >= 1_000_000_000_000 ? raw : raw * 1000;
      return new Date(ms).toISOString();
    }
    return null;
  })();

  return {
    scope,
    window_minutes: windowMinutes,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    used_tokens: usedTokens,
    limit_tokens: limitTokens,
    reset_at: resetAt,
    updated_at: fallbackUpdatedAt || null,
  };
}

function rateLimitWindowsFromPayload(payload, fallbackUpdatedAt) {
  if (!payload || typeof payload !== 'object') return [];
  let params = payload.params && typeof payload.params === 'object' ? payload.params : payload;
  const nestedCandidates = [
    params.payload,
    params.msg,
    params.message,
  ].filter((item) => item && typeof item === 'object');
  const nestedPayload = nestedCandidates.find((item) => {
    const nestedType = String(item.type || '').trim().toLowerCase();
    if (nestedType === 'token_count' || nestedType.includes('rate_limit')) return true;
    if (item.rate_limits || item.rateLimits) return true;
    return false;
  }) || null;
  if (nestedPayload) {
    const nestedType = String(nestedPayload.type || '').trim().toLowerCase();
    if (
      nestedType === 'token_count'
      || nestedType.includes('rate_limit')
      || nestedPayload.rate_limits
      || nestedPayload.rateLimits
    ) {
      params = nestedPayload;
    }
  }
  const rateLimits = (
    params.rate_limits
    || params.rateLimits
    || (params.msg && typeof params.msg === 'object' ? (params.msg.rate_limits || params.msg.rateLimits) : null)
    || payload.rate_limits
    || payload.rateLimits
    || null
  );
  if (!rateLimits || typeof rateLimits !== 'object') return [];

  const windows = [];
  const pushWindow = (candidate, scopeHint = null) => {
    const normalized = normalizeRateLimitWindow(candidate, scopeHint, fallbackUpdatedAt);
    if (normalized) windows.push(normalized);
  };

  if (Array.isArray(rateLimits)) {
    for (const item of rateLimits) {
      pushWindow(item, null);
    }
    return windows;
  }

  if (rateLimits.primary && typeof rateLimits.primary === 'object') {
    pushWindow(rateLimits.primary, 'primary');
  }
  if (rateLimits.secondary && typeof rateLimits.secondary === 'object') {
    pushWindow(rateLimits.secondary, 'secondary');
  }

  const direct = normalizeRateLimitWindow(rateLimits, null, fallbackUpdatedAt);
  if (direct) windows.push(direct);
  for (const [key, value] of Object.entries(rateLimits)) {
    if (key === 'primary' || key === 'secondary') continue;
    if (value && typeof value === 'object') {
      pushWindow(value, key);
    }
  }

  return windows;
}

function tokenUsageFromTokenCountPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const params = payload.params && typeof payload.params === 'object' ? payload.params : payload;
  const nested = (
    (params.msg && typeof params.msg === 'object' ? params.msg : null)
    || (params.payload && typeof params.payload === 'object' ? params.payload : null)
    || params
  );
  const info = nested.info && typeof nested.info === 'object' ? nested.info : null;
  if (!info) return null;

  const usage = info.total_token_usage || info.totalTokenUsage || null;
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = nonNegativeIntOrNull(pickValue(usage, ['input_tokens', 'inputTokens']));
  const cachedInputTokens = nonNegativeIntOrNull(pickValue(usage, ['cached_input_tokens', 'cachedInputTokens']));
  const outputTokens = nonNegativeIntOrNull(pickValue(usage, ['output_tokens', 'outputTokens']));
  const reasoningOutputTokens = nonNegativeIntOrNull(pickValue(usage, ['reasoning_output_tokens', 'reasoningOutputTokens']));
  const totalTokens = nonNegativeIntOrNull(pickValue(usage, ['total_tokens', 'totalTokens']));

  if (
    totalTokens == null
    && inputTokens == null
    && cachedInputTokens == null
    && outputTokens == null
    && reasoningOutputTokens == null
  ) {
    return null;
  }

  return {
    total_tokens: totalTokens || 0,
    input_tokens: inputTokens || 0,
    cached_input_tokens: cachedInputTokens || 0,
    output_tokens: outputTokens || 0,
    reasoning_output_tokens: reasoningOutputTokens || 0,
  };
}

function extractRateLimitsFromRolloutFile(filePath, fallbackUpdatedAt) {
  const windowsByMinutes = new Map();
  let latestUpdatedAt = null;
  let maxTotalTokens = null;

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { windows: [], latestUpdatedAt: null, maxTotalTokens: null };
  }
  if (!content) {
    return { windows: [], latestUpdatedAt: null, maxTotalTokens: null };
  }

  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    let payload = null;
    if (parsed?.type === 'event_msg' && parsed.payload && typeof parsed.payload === 'object') {
      payload = parsed.payload;
    } else if (parsed?.type === 'token_count' && parsed.payload && typeof parsed.payload === 'object') {
      payload = parsed.payload;
    } else if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
      payload = parsed.payload;
    }
    if (!payload || typeof payload !== 'object') continue;

    const ts = normalizeTimestamp(parsed.timestamp || parsed.ts || null, fallbackUpdatedAt || null);
    const windows = rateLimitWindowsFromPayload(payload, ts);
    if (!windows.length) continue;

    for (const window of windows) {
      const key = String(window.window_minutes || '');
      if (!key || windowsByMinutes.has(key)) continue;
      windowsByMinutes.set(key, window);
      if (window.updated_at && (!latestUpdatedAt || window.updated_at > latestUpdatedAt)) {
        latestUpdatedAt = window.updated_at;
      }
    }

    const usage = tokenUsageFromTokenCountPayload(payload);
    if (usage?.total_tokens != null) {
      maxTotalTokens = Math.max(maxTotalTokens || 0, usage.total_tokens);
    }

    if (windowsByMinutes.has('300') && windowsByMinutes.has('10080') && maxTotalTokens != null) {
      break;
    }
  }

  return {
    windows: Array.from(windowsByMinutes.values()),
    latestUpdatedAt,
    maxTotalTokens,
  };
}

function rateLimitFallbackFromRolloutFiles(workspace, includeAll, maxFiles = 80) {
  const files = [];
  listRolloutFiles(SESSIONS_DIR, 'sessions', files);
  listRolloutFiles(ARCHIVED_SESSIONS_DIR, 'archived', files);
  if (!files.length) {
    return { windows: [], latestUpdatedAt: null, maxTotalTokens: null };
  }

  files.sort((a, b) => {
    let am = 0;
    let bm = 0;
    try { am = fs.statSync(a.path).mtimeMs; } catch {}
    try { bm = fs.statSync(b.path).mtimeMs; } catch {}
    return bm - am;
  });

  const windowsByMinutes = new Map();
  let latestUpdatedAt = null;
  let maxTotalTokens = null;
  let scanned = 0;

  for (const item of files) {
    if (scanned >= maxFiles) break;
    scanned += 1;

    let stat;
    try {
      stat = fs.statSync(item.path);
    } catch {
      continue;
    }
    const fallbackTs = stat?.mtime ? stat.mtime.toISOString() : nowIso();

    if (!includeAll) {
      let summary;
      try {
        summary = parseRolloutSummary(item.path);
      } catch {
        continue;
      }
      const inferredWorkspace = summary?.cwd
        ? path.basename(summary.cwd)
        : (workspace || DEFAULT_WORKSPACE);
      if (inferredWorkspace !== workspace) {
        continue;
      }
    }

    const extracted = extractRateLimitsFromRolloutFile(item.path, fallbackTs);
    for (const window of extracted.windows) {
      const key = String(window.window_minutes || '');
      if (!key || windowsByMinutes.has(key)) continue;
      windowsByMinutes.set(key, window);
      if (window.updated_at && (!latestUpdatedAt || window.updated_at > latestUpdatedAt)) {
        latestUpdatedAt = window.updated_at;
      }
    }
    if (extracted.latestUpdatedAt && (!latestUpdatedAt || extracted.latestUpdatedAt > latestUpdatedAt)) {
      latestUpdatedAt = extracted.latestUpdatedAt;
    }
    if (extracted.maxTotalTokens != null) {
      maxTotalTokens = Math.max(maxTotalTokens || 0, extracted.maxTotalTokens);
    }

    if (windowsByMinutes.has('300') && windowsByMinutes.has('10080') && maxTotalTokens != null) {
      break;
    }
  }

  return {
    windows: Array.from(windowsByMinutes.values()),
    latestUpdatedAt,
    maxTotalTokens,
  };
}

function pickNearestWindow(windows, targetMinutes) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of windows) {
    if (!item || typeof item !== 'object') continue;
    const minutes = nonNegativeIntOrNull(item.window_minutes);
    if (!minutes) continue;
    const distance = Math.abs(minutes - targetMinutes);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  if (best && bestDistance <= 60) return best;
  return null;
}

function upsertChatThread({ threadId, workspace, title, externalThreadId, source, status, createdAt, updatedAt }) {
  const existing = selectChatThreadStmt.get(threadId);
  const normalizedTitle = typeof title === 'string' ? title : null;
  const nextTitle = normalizedTitle != null && normalizedTitle.trim()
    ? normalizedTitle
    : (existing?.title ?? '');
  const normalizedWorkspace = typeof workspace === 'string' ? workspace.trim() : '';
  const nextWorkspace = normalizedWorkspace && normalizedWorkspace !== '__unknown__'
    ? normalizedWorkspace
    : (existing?.workspace || DEFAULT_WORKSPACE);
  if (!existing) {
    insertChatThreadStmt.run(
      threadId,
      nextWorkspace,
      nextTitle || '',
      externalThreadId || null,
      source || 'ios',
      status || 'idle',
      createdAt,
      updatedAt,
    );
    return normalizeChatThread(selectChatThreadStmt.get(threadId));
  }
  updateChatThreadStmt.run(
    nextWorkspace,
    nextTitle,
    externalThreadId || existing.external_thread_id || null,
    source || existing.source || 'ios',
    status || existing.status || 'idle',
    updatedAt,
    threadId,
  );
  return normalizeChatThread(selectChatThreadStmt.get(threadId));
}

function appendChatEvent({ threadId, workspace, jobId, turnId, type, delta, payload, ts }) {
  const seq = nextChatSeqStmt.get(threadId).next_seq;
  insertChatEventStmt.run(
    threadId,
    seq,
    workspace,
    jobId || null,
    turnId || null,
    type || 'event',
    delta == null ? null : String(delta),
    payload == null ? null : JSON.stringify(payload),
    ts || nowIso(),
  );
  return seq;
}

const SESSION_SYNC_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function sessionSyncCompactText(value, maxLength = 1600) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function sessionSyncCompactInputItems(items) {
  const normalizedItems = normalizeInputItems(items);
  if (!normalizedItems.length) return [];
  return normalizedItems.slice(0, 16).map((item) => ({
    type: sessionSyncCompactText(item.type, 32),
    text: sessionSyncCompactText(item.text, 280),
    url: sessionSyncCompactText(item.url, 280),
    path: sessionSyncCompactText(item.path, 280),
    name: sessionSyncCompactText(item.name, 120),
  }));
}

function sessionSyncMessageKey(role, text, inputItems) {
  return hashText(JSON.stringify({
    role: sessionSyncCompactText(role, 16),
    text: sessionSyncCompactText(text),
    input_items: sessionSyncCompactInputItems(inputItems),
  }));
}

function sessionSyncMessageSignature(role, text, inputItems, ts) {
  const key = sessionSyncMessageKey(role, text, inputItems);
  const normalizedTs = sessionSyncCompactText(ts, 64);
  return hashText(`${key}|${normalizedTs}`);
}

function decodeExistingTranscriptEvent(row) {
  if (!row || typeof row !== 'object') return null;
  const role = row.type === 'assistant.message' ? 'assistant' : row.type === 'user.message' ? 'user' : '';
  if (!role) return null;
  const payload = decodeJSON(row.payload_json, {});
  const normalizedItems = sessionSyncCompactInputItems(payload?.input_items);
  let text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text && typeof row.delta === 'string') {
    text = row.delta.trim();
  }
  if (!text && normalizedItems.length > 0) {
    text = summarizeInputText('', normalizedItems);
  }
  if (!text && normalizedItems.length === 0) return null;
  const rawTs = typeof row.ts === 'string' ? row.ts : '';
  const ts = normalizeTimestamp(rawTs, '');
  const tsMs = Date.parse(ts);
  const key = sessionSyncMessageKey(role, text, normalizedItems);
  const signature = sessionSyncCompactText(payload?.session_sync_signature, 128)
    || sessionSyncMessageSignature(role, text, normalizedItems, ts);
  return {
    key,
    signature,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
  };
}

function importThreadMessagesIncremental({ threadId, workspace, messages, ts }) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const knownSignatures = new Set();
  const latestTsByMessageKey = new Map();
  const recentEvents = selectRecentTranscriptEventsByThreadStmt.all(threadId);
  for (const row of recentEvents) {
    const decoded = decodeExistingTranscriptEvent(row);
    if (!decoded) continue;
    knownSignatures.add(decoded.signature);
    if (decoded.tsMs == null) continue;
    const previous = latestTsByMessageKey.get(decoded.key);
    if (previous == null || decoded.tsMs > previous) {
      latestTsByMessageKey.set(decoded.key, decoded.tsMs);
    }
  }

  let inserted = 0;
  for (const raw of messages.slice(0, 240)) {
    if (!raw || typeof raw !== 'object') continue;
    const role = String(raw.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;
    const normalizedItems = sessionSyncCompactInputItems(raw.input_items);
    let text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text && normalizedItems.length > 0) {
      text = summarizeInputText('', normalizedItems);
    }
    if (!text && normalizedItems.length === 0) continue;
    const messageTs = normalizeTimestamp(raw.ts, ts);
    const messageTsMs = Date.parse(messageTs);
    const messageKey = sessionSyncMessageKey(role, text, normalizedItems);
    const signature = sessionSyncMessageSignature(role, text, normalizedItems, messageTs);
    if (knownSignatures.has(signature)) continue;
    const previousMs = latestTsByMessageKey.get(messageKey);
    if (
      previousMs != null
      && Number.isFinite(previousMs)
      && Number.isFinite(messageTsMs)
      && Math.abs(messageTsMs - previousMs) <= SESSION_SYNC_DUPLICATE_WINDOW_MS
    ) {
      knownSignatures.add(signature);
      continue;
    }
    const payload = { source: 'codex.session_sync', role };
    payload.session_sync_signature = signature;
    if (text) payload.text = text;
    if (normalizedItems.length > 0) payload.input_items = normalizedItems;
    appendChatEvent({
      threadId,
      workspace,
      jobId: null,
      turnId: null,
      type: role === 'assistant' ? 'assistant.message' : 'user.message',
      delta: text,
      payload,
      ts: messageTs,
    });
    inserted += 1;
    knownSignatures.add(signature);
    if (Number.isFinite(messageTsMs)) {
      latestTsByMessageKey.set(messageKey, messageTsMs);
    }
  }
  return inserted;
}

function ensureThreadForMessage({ threadId, workspace }) {
  const row = selectChatThreadStmt.get(threadId);
  if (row) return normalizeChatThread(row);
  const ts = nowIso();
  return upsertChatThread({
    threadId,
    workspace,
    title: '',
    externalThreadId: null,
    source: 'ios',
    status: 'idle',
    createdAt: ts,
    updatedAt: ts,
  });
}

function listRolloutFiles(rootDir, source, out) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      out.push({ path: p, source });
    }
  }
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

function parseRolloutSummary(filePath) {
  const stat = fs.statSync(filePath);
  const fallbackCreatedAt = stat.mtime.toISOString();
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  const summary = {
    threadId: null,
    cwd: null,
    title: '',
    createdAt: fallbackCreatedAt,
    updatedAt: stat.mtime.toISOString(),
  };

  for (let i = 0; i < lines.length && i < 250; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
      summary.threadId = summary.threadId || parsed.payload.id || null;
      summary.cwd = summary.cwd || parsed.payload.cwd || null;
      summary.createdAt = parsed.payload.timestamp || summary.createdAt;
      continue;
    }
    if (summary.title) continue;
    if (parsed.type === 'response_item' && parsed.payload && parsed.payload.type === 'message' && parsed.payload.role === 'user') {
      const text = extractTextContent(parsed.payload.content);
      if (text) summary.title = text.slice(0, 200);
    }
  }

  return summary;
}

function runBackfill(workspaceFilter, maxFiles) {
  const normalizedWorkspaceFilter = isAllWorkspaces(workspaceFilter)
    ? null
    : workspaceFrom(workspaceFilter);
  const files = [];
  listRolloutFiles(SESSIONS_DIR, 'sessions', files);
  listRolloutFiles(ARCHIVED_SESSIONS_DIR, 'archived', files);
  files.sort((a, b) => {
    const am = fs.statSync(a.path).mtimeMs;
    const bm = fs.statSync(b.path).mtimeMs;
    return bm - am;
  });

  let scanned = 0;
  let imported = 0;

  for (const item of files.slice(0, maxFiles)) {
    scanned += 1;
    let summary;
    try {
      summary = parseRolloutSummary(item.path);
    } catch {
      continue;
    }
    const inferredWorkspace = summary.cwd ? path.basename(summary.cwd) : normalizedWorkspaceFilter || DEFAULT_WORKSPACE;
    if (normalizedWorkspaceFilter && inferredWorkspace !== normalizedWorkspaceFilter) continue;

    const threadId = summary.threadId || `rollout_${hashText(item.path).slice(0, 20)}`;
    const title = summary.title || `Session ${threadId.slice(0, 12)}`;

    upsertChatThread({
      threadId,
      workspace: inferredWorkspace,
      title,
      externalThreadId: summary.threadId || null,
      source: item.source,
      status: 'idle',
      createdAt: summary.createdAt || nowIso(),
      updatedAt: summary.updatedAt || nowIso(),
    });
    imported += 1;
  }

  return { scanned, imported };
}

function collectKnownWorkspaces() {
  const seen = new Map();
  const addRows = (rows, source) => {
    for (const row of rows) {
      const name = String(row.workspace || '').trim();
      if (!name || name === '*') continue;
      if (!seen.has(name)) seen.set(name, source);
    }
  };

  addRows(db.prepare(`SELECT DISTINCT workspace FROM chat_threads`).all(), 'threads');
  addRows(db.prepare(`SELECT DISTINCT workspace FROM chat_jobs`).all(), 'jobs');
  addRows(db.prepare(`SELECT DISTINCT workspace FROM connector_runners`).all(), 'connectors');
  addRows(db.prepare(`SELECT DISTINCT workspace FROM runners`).all(), 'runners');
  addRows(db.prepare(`SELECT DISTINCT workspace FROM tasks_current`).all(), 'tasks');

  if (!seen.size && DEFAULT_WORKSPACE) {
    seen.set(DEFAULT_WORKSPACE, 'default');
  }

  return Array.from(seen.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, source]) => ({ name, source }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  url.pathname = normalizeApiPath(url.pathname);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, { ok: true, ts: nowIso(), db_path: DB_PATH });
    return;
  }

  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  try {
    if (url.pathname === CONTROL_PLANE_API_PREFIX || url.pathname.startsWith(`${CONTROL_PLANE_API_PREFIX}/`)) {
      await proxyToControlPlane(req, res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/legacy-runner/heartbeat') {
      const body = await parseBody(req);
      const ts = nowIso();
      upsertRunnerStmt.run(
        body.runner_id,
        body.workspace,
        body.online ? 1 : 0,
        body.current_task ? JSON.stringify(body.current_task) : null,
        body.last_success_at || null,
        body.last_error || null,
        body.updated_at || ts,
      );

      if (body.current_task) {
        upsertTaskStmt.run(
          body.workspace,
          body.current_task.id || null,
          body.current_task.text || null,
          body.current_task.mode || null,
          body.current_task.status || null,
          body.updated_at || ts,
        );
      }

      json(res, 200, { ok: true, ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/legacy-runner/events') {
      const body = await parseBody(req);
      const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];

      db.exec('BEGIN');
      try {
        for (const event of events) {
          const normalized = {
            id: event.id || `evt_${Math.random().toString(16).slice(2)}`,
            runner_id: event.runner_id || body.runner_id,
            workspace: event.workspace || body.workspace,
            task_id: event.task_id || null,
            level: event.level || 'info',
            phase: event.phase || 'unknown',
            message: event.message || '',
            payload: event.payload || null,
            ts: event.ts || nowIso(),
          };

          insertEventStmt.run(
            normalized.id,
            normalized.runner_id,
            normalized.workspace,
            normalized.task_id,
            normalized.level,
            normalized.phase,
            normalized.message,
            normalized.payload ? JSON.stringify(normalized.payload) : null,
            normalized.ts,
          );

          if (normalized.phase === 'approval.created') recordApprovalFromEvent(normalized);
          if (normalized.phase === 'task.state') applyTaskStateEvent(normalized);
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      json(res, 200, { ok: true, count: events.length, ts: nowIso() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/legacy-runner/status') {
      const workspace = workspaceFrom(url.searchParams.get('workspace'));
      json(res, 200, { ok: true, status: statusForWorkspace(workspace), ts: nowIso() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/legacy-runner/approvals') {
      const workspace = workspaceFrom(url.searchParams.get('workspace'));
      const state = (url.searchParams.get('state') || 'pending').toLowerCase();
      let rows;
      if (state === 'all') {
        rows = db
          .prepare(`SELECT * FROM approvals WHERE workspace = ? ORDER BY updated_at DESC LIMIT 200`)
          .all(workspace);
      } else {
        rows = db
          .prepare(`SELECT * FROM approvals WHERE workspace = ? AND state = ? ORDER BY updated_at DESC LIMIT 200`)
          .all(workspace, state);
      }
      json(res, 200, { ok: true, approvals: rows.map(normalizeApproval), ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && /^\/legacy-runner\/approvals\/.+\/decision$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const body = await parseBody(req);
      const decision = (body.decision || '').toLowerCase();
      if (!['approved', 'rejected'].includes(decision)) {
        badRequest(res, 'decision must be approved or rejected');
        return;
      }
      const ts = nowIso();
      const result = db
        .prepare(`UPDATE approvals SET state = ?, decision_by = ?, decision_at = ?, updated_at = ? WHERE id = ?`)
        .run(decision, body.decision_by || 'ios-user', ts, ts, id);
      if (!result.changes) {
        json(res, 404, { ok: false, error: 'approval not found' });
        return;
      }
      const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id);
      json(res, 200, { ok: true, approval: normalizeApproval(row), ts });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/legacy-runner/tasks/current') {
      const workspace = workspaceFrom(url.searchParams.get('workspace'));
      const row = db.prepare(`SELECT * FROM tasks_current WHERE workspace = ?`).get(workspace);
      json(res, 200, { ok: true, task: row || null, ts: nowIso() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/legacy-runner/events') {
      const workspace = workspaceFrom(url.searchParams.get('workspace'));
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100);
      const rows = db
        .prepare(`SELECT * FROM events WHERE workspace = ? ORDER BY ts DESC LIMIT ?`)
        .all(workspace, limit)
        .map((row) => ({
          id: row.id,
          runner_id: row.runner_id,
          workspace: row.workspace,
          task_id: row.task_id,
          level: row.level,
          phase: row.phase,
          message: row.message,
          payload: decodeJSON(row.payload_json, null),
          ts: row.ts,
        }));
      json(res, 200, { ok: true, events: rows, ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/chat/threads') {
      const body = await parseBody(req);
      const workspace = workspaceFrom(body.workspace);
      const threadId = String(body.thread_id || randomId('thr_local'));
      const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
      const source = typeof body.source === 'string' && body.source ? body.source : 'ios';
      const status = typeof body.status === 'string' && body.status ? body.status : 'idle';
      const ts = nowIso();
      const createdAt = normalizeTimestamp(body.created_at, ts);
      const updatedAt = normalizeTimestamp(body.updated_at, createdAt);
      const thread = upsertChatThread({
        threadId,
        workspace,
        title,
        externalThreadId: body.external_thread_id || null,
        source,
        status,
        createdAt,
        updatedAt,
      });
      json(res, 200, { ok: true, thread, ts });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/codex-iphone-connector/chat/threads') {
      const workspaceParam = url.searchParams.get('workspace');
      const includeAll = isAllWorkspaces(workspaceParam);
      const workspace = workspaceFrom(workspaceParam);
      const limit = clampInt(url.searchParams.get('limit'), 1, 100, 30);
      const includeDeleted = parseBoolQuery(url.searchParams.get('include_deleted'));
      const includeArchived = parseBoolQuery(url.searchParams.get('include_archived'));
      const visibility = threadVisibilityClause(includeDeleted, includeArchived);
      const cursor = decodeCursor(url.searchParams.get('cursor'));
      let rows;
      if (cursor) {
        if (includeAll) {
          rows = db
            .prepare(`
              SELECT * FROM chat_threads
              WHERE (${visibility})
                AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
              ORDER BY updated_at DESC, thread_id DESC
              LIMIT ?
            `)
            .all(cursor.updated_at, cursor.updated_at, cursor.thread_id, limit + 1);
        } else {
          rows = db
            .prepare(`
              SELECT * FROM chat_threads
              WHERE workspace = ?
                AND (${visibility})
                AND (updated_at < ? OR (updated_at = ? AND thread_id < ?))
              ORDER BY updated_at DESC, thread_id DESC
              LIMIT ?
            `)
            .all(workspace, cursor.updated_at, cursor.updated_at, cursor.thread_id, limit + 1);
        }
      } else {
        if (includeAll) {
          rows = db
            .prepare(`
              SELECT * FROM chat_threads
              WHERE ${visibility}
              ORDER BY updated_at DESC, thread_id DESC
              LIMIT ?
            `)
            .all(limit + 1);
        } else {
          rows = db
            .prepare(`
              SELECT * FROM chat_threads
              WHERE workspace = ?
                AND ${visibility}
              ORDER BY updated_at DESC, thread_id DESC
              LIMIT ?
            `)
            .all(workspace, limit + 1);
        }
      }
      const hasNext = rows.length > limit;
      const page = rows.slice(0, limit).map(normalizeChatThread);
      const nextCursor = hasNext && page.length
        ? encodeCursor(page[page.length - 1].updated_at, page[page.length - 1].thread_id)
        : null;
      json(res, 200, { ok: true, threads: page, next_cursor: nextCursor, ts: nowIso() });
      return;
    }

    const threadDeleteMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)\/delete$/);
    if (req.method === 'POST' && threadDeleteMatch) {
      const threadId = decodeURIComponent(threadDeleteMatch[1]);
      const body = await parseBody(req);
      const row = selectChatThreadStmt.get(threadId);
      if (!row) {
        json(res, 404, { ok: false, error: 'thread_not_found' });
        return;
      }

      const thread = normalizeChatThread(row);
      const ts = nowIso();
      const requestedBy = String(body.requested_by || 'ios-delete-thread').slice(0, 120);
      let request = null;

      if (thread.external_thread_id || thread.source === 'codex') {
        updateThreadStatusStmt.run('deleting', ts, threadId);
        const requestId = randomId('sync_req');
        insertSessionSyncRequestStmt.run(requestId, thread.workspace, threadId, requestedBy, ts);
        request = selectSessionSyncRequestStmt.get(requestId);
      } else {
        updateThreadStatusStmt.run('deleted', ts, threadId);
      }

      const updatedThread = normalizeChatThread(selectChatThreadStmt.get(threadId));
      json(res, 200, {
        ok: true,
        thread: updatedThread,
        request: request ? normalizeSessionSyncRequest(request) : null,
        ts,
      });
      return;
    }

    const threadInterruptMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)\/interrupt$/);
    if (req.method === 'POST' && threadInterruptMatch) {
      const threadId = decodeURIComponent(threadInterruptMatch[1]);
      const body = await parseBody(req);
      const row = selectChatThreadStmt.get(threadId);
      if (!row) {
        json(res, 404, { ok: false, error: 'thread_not_found' });
        return;
      }
      const thread = normalizeChatThread(row);
      const requestedBy = String(body.requested_by || 'ios-stop-thread').slice(0, 120);
      const ts = nowIso();
      const stopMessage = 'Stopped by user from iPhone.';
      let updatedJob = null;
      let requested = false;
      let mode = 'none';

      db.exec('BEGIN');
      try {
        const activeJob = selectLatestActiveChatJobByThreadStmt.get(threadId);
        if (activeJob) {
          const status = String(activeJob.status || '').toLowerCase();
          if (status === 'queued') {
            interruptChatJobStmt.run(activeJob.turn_id || null, 'TURN_INTERRUPTED', stopMessage, ts, activeJob.job_id);
            updateThreadStatusStmt.run('interrupted', ts, threadId);
            appendChatEvent({
              threadId,
              workspace: thread.workspace,
              jobId: activeJob.job_id,
              turnId: activeJob.turn_id || null,
              type: 'job.interrupted',
              delta: stopMessage,
              payload: {
                error_code: 'TURN_INTERRUPTED',
                error_message: stopMessage,
                requested_by: requestedBy,
              },
              ts,
            });
            requested = true;
            mode = 'interrupted';
          } else if (status === 'claimed' || status === 'running') {
            const changed = requestChatJobStopStmt.run(ts, requestedBy, ts, activeJob.job_id);
            if (changed.changes === 1) {
              appendChatEvent({
                threadId,
                workspace: thread.workspace,
                jobId: activeJob.job_id,
                turnId: activeJob.turn_id || null,
                type: 'job.interrupt_requested',
                delta: 'Stop requested from iPhone.',
                payload: {
                  requested_by: requestedBy,
                },
                ts,
              });
              requested = true;
              mode = 'requested';
            }
          }
          updatedJob = selectChatJobStmt.get(activeJob.job_id);
        } else if (['queued', 'claimed', 'running'].includes(String(thread.status || '').toLowerCase())) {
          updateThreadStatusStmt.run('interrupted', ts, threadId);
          appendChatEvent({
            threadId,
            workspace: thread.workspace,
            jobId: null,
            turnId: null,
            type: 'job.interrupted',
            delta: stopMessage,
            payload: {
              error_code: 'TURN_INTERRUPTED',
              error_message: stopMessage,
              requested_by: requestedBy,
            },
            ts,
          });
          requested = true;
          mode = 'interrupted';
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      const updatedThread = selectChatThreadStmt.get(threadId);
      json(res, 200, {
        ok: true,
        thread: normalizeChatThread(updatedThread),
        job: updatedJob ? normalizeChatJob(updatedJob) : null,
        requested,
        mode,
        ts,
      });
      return;
    }

    const threadMessageMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)\/messages$/);
    if (req.method === 'POST' && threadMessageMatch) {
      const threadId = decodeURIComponent(threadMessageMatch[1]);
      const body = await parseBody(req);
      const normalizedItems = normalizeInputItems(body.input_items);
      const inputText = summarizeInputText(body.input_text, normalizedItems);
      if (!inputText && normalizedItems.length === 0) {
        badRequest(res, 'input_text or input_items is required');
        return;
      }
      const workspace = workspaceFrom(body.workspace);
      const thread = ensureThreadForMessage({ threadId, workspace });
      const idempotencyKey = String(body.idempotency_key || randomId('msg'));
      const policy = normalizeChatPolicy(body.policy);
      const replaceRunning = body.replace_running !== false;
      const existing = selectChatJobByIdempotencyStmt.get(idempotencyKey);
      if (existing) {
        if (existing.thread_id !== threadId) {
          json(res, 409, { ok: false, error: 'idempotency_key already used on another thread' });
          return;
        }
        json(res, 200, {
          ok: true,
          thread: normalizeChatThread(selectChatThreadStmt.get(threadId)),
          job: normalizeChatJob(existing),
          duplicate: true,
          ts: nowIso(),
        });
        return;
      }

      const ts = nowIso();
      const jobId = randomId('job');
      const supersededMessage = 'Superseded by a newer iPhone message.';
      db.exec('BEGIN');
      try {
        const staleQueued = selectQueuedChatJobsByThreadStmt.all(threadId);
        for (const queued of staleQueued) {
          interruptChatJobStmt.run(
            queued.turn_id || null,
            'TURN_SUPERSEDED',
            supersededMessage,
            ts,
            queued.job_id,
          );
          appendChatEvent({
            threadId,
            workspace: thread.workspace,
            jobId: queued.job_id,
            turnId: queued.turn_id || null,
            type: 'job.interrupted',
            delta: supersededMessage,
            payload: {
              error_code: 'TURN_SUPERSEDED',
              error_message: supersededMessage,
              replaced_by: 'ios-new-message',
            },
            ts,
          });
        }

        const activeBefore = selectLatestActiveChatJobByThreadStmt.get(threadId);
        const activeStatus = String(activeBefore?.status || '').toLowerCase();
        const hasRunningBefore = activeStatus === 'claimed' || activeStatus === 'running';
        if (replaceRunning && hasRunningBefore && activeBefore?.job_id) {
          const changed = requestChatJobStopStmt.run(ts, 'ios-new-message', ts, activeBefore.job_id);
          if (changed.changes === 1) {
            appendChatEvent({
              threadId,
              workspace: thread.workspace,
              jobId: activeBefore.job_id,
              turnId: activeBefore.turn_id || null,
              type: 'job.interrupt_requested',
              delta: 'Stop requested from iPhone.',
              payload: {
                requested_by: 'ios-new-message',
              },
              ts,
            });
          }
        }

        insertChatJobStmt.run(
          jobId,
          threadId,
          thread.workspace,
          inputText,
          normalizedItems.length ? JSON.stringify(normalizedItems) : null,
          JSON.stringify(policy),
          'queued',
          null,
          null,
          idempotencyKey,
          null,
          null,
          null,
          null,
          ts,
          ts,
        );

        updateThreadStatusStmt.run(hasRunningBefore ? 'running' : 'queued', ts, threadId);
        appendChatEvent({
          threadId,
          workspace: thread.workspace,
          jobId,
          turnId: null,
          type: 'user.message',
          delta: inputText,
          payload: {
            text: inputText,
            input_items: normalizedItems,
          },
          ts,
        });
        appendChatEvent({
          threadId,
          workspace: thread.workspace,
          jobId,
          turnId: null,
          type: 'job.queued',
          delta: null,
          payload: {
            status: 'queued',
            replace_running: !!replaceRunning,
          },
          ts,
        });

        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      const job = selectChatJobStmt.get(jobId);
      const updatedThread = selectChatThreadStmt.get(threadId);
      json(res, 200, {
        ok: true,
        thread: normalizeChatThread(updatedThread),
        job: normalizeChatJob(job),
        replace_running: !!replaceRunning,
        ts: nowIso(),
      });
      return;
    }

    const threadEventsMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)\/events$/);
    if (req.method === 'GET' && threadEventsMatch) {
      const threadId = decodeURIComponent(threadEventsMatch[1]);
      const afterSeq = clampInt(url.searchParams.get('after_seq'), 0, 10_000_000, 0);
      const limit = clampInt(url.searchParams.get('limit'), 1, 1000, 200);
      const tail = parseBoolQuery(url.searchParams.get('tail')) && afterSeq === 0;
      const rows = tail
        ? db.prepare(`
            SELECT * FROM chat_events
            WHERE thread_id = ?
            ORDER BY seq DESC
            LIMIT ?
          `).all(threadId, limit)
        : selectChatEventsStmt.all(threadId, afterSeq, limit);
      const normalizedRows = tail ? rows.slice().reverse() : rows;
      const events = normalizedRows.map(normalizeChatEvent);
      const lastSeq = events.length ? events[events.length - 1].seq : afterSeq;
      json(res, 200, { ok: true, thread_id: threadId, events, last_seq: lastSeq, ts: nowIso() });
      return;
    }

    const threadDetailMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)$/);
    if (req.method === 'GET' && threadDetailMatch) {
      const threadId = decodeURIComponent(threadDetailMatch[1]);
      const row = selectChatThreadStmt.get(threadId);
      if (!row) {
        json(res, 404, { ok: false, error: 'thread_not_found' });
        return;
      }
      const jobs = selectChatJobsByThreadStmt.all(threadId).map(normalizeChatJob);
      const userInputRequestRow = selectLatestPendingChatUserInputRequestByThreadStmt.get(threadId);
      json(res, 200, {
        ok: true,
        thread: normalizeChatThread(row),
        jobs,
        user_input_request: userInputRequestRow ? normalizeChatUserInputRequest(userInputRequestRow) : null,
        ts: nowIso(),
      });
      return;
    }

    const jobUserInputRequestMatch = url.pathname.match(/^\/codex-iphone-connector\/jobs\/([^/]+)\/user-input\/request$/);
    if (req.method === 'POST' && jobUserInputRequestMatch) {
      const jobId = decodeURIComponent(jobUserInputRequestMatch[1]);
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      const requestId = String(body.request_id || '').trim();
      if (!connectorId || !requestId) {
        badRequest(res, 'connector_id and request_id are required');
        return;
      }

      const job = selectChatJobStmt.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: 'job_not_found' });
        return;
      }
      if (job.connector_id && job.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'job_owned_by_other_connector' });
        return;
      }

      const normalizedQuestions = normalizeToolRequestUserInputQuestions(body.questions);
      if (!normalizedQuestions.length) {
        badRequest(res, 'questions is required');
        return;
      }

      const threadId = String(body.thread_id || job.thread_id || '').trim();
      if (!threadId || threadId !== job.thread_id) {
        badRequest(res, 'thread_id mismatch');
        return;
      }
      const turnId = body.turn_id == null ? (job.turn_id || null) : String(body.turn_id || '').trim() || null;
      const itemId = body.item_id == null ? null : String(body.item_id || '').trim().slice(0, 160) || null;

      const ts = nowIso();
      let row = selectChatUserInputRequestByJobStmt.get(requestId, jobId);
      if (!row) {
        db.exec('BEGIN');
        try {
          insertChatUserInputRequestStmt.run(
            requestId,
            jobId,
            threadId,
            job.workspace,
            connectorId,
            turnId,
            itemId,
            JSON.stringify(normalizedQuestions),
            ts,
            ts,
          );
          updateThreadStatusStmt.run('waiting_on_user_input', ts, threadId);
          appendChatEvent({
            threadId,
            workspace: job.workspace,
            jobId,
            turnId,
            type: 'job.waiting_on_user_input',
            delta: 'Waiting for user input on iPhone.',
            payload: {
              request_id: requestId,
              item_id: itemId,
              status: 'waiting_on_user_input',
            },
            ts,
          });
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
        row = selectChatUserInputRequestByJobStmt.get(requestId, jobId);
      }

      json(res, 200, { ok: true, request: normalizeChatUserInputRequest(row), ts: nowIso() });
      return;
    }

    const jobUserInputClaimMatch = url.pathname.match(/^\/codex-iphone-connector\/jobs\/([^/]+)\/user-input\/claim$/);
    if (req.method === 'POST' && jobUserInputClaimMatch) {
      const jobId = decodeURIComponent(jobUserInputClaimMatch[1]);
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      const requestId = String(body.request_id || '').trim();
      if (!connectorId || !requestId) {
        badRequest(res, 'connector_id and request_id are required');
        return;
      }

      const job = selectChatJobStmt.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: 'job_not_found' });
        return;
      }
      if (job.connector_id && job.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'job_owned_by_other_connector' });
        return;
      }

      let row = selectChatUserInputRequestByJobStmt.get(requestId, jobId);
      if (!row) {
        json(res, 200, { ok: true, request: null, ts: nowIso() });
        return;
      }
      if (row.connector_id && row.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'request_owned_by_other_connector' });
        return;
      }

      if (row.status === 'answered') {
        const ts = nowIso();
        db.exec('BEGIN');
        try {
          const changed = markChatUserInputRequestCompletedStmt.run(ts, ts, requestId, jobId, connectorId);
          if (changed.changes === 1) {
            updateThreadStatusStmt.run('running', ts, job.thread_id);
            row = selectChatUserInputRequestByJobStmt.get(requestId, jobId);
          }
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (row.status === 'pending') {
        json(res, 200, { ok: true, request: null, ts: nowIso() });
        return;
      }
      json(res, 200, { ok: true, request: normalizeChatUserInputRequest(row), ts: nowIso() });
      return;
    }

    const threadUserInputRespondMatch = url.pathname.match(/^\/codex-iphone-connector\/chat\/threads\/([^/]+)\/user-input\/respond$/);
    if (req.method === 'POST' && threadUserInputRespondMatch) {
      const threadId = decodeURIComponent(threadUserInputRespondMatch[1]);
      const body = await parseBody(req);
      const requestId = String(body.request_id || '').trim();
      if (!requestId) {
        badRequest(res, 'request_id is required');
        return;
      }

      const thread = selectChatThreadStmt.get(threadId);
      if (!thread) {
        json(res, 404, { ok: false, error: 'thread_not_found' });
        return;
      }

      let row = selectChatUserInputRequestStmt.get(requestId);
      if (!row) {
        json(res, 404, { ok: false, error: 'user_input_request_not_found' });
        return;
      }
      if (row.thread_id !== threadId) {
        json(res, 409, { ok: false, error: 'request_thread_mismatch' });
        return;
      }

      const questions = decodeJSON(row.questions_json, []);
      const allowedQuestionIds = Array.isArray(questions)
        ? questions
            .map((item) => String(item?.id || '').trim())
            .filter((value) => value.length > 0)
        : [];
      const normalizedAnswers = normalizeToolRequestUserInputAnswers(body.answers, allowedQuestionIds);
      if (!normalizedAnswers) {
        badRequest(res, 'answers is required');
        return;
      }

      if (row.status === 'pending') {
        const ts = nowIso();
        db.exec('BEGIN');
        try {
          const changed = markChatUserInputRequestAnsweredStmt.run(
            JSON.stringify(normalizedAnswers),
            ts,
            ts,
            requestId,
            threadId,
          );
          if (changed.changes !== 1) {
            throw new Error('request_not_pending');
          }
          updateThreadStatusStmt.run('running', ts, threadId);
          appendChatEvent({
            threadId,
            workspace: row.workspace,
            jobId: row.job_id,
            turnId: row.turn_id || null,
            type: 'user.input.responded',
            delta: 'Submitted user input from iPhone.',
            payload: {
              request_id: requestId,
              question_ids: Object.keys(normalizedAnswers),
            },
            ts,
          });
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
        row = selectChatUserInputRequestStmt.get(requestId);
      } else if (row.status === 'answered' || row.status === 'completed') {
        // idempotent return
      } else {
        json(res, 409, { ok: false, error: 'request_not_accepting_answers', status: row.status });
        return;
      }

      json(res, 200, { ok: true, request: normalizeChatUserInputRequest(row), ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/register') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const workspace = workspaceFrom(body.workspace);
      const ts = nowIso();
      upsertConnectorStmt.run(
        connectorId,
        workspace,
        body.status || 'online',
        body.version || null,
        body.capabilities ? JSON.stringify(body.capabilities) : null,
        body.last_error_code || null,
        body.last_error_message || null,
        ts,
        ts,
        ts,
      );
      const connector = selectConnectorStmt.get(connectorId);
      json(res, 200, { ok: true, connector: normalizeConnector(connector), poll_seconds: CONNECTOR_POLL_SECONDS, ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/heartbeat') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const workspace = workspaceFrom(body.workspace);
      const ts = nowIso();
      upsertConnectorStmt.run(
        connectorId,
        workspace,
        body.status || 'online',
        body.version || null,
        body.capabilities ? JSON.stringify(body.capabilities) : null,
        body.last_error_code || null,
        body.last_error_message || null,
        ts,
        ts,
        ts,
      );
      json(res, 200, { ok: true, ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/sessions/sync/request') {
      const body = await parseBody(req);
      const workspace = isAllWorkspaces(body.workspace) ? '*' : workspaceFrom(body.workspace);
      const requestId = randomId('sync_req');
      const ts = nowIso();
      const threadId = typeof body.thread_id === 'string' && body.thread_id ? body.thread_id : null;
      const requestedBy = typeof body.requested_by === 'string' && body.requested_by ? body.requested_by : 'ios';
      insertSessionSyncRequestStmt.run(requestId, workspace, threadId, requestedBy, ts);
      const row = selectSessionSyncRequestStmt.get(requestId);
      json(res, 200, { ok: true, request: normalizeSessionSyncRequest(row), ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/sessions/sync/claim') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const claimAll = isAllWorkspaces(body.workspace);
      const workspace = workspaceFrom(body.workspace);
      const ts = nowIso();

      let claimed = null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const pending = claimAll
          ? selectPendingAnySessionSyncStmt.get()
          : selectPendingSessionSyncForWorkspaceStmt.get(workspace);
        if (pending) {
          const result = claimSessionSyncRequestStmt.run(connectorId, ts, pending.request_id);
          if (result.changes === 1) {
            claimed = selectSessionSyncRequestStmt.get(pending.request_id);
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      json(res, 200, {
        ok: true,
        request: claimed ? normalizeSessionSyncRequest(claimed) : null,
        ts,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/sessions/sync/complete') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      const requestId = String(body.request_id || '').trim();
      if (!connectorId || !requestId) {
        badRequest(res, 'connector_id and request_id are required');
        return;
      }
      const status = String(body.status || 'completed').toLowerCase();
      if (!['completed', 'failed'].includes(status)) {
        badRequest(res, 'status must be completed or failed');
        return;
      }
      const error = status === 'failed' ? String(body.error || 'sync failed') : null;
      const ts = nowIso();
      const result = completeSessionSyncRequestStmt.run(status, ts, error, requestId, connectorId);
      if (result.changes !== 1) {
        json(res, 409, { ok: false, error: 'request_not_claimed_by_connector' });
        return;
      }
      const row = selectSessionSyncRequestStmt.get(requestId);
      const requestedBy = String(row?.requested_by || '').toLowerCase();
      const isDeleteRequest = requestedBy.startsWith('ios-delete-thread') || requestedBy.startsWith('mobile-delete-thread');
      if (isDeleteRequest && row?.thread_id) {
        updateThreadStatusStmt.run(status === 'completed' ? 'deleted' : 'idle', ts, row.thread_id);
      }
      json(res, 200, { ok: true, request: normalizeSessionSyncRequest(row), ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/sessions/sync') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      const knownThreadIds = Array.isArray(body.known_thread_ids)
        ? body.known_thread_ids
            .slice(0, 5000)
            .map((value) => String(value || '').trim())
            .filter((value) => value.length > 0)
        : [];
      const snapshotComplete = body.snapshot_complete !== false;
      const pruneMissing = body.prune_missing === true;
      const syncWorkspaceScope = isAllWorkspaces(body.workspace) ? '*' : workspaceFrom(body.workspace);
      const ts = nowIso();
      const importMessages = body.import_messages_if_empty !== false;
      let upserted = 0;
      let importedMessages = 0;
      let skipped = 0;
      let pruned = 0;

      db.exec('BEGIN');
      try {
        for (const raw of sessions.slice(0, 500)) {
          if (!raw || typeof raw !== 'object') {
            skipped += 1;
            continue;
          }
          const incomingThreadId = String(raw.thread_id || '').trim();
          if (!incomingThreadId) {
            skipped += 1;
            continue;
          }
          const workspace = workspaceFrom(raw.workspace || body.workspace);
          const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : '';
          const externalThreadId = raw.external_thread_id == null
            ? null
            : String(raw.external_thread_id || '').trim() || null;
          let threadId = incomingThreadId;
          let source = typeof raw.source === 'string' && raw.source ? raw.source : 'codex';
          if (externalThreadId) {
            source = 'codex';
            const existingByExternal = selectChatThreadByExternalPreferLocalStmt.get(externalThreadId);
            if (existingByExternal && existingByExternal.thread_id !== incomingThreadId) {
              threadId = existingByExternal.thread_id;
              const incomingRow = selectChatThreadStmt.get(incomingThreadId);
              if (incomingRow) {
                markThreadDeletedStmt.run(ts, incomingThreadId);
              }
            }
          }
          const rawStatus = String(raw.status || '').trim().toLowerCase();
          const status = ['idle', 'archived', 'queued', 'running', 'failed', 'interrupted', 'timeout', 'deleted'].includes(rawStatus)
            ? rawStatus
            : 'idle';
          const createdAt = normalizeTimestamp(raw.created_at, ts);
          const updatedAt = normalizeTimestamp(raw.updated_at, createdAt);

          upsertChatThread({
            threadId,
            workspace,
            title,
            externalThreadId,
            source,
            status,
            createdAt,
            updatedAt,
          });
          upserted += 1;

          if (importMessages) {
            importedMessages += importThreadMessagesIncremental({
              threadId,
              workspace,
              messages: raw.messages,
              ts,
            });
          }
        }

        if (pruneMissing && snapshotComplete) {
          const knownSet = new Set();
          for (const rawThreadId of knownThreadIds) {
            const normalizedThreadId = String(rawThreadId || '').trim();
            if (!normalizedThreadId) continue;
            knownSet.add(normalizedThreadId);
            if (!normalizedThreadId.startsWith('codex_')) continue;
            const externalThreadId = normalizedThreadId.slice('codex_'.length).trim();
            if (!externalThreadId) continue;
            const mapped = selectChatThreadByExternalPreferLocalStmt.get(externalThreadId);
            if (mapped?.thread_id) {
              knownSet.add(String(mapped.thread_id));
            }
          }
          if (knownThreadIds.length > 0) {
            const candidates = syncWorkspaceScope === '*'
              ? selectCodexThreadsAnyStmt.all()
              : selectCodexThreadsByWorkspaceStmt.all(syncWorkspaceScope);
            for (const row of candidates) {
              const threadId = String(row.thread_id || '');
              if (!threadId || knownSet.has(threadId)) continue;
              const changed = markThreadDeletedStmt.run(ts, threadId);
              if (changed.changes > 0) pruned += 1;
            }
          }

          const placeholders = syncWorkspaceScope === '*'
            ? selectIdleIosPlaceholderThreadsAnyStmt.all()
            : selectIdleIosPlaceholderThreadsByWorkspaceStmt.all(syncWorkspaceScope);
          const pruneBeforeMs = Date.now() - IOS_PLACEHOLDER_PRUNE_MINUTES * 60_000;
          for (const row of placeholders) {
            const threadId = String(row.thread_id || '');
            if (!threadId || knownSet.has(threadId)) continue;
            const updatedMs = Date.parse(String(row.updated_at || ''));
            if (Number.isFinite(updatedMs) && updatedMs >= pruneBeforeMs) continue;
            const eventCount = Number(countChatEventsByThreadStmt.get(threadId)?.count || 0);
            const jobCount = Number(countChatJobsByThreadStmt.get(threadId)?.count || 0);
            if (eventCount > 0 || jobCount > 0) continue;
            const changed = markThreadDeletedStmt.run(ts, threadId);
            if (changed.changes > 0) pruned += 1;
          }
        }

        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      json(res, 200, {
        ok: true,
        connector_id: connectorId,
        upserted,
        imported_messages: importedMessages,
        skipped,
        pruned,
        snapshot_complete: snapshotComplete,
        prune_applied: pruneMissing && snapshotComplete,
        known_count: knownThreadIds.length,
        ts,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/auth/relogin/request') {
      const body = await parseBody(req);
      const workspace = isAllWorkspaces(body.workspace) ? '*' : workspaceFrom(body.workspace);
      const requestedBy = String(body.requested_by || 'ios-user').slice(0, 120);
      const requestId = randomId('auth_relogin');
      const ts = nowIso();
      insertAuthReloginRequestStmt.run(requestId, workspace, requestedBy, ts, ts);
      const row = selectAuthReloginRequestStmt.get(requestId);
      json(res, 200, { ok: true, request: normalizeAuthReloginRequest(row), ts });
      return;
    }

    const authReloginRequestMatch = url.pathname.match(/^\/codex-iphone-connector\/auth\/relogin\/request\/([^/]+)$/);
    if (req.method === 'GET' && authReloginRequestMatch) {
      const requestId = decodeURIComponent(authReloginRequestMatch[1]);
      const row = selectAuthReloginRequestStmt.get(requestId);
      if (!row) {
        json(res, 404, { ok: false, error: 'request_not_found' });
        return;
      }
      json(res, 200, { ok: true, request: normalizeAuthReloginRequest(row), ts: nowIso() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/auth/relogin/claim') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const claimAll = isAllWorkspaces(body.workspace);
      const workspace = workspaceFrom(body.workspace);
      const ts = nowIso();
      let claimed = null;

      db.exec('BEGIN');
      try {
        const pending = claimAll
          ? selectPendingAnyAuthReloginStmt.get()
          : selectPendingAuthReloginForWorkspaceStmt.get(workspace);
        if (pending) {
          const result = claimAuthReloginRequestStmt.run(connectorId, ts, ts, pending.request_id);
          if (result.changes === 1) {
            claimed = selectAuthReloginRequestStmt.get(pending.request_id);
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      json(res, 200, {
        ok: true,
        request: claimed ? normalizeAuthReloginRequest(claimed) : null,
        ts,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/auth/relogin/progress') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      const requestId = String(body.request_id || '').trim();
      if (!connectorId || !requestId) {
        badRequest(res, 'connector_id and request_id are required');
        return;
      }
      const nextStatus = String(body.status || '').trim().toLowerCase();
      if (!['claimed', 'awaiting_user', 'running'].includes(nextStatus)) {
        badRequest(res, 'status must be claimed, awaiting_user, or running');
        return;
      }
      const current = selectAuthReloginRequestStmt.get(requestId);
      if (!current) {
        json(res, 404, { ok: false, error: 'request_not_found' });
        return;
      }
      if (current.connector_id && current.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'request_owned_by_other_connector' });
        return;
      }

      const authUrl = body.auth_url == null ? current.auth_url : String(body.auth_url || '').slice(0, 1000);
      const userCode = body.user_code == null ? current.user_code : String(body.user_code || '').slice(0, 100);
      const verificationUriComplete = body.verification_uri_complete == null
        ? current.verification_uri_complete
        : String(body.verification_uri_complete || '').slice(0, 1000);
      const expiresAt = body.expires_at == null ? current.expires_at : normalizeTimestamp(body.expires_at, null);
      const message = body.message == null ? current.message : String(body.message || '').slice(0, 500);
      const error = body.error == null ? current.error : String(body.error || '').slice(0, 500);
      const ts = nowIso();
      const result = updateAuthReloginRequestProgressStmt.run(
        nextStatus,
        authUrl,
        userCode,
        verificationUriComplete,
        expiresAt,
        message,
        error,
        ts,
        requestId,
        connectorId,
      );
      if (result.changes !== 1) {
        json(res, 409, { ok: false, error: 'request_not_claimed_by_connector' });
        return;
      }
      const updated = selectAuthReloginRequestStmt.get(requestId);
      json(res, 200, { ok: true, request: normalizeAuthReloginRequest(updated), ts });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/auth/relogin/complete') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      const requestId = String(body.request_id || '').trim();
      if (!connectorId || !requestId) {
        badRequest(res, 'connector_id and request_id are required');
        return;
      }
      const status = String(body.status || '').trim().toLowerCase();
      if (!['completed', 'failed'].includes(status)) {
        badRequest(res, 'status must be completed or failed');
        return;
      }
      const message = body.message == null ? null : String(body.message || '').slice(0, 500);
      const error = status === 'failed'
        ? String(body.error || 'relogin_failed').slice(0, 500)
        : (body.error == null ? null : String(body.error || '').slice(0, 500));
      const ts = nowIso();
      const result = completeAuthReloginRequestStmt.run(status, message, error, ts, ts, requestId, connectorId);
      if (result.changes !== 1) {
        json(res, 409, { ok: false, error: 'request_not_claimed_by_connector' });
        return;
      }
      const row = selectAuthReloginRequestStmt.get(requestId);
      json(res, 200, { ok: true, request: normalizeAuthReloginRequest(row), ts });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/codex-iphone-connector/status') {
      const workspaceParam = url.searchParams.get('workspace');
      const includeAll = isAllWorkspaces(workspaceParam);
      const workspace = workspaceFrom(workspaceParam);
      const status = unifiedStatusForScope(workspace, includeAll);
      json(res, 200, {
        ok: true,
        workspace: includeAll ? '*' : workspace,
        status,
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/codex-iphone-connector/workspaces') {
      const workspaces = collectKnownWorkspaces();
      json(res, 200, { ok: true, workspaces, ts: nowIso() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/codex-iphone-connector/usage/summary') {
      const workspaceParam = url.searchParams.get('workspace');
      const includeAll = isAllWorkspaces(workspaceParam);
      const workspace = workspaceFrom(workspaceParam);

      const jobRows = includeAll
        ? db.prepare(`
            SELECT status, COUNT(*) AS count
            FROM chat_jobs
            GROUP BY status
          `).all()
        : db.prepare(`
            SELECT status, COUNT(*) AS count
            FROM chat_jobs
            WHERE workspace = ?
            GROUP BY status
          `).all(workspace);

      const threadCount = includeAll
        ? Number(db.prepare(`SELECT COUNT(*) AS count FROM chat_threads`).get().count || 0)
        : Number(db.prepare(`SELECT COUNT(*) AS count FROM chat_threads WHERE workspace = ?`).get(workspace).count || 0);

      const tokenRows = includeAll
        ? db.prepare(`
            SELECT thread_id, payload_json, ts
            FROM chat_events
            WHERE type = 'rpc.thread.tokenUsage.updated'
            ORDER BY id DESC
            LIMIT 6000
          `).all()
        : db.prepare(`
            SELECT thread_id, payload_json, ts
            FROM chat_events
            WHERE workspace = ? AND type = 'rpc.thread.tokenUsage.updated'
            ORDER BY id DESC
            LIMIT 6000
          `).all(workspace);

      const rateLimitRows = includeAll
        ? db.prepare(`
            SELECT payload_json, ts
            FROM chat_events
            WHERE type LIKE '%token_count%' OR type LIKE '%rate_limit%' OR type = 'rpc.event_msg'
            ORDER BY id DESC
            LIMIT 1500
          `).all()
        : db.prepare(`
            SELECT payload_json, ts
            FROM chat_events
            WHERE workspace = ? AND (type LIKE '%token_count%' OR type LIKE '%rate_limit%' OR type = 'rpc.event_msg')
            ORDER BY id DESC
            LIMIT 1500
          `).all(workspace);

      const seenThreads = new Set();
      let latestUsageUpdatedAt = null;
      const usageTotals = {
        total_tokens: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        model_context_window_max: 0,
        threads_with_usage: 0,
      };

      for (const row of tokenRows) {
        if (seenThreads.has(row.thread_id)) continue;
        seenThreads.add(row.thread_id);
        const payload = decodeJSON(row.payload_json, null);
        const usage = usageFromTokenUsagePayload(payload);
        if (!usage) continue;
        usageTotals.total_tokens += usage.total_tokens;
        usageTotals.input_tokens += usage.input_tokens;
        usageTotals.cached_input_tokens += usage.cached_input_tokens;
        usageTotals.output_tokens += usage.output_tokens;
        usageTotals.reasoning_output_tokens += usage.reasoning_output_tokens;
        usageTotals.model_context_window_max = Math.max(
          usageTotals.model_context_window_max,
          usage.model_context_window,
        );
        usageTotals.threads_with_usage += 1;
        if (!latestUsageUpdatedAt || row.ts > latestUsageUpdatedAt) latestUsageUpdatedAt = row.ts;
      }

      const windowsByMinutes = new Map();
      for (const row of rateLimitRows) {
        const payload = decodeJSON(row.payload_json, null);
        const windows = rateLimitWindowsFromPayload(payload, row.ts);
        if (!windows.length) continue;
        for (const window of windows) {
          const key = String(window.window_minutes || '');
          if (!key) continue;
          if (!windowsByMinutes.has(key)) {
            windowsByMinutes.set(key, window);
          }
        }
        if (windowsByMinutes.has('300') && windowsByMinutes.has('10080')) {
          break;
        }
      }
      let rateLimitWindows = Array.from(windowsByMinutes.values());
      let rateLimitsSource = rateLimitWindows.length ? 'token_count' : null;
      let fallbackMaxTotalTokens = null;
      if (!rateLimitWindows.length) {
        const fallback = rateLimitFallbackFromRolloutFiles(workspace, includeAll);
        if (fallback.windows.length) {
          rateLimitWindows = fallback.windows;
          rateLimitsSource = 'session_jsonl.token_count';
          fallbackMaxTotalTokens = fallback.maxTotalTokens;
          if (fallback.latestUpdatedAt && (!latestUsageUpdatedAt || fallback.latestUpdatedAt > latestUsageUpdatedAt)) {
            latestUsageUpdatedAt = fallback.latestUpdatedAt;
          }
        }
      }
      const fiveHourRateLimit = pickNearestWindow(rateLimitWindows, 300);
      const weeklyRateLimit = pickNearestWindow(rateLimitWindows, 10080);
      const usageRateLimits = fiveHourRateLimit || weeklyRateLimit
        ? {
            five_hour: fiveHourRateLimit || null,
            weekly: weeklyRateLimit || null,
          }
        : null;
      if (usageRateLimits) {
        const rateLimitUpdatedAt = [
          fiveHourRateLimit?.updated_at || null,
          weeklyRateLimit?.updated_at || null,
        ]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .sort()
          .pop();
        if (rateLimitUpdatedAt && (!latestUsageUpdatedAt || rateLimitUpdatedAt > latestUsageUpdatedAt)) {
          latestUsageUpdatedAt = rateLimitUpdatedAt;
        }
      }

      let totalTokensSource = usageTotals.threads_with_usage > 0 ? 'token_usage' : null;
      const totalCandidates = rateLimitWindows
        .map((window) => nonNegativeIntOrNull(window.used_tokens))
        .filter((value) => value != null);
      if (fallbackMaxTotalTokens != null) {
        totalCandidates.push(fallbackMaxTotalTokens);
      }
      if (totalCandidates.length) {
        usageTotals.total_tokens = Math.max(...totalCandidates);
        totalTokensSource = 'rate_limits';
      }

      const jobs = {
        queued: 0,
        claimed: 0,
        running: 0,
        completed: 0,
        failed: 0,
      };
      for (const row of jobRows) {
        const status = String(row.status || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(jobs, status)) {
          jobs[status] = Number(row.count || 0);
        }
      }

      json(res, 200, {
        ok: true,
        workspace: includeAll ? '*' : workspace,
        threads_count: threadCount,
        jobs,
        usage: usageTotals,
        total_tokens_source: totalTokensSource,
        rate_limits: usageRateLimits,
        rate_limits_source: usageRateLimits ? rateLimitsSource : null,
        rate_limits_windows_found: rateLimitWindows.length,
        usage_updated_at: latestUsageUpdatedAt,
        ts: nowIso(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/jobs/claim') {
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const claimAll = isAllWorkspaces(body.workspace);
      const workspace = workspaceFrom(body.workspace);
      const ts = nowIso();

      let claimed = null;
      db.exec('BEGIN IMMEDIATE');
      try {
        const queued = claimAll ? selectQueuedAnyChatJobStmt.get() : selectQueuedChatJobStmt.get(workspace);
        if (queued) {
          const result = claimChatJobStmt.run(connectorId, ts, queued.job_id);
          if (result.changes === 1) claimed = selectChatJobStmt.get(queued.job_id);
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      if (!claimed) {
        json(res, 200, { ok: true, job: null, ts });
        return;
      }
      updateThreadStatusStmt.run('claimed', ts, claimed.thread_id);
      appendChatEvent({
        threadId: claimed.thread_id,
        workspace: claimed.workspace,
        jobId: claimed.job_id,
        turnId: null,
        type: 'job.claimed',
        delta: null,
        payload: { connector_id: connectorId },
        ts,
      });
      claimed = selectChatJobStmt.get(claimed.job_id);
      const thread = selectChatThreadStmt.get(claimed.thread_id);
      json(res, 200, { ok: true, job: normalizeChatJob(claimed), thread: normalizeChatThread(thread), ts });
      return;
    }

    const connectorControlMatch = url.pathname.match(/^\/codex-iphone-connector\/jobs\/([^/]+)\/control$/);
    if (req.method === 'GET' && connectorControlMatch) {
      const jobId = decodeURIComponent(connectorControlMatch[1]);
      const connectorId = String(url.searchParams.get('connector_id') || '').trim();
      const job = selectChatJobStmt.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: 'job_not_found' });
        return;
      }
      if (connectorId && job.connector_id && job.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'job_owned_by_other_connector' });
        return;
      }
      json(res, 200, {
        ok: true,
        job_id: job.job_id,
        status: job.status,
        stop_requested: !!job.stop_requested_at,
        stop_requested_at: job.stop_requested_at || null,
        stop_requested_by: job.stop_requested_by || null,
        ts: nowIso(),
      });
      return;
    }

    const connectorEventsMatch = url.pathname.match(/^\/codex-iphone-connector\/jobs\/([^/]+)\/events$/);
    if (req.method === 'POST' && connectorEventsMatch) {
      const jobId = decodeURIComponent(connectorEventsMatch[1]);
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const job = selectChatJobStmt.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: 'job_not_found' });
        return;
      }
      if (job.connector_id && job.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'job_owned_by_other_connector' });
        return;
      }
      if (['completed', 'failed', 'interrupted', 'timeout'].includes(String(job.status || '').toLowerCase())) {
        json(res, 409, { ok: false, error: 'job_already_finished' });
        return;
      }

      const events = Array.isArray(body.events) ? body.events : [];
      const ts = nowIso();
      const wasRunning = String(job.status || '').toLowerCase() === 'running';
      markChatJobRunningStmt.run(ts, jobId);
      if (body.turn_id) updateChatJobTurnStmt.run(String(body.turn_id), ts, jobId);
      if (body.external_thread_id) updateThreadExternalIdStmt.run(String(body.external_thread_id), ts, job.thread_id);

      let inserted = 0;
      let lastSeq = null;
      db.exec('BEGIN');
      try {
        if (!wasRunning) {
          const seq = appendChatEvent({
            threadId: job.thread_id,
            workspace: job.workspace,
            jobId,
            turnId: body.turn_id || job.turn_id || null,
            type: 'job.running',
            delta: null,
            payload: { status: 'running' },
            ts,
          });
          inserted += 1;
          lastSeq = seq;
        }
        for (const e of events) {
          const eventType = String(e.type || '').trim();
          if (!eventType) continue;
          const seq = appendChatEvent({
            threadId: job.thread_id,
            workspace: job.workspace,
            jobId,
            turnId: e.turn_id || body.turn_id || job.turn_id || null,
            type: eventType,
            delta: e.delta ?? null,
            payload: e.payload ?? null,
            ts: e.ts || ts,
          });
          inserted += 1;
          lastSeq = seq;
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
      touchChatJobStmt.run(ts, jobId);
      updateThreadStatusStmt.run('running', ts, job.thread_id);
      json(res, 200, { ok: true, inserted, last_seq: lastSeq, ts });
      return;
    }

    const connectorCompleteMatch = url.pathname.match(/^\/codex-iphone-connector\/jobs\/([^/]+)\/complete$/);
    if (req.method === 'POST' && connectorCompleteMatch) {
      const jobId = decodeURIComponent(connectorCompleteMatch[1]);
      const body = await parseBody(req);
      const connectorId = String(body.connector_id || '').trim();
      if (!connectorId) {
        badRequest(res, 'connector_id is required');
        return;
      }
      const finalStatus = String(body.status || '').toLowerCase();
      if (!['completed', 'failed', 'interrupted', 'timeout'].includes(finalStatus)) {
        badRequest(res, 'status must be completed, failed, interrupted, or timeout');
        return;
      }
      const job = selectChatJobStmt.get(jobId);
      if (!job) {
        json(res, 404, { ok: false, error: 'job_not_found' });
        return;
      }
      if (job.connector_id && job.connector_id !== connectorId) {
        json(res, 409, { ok: false, error: 'job_owned_by_other_connector' });
        return;
      }
      const currentStatus = String(job.status || '').toLowerCase();
      if (['completed', 'failed', 'interrupted', 'timeout'].includes(currentStatus)) {
        if (currentStatus === finalStatus) {
          const thread = selectChatThreadStmt.get(job.thread_id);
          json(res, 200, {
            ok: true,
            job: normalizeChatJob(job),
            thread: normalizeChatThread(thread),
            ts: nowIso(),
          });
          return;
        }
        json(res, 409, { ok: false, error: 'job_already_finished', status: currentStatus });
        return;
      }

      const ts = nowIso();
      const turnId = body.turn_id || job.turn_id || null;
      if (body.external_thread_id) updateThreadExternalIdStmt.run(String(body.external_thread_id), ts, job.thread_id);

      if (finalStatus === 'completed') {
        completeChatJobStmt.run(turnId, ts, jobId);
        updateThreadStatusStmt.run('idle', ts, job.thread_id);
        appendChatEvent({
          threadId: job.thread_id,
          workspace: job.workspace,
          jobId,
          turnId,
          type: 'job.completed',
          delta: null,
          payload: { status: 'completed' },
          ts,
        });
      } else if (finalStatus === 'interrupted') {
        const errorCode = body.error_code || 'TURN_INTERRUPTED';
        const errorMessage = body.error_message || 'turn interrupted';
        interruptChatJobStmt.run(turnId, errorCode, errorMessage, ts, jobId);
        updateThreadStatusStmt.run('interrupted', ts, job.thread_id);
        appendChatEvent({
          threadId: job.thread_id,
          workspace: job.workspace,
          jobId,
          turnId,
          type: 'job.interrupted',
          delta: errorMessage,
          payload: { error_code: errorCode, error_message: errorMessage },
          ts,
        });
      } else if (finalStatus === 'timeout') {
        const errorCode = body.error_code || 'TURN_TIMEOUT';
        const errorMessage = body.error_message || 'turn timed out';
        timeoutChatJobStmt.run(turnId, errorCode, errorMessage, ts, jobId);
        updateThreadStatusStmt.run('failed', ts, job.thread_id);
        appendChatEvent({
          threadId: job.thread_id,
          workspace: job.workspace,
          jobId,
          turnId,
          type: 'job.timeout',
          delta: errorMessage,
          payload: { error_code: errorCode, error_message: errorMessage },
          ts,
        });
      } else {
        const errorCode = body.error_code || 'JOB_FAILED';
        const errorMessage = body.error_message || 'job failed';
        failChatJobStmt.run(turnId, errorCode, errorMessage, ts, jobId);
        updateThreadStatusStmt.run('failed', ts, job.thread_id);
        appendChatEvent({
          threadId: job.thread_id,
          workspace: job.workspace,
          jobId,
          turnId,
          type: 'job.failed',
          delta: errorMessage,
          payload: { error_code: errorCode, error_message: errorMessage },
          ts,
        });
      }
      const updated = selectChatJobStmt.get(jobId);
      const thread = selectChatThreadStmt.get(job.thread_id);
      json(res, 200, {
        ok: true,
        job: normalizeChatJob(updated),
        thread: normalizeChatThread(thread),
        ts,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/codex-iphone-connector/sessions/backfill/start') {
      const body = await parseBody(req);
      const workspace = isAllWorkspaces(body.workspace) ? '*' : workspaceFrom(body.workspace);
      const maxFiles = clampInt(body.limit_files, 1, 20_000, 2_000);
      const runId = randomId('backfill');
      const startedAt = nowIso();

      insertBackfillRunStmt.run(runId, workspace, 'running', 0, 0, startedAt, null, null);
      try {
        const result = runBackfill(workspace, maxFiles);
        completeBackfillRunStmt.run('completed', result.scanned, result.imported, nowIso(), null, runId);
      } catch (err) {
        completeBackfillRunStmt.run('failed', 0, 0, nowIso(), String(err.message || err), runId);
      }

      const run = selectBackfillRunStmt.get(runId);
      json(res, 200, { ok: true, run: normalizeBackfillRun(run), ts: nowIso() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/codex-iphone-connector/sessions/backfill/status') {
      const workspace = isAllWorkspaces(url.searchParams.get('workspace'))
        ? '*'
        : workspaceFrom(url.searchParams.get('workspace'));
      const runId = url.searchParams.get('run_id');
      if (runId) {
        const row = selectBackfillRunStmt.get(runId);
        if (!row) {
          json(res, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        json(res, 200, { ok: true, run: normalizeBackfillRun(row), ts: nowIso() });
        return;
      }
      const limit = clampInt(url.searchParams.get('limit'), 1, 200, 20);
      const runs = selectBackfillRunsStmt.all(workspace, limit).map(normalizeBackfillRun);
      json(res, 200, { ok: true, runs, ts: nowIso() });
      return;
    }

    json(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    if (String(err?.message || '').toLowerCase().includes('payload too large')) {
      json(res, 413, { ok: false, error: 'payload_too_large' });
      return;
    }
    json(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
  console.log(`[relay] sqlite db: ${DB_PATH}`);
  console.log(`[relay] codex home: ${CODEX_HOME}`);
});
