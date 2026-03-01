#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_FILE = path.join(ROOT, 'config', '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

const fileEnv = loadEnvFile(ENV_FILE);
for (const [k, v] of Object.entries(fileEnv)) {
  if (!process.env[k]) process.env[k] = v;
}

const CONFIG = {
  sourceDb: process.env.SOURCE_RELAY_DB || path.join(ROOT, 'relay', 'data', 'relay.db'),
  codexcpBaseUrl: String(process.env.CODEXCP_BASE_URL || 'https://relay.example.com/codexcp-relay').replace(/\/$/, ''),
  token: process.env.CODEXCP_TOKEN || process.env.RELAY_TOKEN || '',
  targetWorkspace: process.env.CODEXCP_WORKSPACE || 'default',
  groupBy: String(process.env.CODEXCP_GROUP_BY || 'workspace').trim().toLowerCase(),
  stateFile: process.env.CODEXCP_THREAD_STATE_FILE || path.join(ROOT, 'state', 'codexcp_thread_dispatcher_state.json'),
  pollSeconds: Math.max(3, Number(process.env.CODEXCP_POLL_SECONDS || 8)),
  backfillLimit: Math.max(1, Number(process.env.CODEXCP_BACKFILL_LIMIT || 200)),
  userEventBatchLimit: Math.max(1, Number(process.env.CODEXCP_USER_EVENT_BATCH_LIMIT || 120)),
};

const ACTIVE_MASTER_STATUSES = new Set(['queued', 'claimed', 'running', 'waiting_approval']);
const TRACKING_ENABLED_STATUSES = new Set(['queued', 'claimed', 'running']);

function nowIso() {
  return new Date().toISOString();
}

function logLine(msg) {
  process.stdout.write(`[codexcp-thread-dispatcher] ${msg}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`[codexcp-thread-dispatcher] ERROR: ${message}\n`);
  process.exit(code);
}

function ensureInputs() {
  if (!fs.existsSync(CONFIG.sourceDb)) {
    fail(`source relay db not found: ${CONFIG.sourceDb}`);
  }
  if (!CONFIG.token) {
    fail('missing CODEXCP_TOKEN / RELAY_TOKEN');
  }
  fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSqlRaw(dbPath, sql) {
  const proc = spawnSync('sqlite3', ['-readonly', '-separator', '\t', dbPath, sql], { encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || 'sqlite3 failed').trim());
  }
  return proc.stdout || '';
}

function loadSourceThreads(limit) {
  const sql = `
SELECT thread_id, workspace, title, status, updated_at, created_at
FROM chat_threads
WHERE source = 'codex'
  AND status NOT IN ('deleted', 'archived', 'deleting')
ORDER BY updated_at DESC
LIMIT ${Number(limit)};
`;
  const raw = runSqlRaw(CONFIG.sourceDb, sql);
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [thread_id, workspace, title, status, updated_at, created_at] = line.split('\t');
    rows.push({
      thread_id: thread_id || '',
      workspace: workspace || '',
      title: title || '',
      status: status || 'idle',
      updated_at: updated_at || nowIso(),
      created_at: created_at || nowIso(),
    });
  }
  return rows;
}

function maxUserSeqByThread(threadId) {
  const sql = `
SELECT COALESCE(MAX(seq), 0)
FROM chat_events
WHERE thread_id = ${quoteSql(threadId)}
  AND type = 'user.message';
`;
  const out = runSqlRaw(CONFIG.sourceDb, sql).trim();
  return Number(out || 0) || 0;
}

function loadNewUserEvents(threadId, afterSeq, limit) {
  const sql = `
SELECT seq, delta, payload_json, ts
FROM chat_events
WHERE thread_id = ${quoteSql(threadId)}
  AND type = 'user.message'
  AND seq > ${Number(afterSeq)}
ORDER BY seq ASC
LIMIT ${Number(limit)};
`;
  const raw = runSqlRaw(CONFIG.sourceDb, sql);
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [seq, delta, payload_json, ts] = line.split('\t');
    rows.push({
      seq: Number(seq || 0) || 0,
      delta: delta || '',
      payload_json: payload_json || '',
      ts: ts || nowIso(),
    });
  }
  return rows;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function userMessageText(eventRow) {
  const direct = String(eventRow.delta || '').trim();
  if (direct) return direct;
  const payload = parseJson(eventRow.payload_json);
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.text,
    payload.message,
    payload?.params?.text,
    payload?.params?.message,
  ];
  for (const c of candidates) {
    const t = String(c || '').trim();
    if (t) return t;
  }
  return '';
}

async function requestJson(method, endpoint, body = null) {
  const url = `${CONFIG.codexcpBaseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? parseJson(text) : {};
  if (!res.ok || !data || data.ok === false) {
    throw new Error(`${method} ${endpoint} failed (${res.status}): ${text}`);
  }
  return data;
}

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) {
    return {
      version: 1,
      updated_at: nowIso(),
      source_db: CONFIG.sourceDb,
      codexcp_base_url: CONFIG.codexcpBaseUrl,
      target_workspace: CONFIG.targetWorkspace,
      group_by: CONFIG.groupBy,
      thread_map: {},
    };
  }
  const raw = fs.readFileSync(CONFIG.stateFile, 'utf8');
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`invalid state file json: ${CONFIG.stateFile}`);
  }
  if (!parsed.thread_map || typeof parsed.thread_map !== 'object') {
    parsed.thread_map = {};
  }
  return parsed;
}

function saveState(state) {
  state.version = 1;
  state.updated_at = nowIso();
  state.source_db = CONFIG.sourceDb;
  state.codexcp_base_url = CONFIG.codexcpBaseUrl;
  state.target_workspace = CONFIG.targetWorkspace;
  state.group_by = CONFIG.groupBy;
  fs.writeFileSync(CONFIG.stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function truncateText(text, n) {
  const t = String(text || '').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function normalizeGroupBy(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'workspace') return 'workspace';
  return 'workspace';
}

function resolveGroupNameFromWorkspace(workspace) {
  const t = String(workspace || '').trim();
  return t || 'misc';
}

function buildGroupMeta({ sourceWorkspace }) {
  const groupDimension = normalizeGroupBy(CONFIG.groupBy);
  const groupName = resolveGroupNameFromWorkspace(sourceWorkspace);
  return {
    groupDimension,
    groupKey: `${groupDimension}:${groupName}`,
  };
}

async function createMasterTask(thread) {
  const titleCore = truncateText(thread.title || thread.thread_id, 72) || thread.thread_id;
  const groupMeta = buildGroupMeta({ sourceWorkspace: thread.workspace });
  const body = {
    workspace: CONFIG.targetWorkspace,
    title: `MASTER ${titleCore}`,
    objective: [
      `ThreadID: ${thread.thread_id}`,
      `SourceWorkspace: ${thread.workspace || '-'}`,
      `EntityType: MASTER`,
      `GroupDimension: ${groupMeta.groupDimension}`,
      `GroupKey: ${groupMeta.groupKey}`,
      `ThreadTitle: ${thread.title || '-'}`,
      'Mode: master task for iPhone thread tracking + dispatch',
      'When resumed to queued/running, dispatcher will auto-create child tasks from new user.message events.',
    ].join('\n'),
    priority: 'P1',
    approval_mode: 'AUTO',
    created_by: 'thread-backfill',
  };
  const created = await requestJson('POST', '/v2/supervisor/tasks', body);
  return created.task;
}

async function pauseMasterTask(masterTaskId, reason) {
  const body = {
    status: 'waiting_approval',
    runner_id: 'thread-dispatcher',
    profile_id: 'system',
    reason: reason || 'initialized_paused_until_enabled',
  };
  try {
    await requestJson('POST', `/v2/supervisor/tasks/${encodeURIComponent(masterTaskId)}/update`, body);
  } catch (err) {
    logLine(`warn: pause master failed task=${masterTaskId} error=${String(err.message || err)}`);
  }
}

async function fetchSupervisorTasksByWorkspace(limit = 300) {
  const data = await requestJson(
    'GET',
    `/v2/supervisor/tasks?workspace=${encodeURIComponent(CONFIG.targetWorkspace)}&limit=${Math.min(300, Math.max(1, limit))}`,
  );
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const byId = new Map();
  for (const t of tasks) byId.set(String(t.id), t);
  return { tasks, byId };
}

async function backfillMasterTasks(state, opts = {}) {
  const limit = Number(opts.limit || CONFIG.backfillLimit);
  const threads = loadSourceThreads(limit);
  let created = 0;
  let linked = 0;

  for (const thread of threads) {
    if (!thread.thread_id) continue;
    const existing = state.thread_map[thread.thread_id];
    if (existing?.master_task_id) {
      existing.thread_title = thread.title || existing.thread_title || '';
      existing.source_workspace = thread.workspace || existing.source_workspace || '';
      existing.updated_at = nowIso();
      continue;
    }

    const master = await createMasterTask(thread);
    created += 1;
    const maxSeq = maxUserSeqByThread(thread.thread_id);
    state.thread_map[thread.thread_id] = {
      thread_id: thread.thread_id,
      thread_title: thread.title || '',
      source_workspace: thread.workspace || '',
      master_task_id: master.id,
      last_user_event_seq: maxSeq,
      created_at: nowIso(),
      updated_at: nowIso(),
      note: 'master task created from thread backfill',
    };
    linked += 1;
    await pauseMasterTask(master.id, 'initialized_paused_until_enabled');
    logLine(`backfilled thread=${thread.thread_id} -> master=${master.id} (last_user_seq=${maxSeq})`);
  }

  saveState(state);
  return { threads: threads.length, created, linked };
}

function isStatusActiveForDispatch(status) {
  return TRACKING_ENABLED_STATUSES.has(String(status || '').trim().toLowerCase());
}

async function createChildTask({ masterTask, mapping, userEvent }) {
  const groupMeta = buildGroupMeta({ sourceWorkspace: mapping.source_workspace });
  const text = userMessageText(userEvent);
  const title = truncateText(
    `SUB ${mapping.thread_id.slice(0, 14)} #${userEvent.seq} ${text || 'user-message'}`,
    80,
  );
  const objective = [
    `ParentMasterTask: ${masterTask.id}`,
    `ThreadID: ${mapping.thread_id}`,
    `SourceWorkspace: ${mapping.source_workspace || '-'}`,
    `EntityType: SUB`,
    `GroupDimension: ${groupMeta.groupDimension}`,
    `GroupKey: ${groupMeta.groupKey}`,
    `EventSeq: ${userEvent.seq}`,
    `EventTs: ${userEvent.ts || '-'}`,
    'UserMessage:',
    text || '(empty)',
    'Action: execute this delta and report result to supervisor.',
  ].join('\n');
  const body = {
    workspace: CONFIG.targetWorkspace,
    title: title || `SUB ${mapping.thread_id} #${userEvent.seq}`,
    objective,
    priority: String(masterTask.priority || 'P2'),
    approval_mode: String(masterTask.approval_mode || 'AUTO'),
    created_by: 'thread-dispatcher',
  };
  return requestJson('POST', '/v2/supervisor/tasks', body);
}

async function trackAndDispatchOnce(state) {
  const { byId } = await fetchSupervisorTasksByWorkspace(300);
  let dispatched = 0;
  let activeMasters = 0;

  for (const [threadId, mapping] of Object.entries(state.thread_map || {})) {
    const masterTaskId = String(mapping.master_task_id || '');
    if (!masterTaskId) continue;
    const master = byId.get(masterTaskId);
    if (!master) {
      logLine(`warn: master missing in codexcp task=${masterTaskId} thread=${threadId}`);
      continue;
    }
    const masterStatus = String(master.status || '').toLowerCase();
    mapping.master_status = masterStatus;
    mapping.updated_at = nowIso();

    if (!ACTIVE_MASTER_STATUSES.has(masterStatus)) {
      continue;
    }
    activeMasters += 1;
    if (!isStatusActiveForDispatch(masterStatus)) {
      continue;
    }

    const afterSeq = Number(mapping.last_user_event_seq || 0);
    const events = loadNewUserEvents(threadId, afterSeq, CONFIG.userEventBatchLimit);
    if (!events.length) continue;

    for (const event of events) {
      await createChildTask({ masterTask: master, mapping, userEvent: event });
      mapping.last_user_event_seq = Number(event.seq || mapping.last_user_event_seq || 0);
      mapping.updated_at = nowIso();
      dispatched += 1;
      logLine(
        `dispatched child from thread=${threadId} seq=${event.seq} -> master=${masterTaskId} workspace=${CONFIG.targetWorkspace}`,
      );
    }
  }

  saveState(state);
  return { activeMasters, dispatched };
}

function parseArg(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}

async function cmdBackfill() {
  CONFIG.groupBy = normalizeGroupBy(parseArg('--group-by', CONFIG.groupBy));
  const state = loadState();
  const limit = Number(parseArg('--limit', String(CONFIG.backfillLimit))) || CONFIG.backfillLimit;
  const summary = await backfillMasterTasks(state, { limit });
  logLine(
    `backfill done threads=${summary.threads} created=${summary.created} linked=${summary.linked} state=${CONFIG.stateFile}`,
  );
}

async function cmdRun() {
  CONFIG.groupBy = normalizeGroupBy(parseArg('--group-by', CONFIG.groupBy));
  const once = process.argv.includes('--once');
  const autoBackfill = !process.argv.includes('--no-backfill');

  while (true) {
    const state = loadState();
    if (autoBackfill) {
      await backfillMasterTasks(state, { limit: CONFIG.backfillLimit });
    }
    const result = await trackAndDispatchOnce(state);
    logLine(
      `tick workspace=${CONFIG.targetWorkspace} active_masters=${result.activeMasters} dispatched=${result.dispatched}`,
    );
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollSeconds * 1000));
  }
}

async function main() {
  ensureInputs();
  const cmd = (process.argv[2] || 'help').trim().toLowerCase();
  if (cmd === 'backfill') {
    await cmdBackfill();
    return;
  }
  if (cmd === 'run') {
    await cmdRun();
    return;
  }
  process.stdout.write(
    [
      'Usage:',
      '  node scripts/codexcp-thread-dispatcher.mjs backfill [--limit 200] [--group-by workspace]',
      '  node scripts/codexcp-thread-dispatcher.mjs run [--once] [--no-backfill] [--group-by workspace]',
      '',
      'Behavior:',
      '- Backfill maps codex threads to codexcp supervisor master tasks.',
      '- New masters are initialized to waiting_approval (paused).',
      '- Run loop watches master tasks in queued/claimed/running.',
      '- For active masters, each new user.message in source thread becomes a child supervisor task.',
      '',
      `State file: ${CONFIG.stateFile}`,
    ].join('\n') + '\n',
  );
}

main().catch((err) => {
  fail(String(err?.stack || err), 2);
});
